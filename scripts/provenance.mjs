// Did changes reach the protected branch through a merged AND reviewed pull request?
// Stopgap for missing branch protection on GitHub Free private repos (docs/status).
// Pure functions only; all GitHub API access lives in check-pr-provenance.mjs.

/** PRs among `pulls` that were merged into `base`. */
export function mergedInto(pulls, base = "main") {
  return (Array.isArray(pulls) ? pulls : []).filter((p) => Boolean(p?.merged_at) && p?.base?.ref === base);
}

/**
 * A merged PR counts as reviewed when someone other than its author has, as their latest
 * review, APPROVED the PR's final head commit (stale approvals do not count). PRs authored
 * by a supervisor login are exempt: the supervisor is the reviewer of record (plan §20.1).
 */
export function isReviewed(pr, reviews, supervisors = []) {
  const author = pr?.user?.login;
  if (author && supervisors.includes(author)) return true;
  const latest = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const who = r?.user?.login;
    if (!who || who === author || r.state === "COMMENTED") continue;
    latest.set(who, r); // API returns reviews oldest first
  }
  return [...latest.values()].some((r) => r.state === "APPROVED" && r.commit_id === pr?.head?.sha);
}

/**
 * Evaluates a set of commits. Inputs:
 *  - forced: push was a force-push
 *  - rangeProblem: string when the commit range could not be fully determined (fail closed)
 *  - openViolations: open policy-violation issue numbers (deploys stay blocked until resolved)
 *  - commits: [{ sha, pulls }]; reviewsByPr: { [number]: reviews[] }; supervisors: logins
 * Returns { ok, violations: [{ sha, reason }] }.
 */
export function evaluate({ forced = false, rangeProblem = null, openViolations = [], commits = [], reviewsByPr = {}, supervisors = [], base = "main" }) {
  const violations = [];
  if (forced) violations.push({ sha: "(push)", reason: "force-push to protected branch" });
  if (rangeProblem) violations.push({ sha: "(range)", reason: `could not verify full commit range: ${rangeProblem}` });
  for (const n of openViolations) violations.push({ sha: `(issue #${n})`, reason: "unresolved policy-violation issue" });
  for (const { sha, pulls } of commits) {
    const merged = mergedInto(pulls, base);
    if (merged.length === 0) {
      violations.push({ sha, reason: "not part of a merged pull request" });
    } else if (!merged.some((pr) => isReviewed(pr, reviewsByPr[pr.number], supervisors))) {
      violations.push({ sha, reason: `merged PR #${merged[0].number} has no approval from a non-author on its final commit` });
    }
  }
  return { ok: violations.length === 0, violations };
}
