#!/usr/bin/env node
// CI: a PR built on an unanswered question cannot merge (docs/COORDINATION.md §6).
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_BODY, PR_LABELS (JSON array).
import { evaluateProvisional, parseProvisionalRefs } from "./provisional.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
const body = process.env.PR_BODY ?? "";
const labels = JSON.parse(process.env.PR_LABELS || "[]");

const issues = {};
for (const n of parseProvisionalRefs(body)) {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${n}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) { issues[n] = null; continue; }
  if (!r.ok) { console.error(`GitHub API issue #${n} -> ${r.status}; failing closed.`); process.exit(1); }
  const i = await r.json();
  issues[n] = { state: i.state, labels: i.labels.map((l) => l.name) };
}
const result = evaluateProvisional({ labels, body, issues });
if (result.ok) console.log("Provisional check passed.");
else { console.error("Provisional check failed:\n" + result.problems.map((p) => `- ${p}`).join("\n")); process.exit(1); }
