#!/usr/bin/env node
// CI: verify commits on main arrived through merged, reviewed PRs (stopgap for branch protection).
// Fails closed: any API error or unverifiable range is a violation.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, BASE_BRANCH (default main), SUPERVISOR_LOGINS (comma list),
//      BEFORE + AFTER (push range) or SHAS (space-separated), FORCED ("true"),
//      CHECK_OPEN_VIOLATIONS ("true": also fail while policy-violation issues are open).
// Writes `violations` (markdown list) to $GITHUB_OUTPUT; exits 1 on any violation.
import { appendFileSync } from "node:fs";
import { attributeStacked, evaluate, mergedInto } from "./provenance.mjs";

const env = process.env;
const base = env.BASE_BRANCH || "main";
const supervisors = (env.SUPERVISOR_LOGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_COMPARE = 250; // compare API returns at most this many commits

async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`GitHub API ${path} -> ${r.status}`);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveRange() {
  if (env.SHAS) return { shas: env.SHAS.split(/\s+/).filter(Boolean), rangeProblem: null };
  if (!env.AFTER) return { shas: [], rangeProblem: "no commit range given" };
  if (!env.BEFORE || /^0+$/.test(env.BEFORE)) return { shas: [env.AFTER], rangeProblem: "branch created (no previous commit to compare)" };
  try {
    const cmp = await api(`/compare/${env.BEFORE}...${env.AFTER}`);
    const shas = cmp.commits.map((c) => c.sha);
    if (cmp.total_commits > shas.length || shas.length >= MAX_COMPARE) {
      return { shas, rangeProblem: `range has ${cmp.total_commits} commits; only ${shas.length} verifiable` };
    }
    return { shas, rangeProblem: null };
  } catch (e) {
    return { shas: [env.AFTER], rangeProblem: e.message };
  }
}

async function pullsFor(sha) {
  // PR association can lag a few seconds right after a merge; retry before judging.
  let pulls = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    pulls = await api(`/commits/${sha}/pulls`);
    if (mergedInto(pulls, base).length > 0) return pulls;
    // Already tied to a PR merged elsewhere (a stacked PR): waiting won't change that.
    if (pulls.some((p) => p.merged_at)) return pulls;
    await sleep(5000);
  }
  return pulls;
}

let result;
try {
  const { shas, rangeProblem } = await resolveRange();
  const commits = [];
  const reviewsByPr = {};
  for (const sha of shas) {
    const pulls = await pullsFor(sha);
    commits.push({ sha, pulls });
    for (const p of pulls) {
      if (p.merged_at && !(p.number in reviewsByPr)) reviewsByPr[p.number] = await api(`/pulls/${p.number}/reviews?per_page=100`);
    }
  }
  // Stacked PRs: credit orphans to a main-merged PR in this range that lists them. Only the
  // first 100 commits of a PR are read; an orphan beyond that stays a violation (fails closed).
  const prCommits = {};
  if (commits.some((c) => mergedInto(c.pulls, base).length === 0)) {
    for (const { pulls } of commits) {
      for (const p of mergedInto(pulls, base)) {
        if (p.number in prCommits) continue;
        const list = await api(`/pulls/${p.number}/commits?per_page=100`);
        prCommits[p.number] = list.map((c) => c.sha);
      }
    }
  }
  const attributed = attributeStacked(commits, prCommits, base);
  let openViolations = [];
  if (env.CHECK_OPEN_VIOLATIONS === "true") {
    const issues = await api(`/issues?labels=policy-violation&state=open&per_page=100`);
    openViolations = issues.filter((i) => !i.pull_request).map((i) => i.number);
  }
  result = evaluate({ forced: env.FORCED === "true", rangeProblem, openViolations, commits: attributed, reviewsByPr, supervisors, base });
} catch (e) {
  result = { ok: false, violations: [{ sha: "(check)", reason: `provenance check failed closed: ${e.message}` }] };
}

const list = result.violations.map((v) => `- \`${v.sha}\`: ${v.reason}`).join("\n");
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `violations<<EOF\n${list}\nEOF\n`);
if (result.ok) {
  console.log(`Provenance OK on ${base}: every checked commit came through a merged, reviewed PR.`);
} else {
  console.error(`Provenance violations on ${base}:\n${list}`);
  process.exit(1);
}
