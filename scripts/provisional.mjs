// Provisional PRs (docs/COORDINATION.md §6): work may proceed on an assumption from an
// open question, but the PR cannot merge until every question it depends on is answered.

/** Issue numbers from a "Provisional on: #12, #15" line in the PR body ("none" → []). */
export function parseProvisionalRefs(body = "") {
  const line = /^\s*Provisional on:\s*(.*)$/im.exec(body ?? "")?.[1] ?? "";
  return [...new Set([...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
}

/**
 * labels: PR label names. body: PR body. issues: { [n]: { state, labels: string[] } | null }.
 * Returns { ok, problems: string[] }.
 */
export function evaluateProvisional({ labels = [], body = "", issues = {} }) {
  const problems = [];
  const refs = parseProvisionalRefs(body);
  if (labels.includes("provisional") && refs.length === 0) {
    problems.push("PR is labeled `provisional` but has no `Provisional on: #<issue>` line in its description");
  }
  for (const n of refs) {
    const issue = issues[n];
    if (!issue) problems.push(`#${n}: not found (Provisional on must reference a question issue)`);
    else if (issue.state === "open") problems.push(`#${n}: question still open; this PR cannot merge until it is answered`);
    else if (!issue.labels.includes("answered")) problems.push(`#${n}: closed without an \`answered\` label; ask the supervisor to answer it`);
  }
  return { ok: problems.length === 0, problems };
}
