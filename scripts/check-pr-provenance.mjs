#!/usr/bin/env node
// CI: verify commits on main arrived through merged PRs (stopgap for branch protection).
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, BASE_BRANCH (default main),
//      SHAS (space-separated, optional) or BEFORE + AFTER (push range), FORCED ("true"/"false").
// Writes `violations` (markdown list) to $GITHUB_OUTPUT; exits 1 on any violation.
import { appendFileSync } from "node:fs";
import { evaluatePush } from "./provenance.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT } = process.env;
const base = process.env.BASE_BRANCH || "main";
const api = (path) =>
  fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`GitHub API ${path} -> ${r.status}`);
    return r.json();
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shasToCheck() {
  if (process.env.SHAS) return process.env.SHAS.split(/\s+/).filter(Boolean);
  const { BEFORE, AFTER } = process.env;
  if (!BEFORE || /^0+$/.test(BEFORE)) return [AFTER];
  try {
    const cmp = await api(`/compare/${BEFORE}...${AFTER}`);
    return cmp.commits.map((c) => c.sha);
  } catch {
    return [AFTER]; // e.g. history rewritten by a force-push; FORCED flags it anyway
  }
}

async function pullsFor(sha) {
  // PR association can lag a few seconds right after a merge; retry before judging.
  for (let attempt = 0; attempt < 4; attempt++) {
    const pulls = await api(`/commits/${sha}/pulls`);
    if (pulls.some((p) => p.merged_at && p.base?.ref === base)) return pulls;
    await sleep(5000);
  }
  return api(`/commits/${sha}/pulls`);
}

const shas = await shasToCheck();
const commits = [];
for (const sha of shas) commits.push({ sha, pulls: await pullsFor(sha) });
const result = evaluatePush({ forced: process.env.FORCED === "true", commits, base });

const list = result.violations.map((v) => `- \`${v.sha}\`: ${v.reason}`).join("\n");
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `violations<<EOF\n${list}\nEOF\n`);
if (result.ok) {
  console.log(`Provenance OK: ${shas.length} commit(s) on ${base} came through merged PRs.`);
} else {
  console.error(`Provenance violations on ${base}:\n${list}`);
  process.exit(1);
}
