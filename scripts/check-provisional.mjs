#!/usr/bin/env node
// CI: a PR built on an unanswered question cannot merge (docs/COORDINATION.md §6).
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER.
// The PR's body and labels are read from the API at run time, never from the event payload,
// so a re-run judges the PR as it is now (#89). Any API failure fails the check (fails closed).
import { evaluateProvisional, parseProvisionalRefs, pullRequestState } from "./provisional.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = process.env;

async function api(path) {
  return fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
}

if (!/^[1-9]\d*$/.test(PR_NUMBER ?? "")) {
  console.error(`PR_NUMBER is missing or invalid (${JSON.stringify(PR_NUMBER)}); failing closed.`);
  process.exit(1);
}
const pr = await api(`/pulls/${PR_NUMBER}`);
if (!pr.ok) { console.error(`GitHub API pull #${PR_NUMBER} -> ${pr.status}; failing closed.`); process.exit(1); }
const { body, labels } = pullRequestState(await pr.json());

const issues = {};
for (const n of parseProvisionalRefs(body)) {
  const r = await api(`/issues/${n}`);
  if (r.status === 404) { issues[n] = null; continue; }
  if (!r.ok) { console.error(`GitHub API issue #${n} -> ${r.status}; failing closed.`); process.exit(1); }
  const i = await r.json();
  issues[n] = { state: i.state, labels: i.labels.map((l) => l.name) };
}
const result = evaluateProvisional({ labels, body, issues });
if (result.ok) console.log("Provisional check passed.");
else { console.error("Provisional check failed:\n" + result.problems.map((p) => `- ${p}`).join("\n")); process.exit(1); }
