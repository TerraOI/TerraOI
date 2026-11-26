// Did changes reach the protected branch through a merged AND reviewed pull request?
// Stopgap for missing branch protection on GitHub Free private repos (docs/status).
// Pure functions only; all GitHub API access lives in check-pr-provenance.mjs.

/** PRs among `pulls` that were merged into `base`. */
export function mergedInto(pulls, base = "main") {
  return (Array.isArray(pulls) ? pulls : []).filter((p) => Boolean(p?.merged_at) && p?.base?.ref === base);
}

/**
 * The protected-path list, read from `.github/CODEOWNERS` (the one source of truth, #63).
 * Returns path prefixes without the leading slash: "dir/" for a folder, "FILE" for a file.
 * TerraOI's CODEOWNERS uses only anchored literal paths; a glob, an unanchored pattern or an
 * empty file throws, so the guard fails closed instead of silently protecting less.
 */
export function parseCodeowners(text) {
  const patterns = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [pattern] = line.split(/\s+/);
    if (!pattern.startsWith("/") || /[*?[\]!\\]/.test(pattern) || pattern === "/") {
      throw new Error(`CODEOWNERS pattern ${JSON.stringify(pattern)} is not an anchored literal path`);
    }
    patterns.push(pattern.slice(1));
  }
  if (patterns.length === 0) throw new Error("CODEOWNERS lists no protected paths");
  return patterns;
}

/**
 * Paths that stay protected whatever any CODEOWNERS copy says: the list itself, the workflows,
 * and the guard's own code. Without this floor, a PR approved by a non-supervisor could remove
 * a line from CODEOWNERS, or weaken the guard, and the next run would trust the result.
 */
export const GUARD_FLOOR = [".github/", "scripts/provenance.mjs", "scripts/check-pr-provenance.mjs"];

/**
 * The protected list the guard enforces: the floor, plus every CODEOWNERS copy it was given
 * (the trusted pre-push copy and the pushed one), so a removal never narrows it.
 */
export function protectedPatternsFrom(codeownersTexts) {
  const texts = Array.isArray(codeownersTexts) ? codeownersTexts : [];
  if (texts.length === 0) throw new Error("no CODEOWNERS copy to read");
  return [...new Set([...GUARD_FLOOR, ...texts.flatMap((t) => parseCodeowners(t))])];
}

/** Does any changed file fall under a protected pattern from parseCodeowners? */
export function touchesProtected(files, patterns) {
  return (Array.isArray(files) ? files : []).some((f) =>
    patterns.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p || f.startsWith(`${p}/`))),
  );
}

/**
 * Docs-only (#302): every changed path is under `docs/` or is a root-level `*.md` file
 * (AGENTS.md, CLAUDE.md, README.md). A missing or empty file list is not docs-only, so the
 * supervisor exemption fails closed. `.github/` and the guard's own files are never docs.
 */
export function isDocsOnly(files) {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => typeof f === "string" && (f.startsWith("docs/") || (!f.includes("/") && f.endsWith(".md"))))
  );
}

/**
 * A merged PR counts as reviewed when someone other than its author has, as their latest
 * review, APPROVED the PR's final head commit (stale approvals do not count).
 * When the PR touches a protected path (`needsSupervisor`), that approval must also come from
 * a supervisor login (#63); another reviewer's approval alone never carries a protected change.
 * A supervisor-authored PR (#302): exempt only when every changed file is docs (`isDocsOnly`);
 * otherwise it needs one non-author approval like any other PR, and on a protected path the
 * supervisor's authorship is the supervisor side, so a builder's approval carries it. Agents
 * write code under the supervisor login, and no login may be the second reviewer of its own PR.
 */
export function isReviewed(pr, reviews, supervisors = [], needsSupervisor = false, files = undefined) {
  const author = pr?.user?.login;
  const authorIsSupervisor = Boolean(author) && supervisors.includes(author);
  if (authorIsSupervisor && isDocsOnly(files)) return true;
  const latest = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const who = r?.user?.login;
    if (!who || who === author || r.state === "COMMENTED") continue;
    latest.set(who, r); // API returns reviews oldest first
  }
  return [...latest.entries()].some(
    ([who, r]) =>
      r.state === "APPROVED" &&
      r.commit_id === pr?.head?.sha &&
      (!needsSupervisor || authorIsSupervisor || supervisors.includes(who)),
  );
}

/**
 * GitHub's /commits/{sha}/pulls lists the PR that first carried a commit. A commit from a stacked
 * PR (merged into a feature branch, then brought to main by a later PR) therefore shows no PR
 * merged into main. Credit such an orphan to a main-merged PR from the same range whose own
 * commit list (`prCommits`: { [number]: sha[] }) contains it. A direct push has no such PR and
 * stays a violation; the carrier PR still has to pass isReviewed.
 */
export function attributeStacked(commits, prCommits, base = "main") {
  const carriers = new Map();
  for (const { pulls } of commits) for (const p of mergedInto(pulls, base)) carriers.set(p.number, p);
  return commits.map((c) => {
    if (mergedInto(c.pulls, base).length > 0) return c;
    const extra = [...carriers.values()].filter((p) => (prCommits?.[p.number] ?? []).includes(c.sha));
    return extra.length > 0 ? { ...c, pulls: [...(c.pulls ?? []), ...extra] } : c;
  });
}

/**
 * Evaluates a set of commits. Inputs:
 *  - forced: push was a force-push
 *  - rangeProblem: string when the commit range could not be fully determined (fail closed)
 *  - openViolations: open policy-violation issue numbers (deploys stay blocked until resolved)
 *  - commits: [{ sha, pulls }]; reviewsByPr: { [number]: reviews[] }; supervisors: logins
 *  - protectedPatterns: from parseCodeowners; filesByPr: { [number]: changed paths[] }. A PR
 *    whose file list is missing is treated as touching a protected path (fails closed).
 * Returns { ok, violations: [{ sha, reason }] }.
 */
export function evaluate({ forced = false, rangeProblem = null, openViolations = [], commits = [], reviewsByPr = {}, supervisors = [], base = "main", protectedPatterns = [], filesByPr = {} }) {
  const isProtected = (pr) =>
    protectedPatterns.length > 0 && (!Array.isArray(filesByPr[pr.number]) || touchesProtected(filesByPr[pr.number], protectedPatterns));
  const violations = [];
  if (forced) violations.push({ sha: "(push)", reason: "force-push to protected branch" });
  if (rangeProblem) violations.push({ sha: "(range)", reason: `could not verify full commit range: ${rangeProblem}` });
  for (const n of openViolations) violations.push({ sha: `(issue #${n})`, reason: "unresolved policy-violation issue" });
  for (const { sha, pulls } of commits) {
    const merged = mergedInto(pulls, base);
    if (merged.length === 0) {
      violations.push({ sha, reason: "not part of a merged pull request" });
    } else if (!merged.some((pr) => isReviewed(pr, reviewsByPr[pr.number], supervisors, false, filesByPr[pr.number]))) {
      violations.push({ sha, reason: `merged PR #${merged[0].number} has no approval from a non-author on its final commit` });
    } else if (!merged.some((pr) => isReviewed(pr, reviewsByPr[pr.number], supervisors, isProtected(pr), filesByPr[pr.number]))) {
      violations.push({ sha, reason: `protected path merged without a supervisor approval (PR #${merged[0].number}; .github/CODEOWNERS, #63)` });
    }
  }
  return { ok: violations.length === 0, violations };
}
