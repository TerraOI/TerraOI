// Provisional PRs (docs/COORDINATION.md §6): work may proceed on an assumption from an
// open question, but the PR cannot merge until every question it depends on is answered.
//
// Two failure modes this parser used to have, both paid for (issue #89):
//
// 1. Greedy. A transparent author line - `Provisional on: none. The ADR states at the top that it
//    is proposed and blocked on #62, #65, #55 (and #67 for locale)` - registered four hard
//    dependencies and failed a PR that assumes nothing.
// 2. Blind. A directive wrapped in markdown emphasis - `**Provisional on: #37**` - did not match
//    the anchored pattern at all, so a PR that *meant* to be blocked passed the gate silently.
//
// Both are now explicit: a line that starts (after emphasis and list markers) with the directive is
// parsed strictly, and anything the strict grammar rejects becomes a named problem instead of a
// wrong answer. Prose *about* the directive, mid-sentence, is not a directive and is left alone -
// otherwise every PR body that explains the gate would have to dodge its own explanation.

const DIRECTIVE = /^provisional\s+on:/i;

/** Strip the comment the PR template ships, list markers, and markdown emphasis at the line edges. */
function normalizeLine(line) {
  return line
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*(?:[-*>+]\s+)*/, "")
    .replace(/^[*_`~]+/, "")
    .trimEnd();
}

function shorten(line) {
  return line.length > 100 ? `${line.slice(0, 100)}...` : line;
}

/**
 * Read every directive line. Returns `{ refs, problems }`: refs from the lines that parse, and a
 * problem string for each line that looks like a directive but cannot be read confidently.
 */
export function readProvisionalLines(body = "") {
  const refs = [];
  const problems = [];
  for (const raw of String(body ?? "").split("\n")) {
    const line = normalizeLine(raw);
    const match = DIRECTIVE.exec(line);
    if (match === null) continue;
    let remainder = line.slice(match[0].length).replace(/^[*\s]+/, "").replace(/[*`_~\s]+$/, "");
    if (remainder === "") {
      problems.push(`malformed "Provisional on:" line: it names nothing. Write "Provisional on: none" or "Provisional on: #12, #15" (${shorten(line)})`);
      continue;
    }
    if (/^none\b/i.test(remainder)) {
      const trailing = remainder.replace(/^none\b/i, "").trim();
      if (trailing !== "") {
        problems.push(`malformed "Provisional on:" line: keep "none" alone on the line and move the explanation to the next line, or the prose gets parsed as dependencies (${shorten(line)})`);
      }
      continue;
    }
    const tokens = remainder.split(/(?:,|;|\band\b|&|\+|\s)+/i).filter(Boolean);
    const unreadable = tokens.filter((token) => !/^#\d+$/.test(token));
    if (unreadable.length > 0) {
      problems.push(`malformed "Provisional on:" line: list issue numbers only (#12, #15), or write "none" and put prose on the next line (${shorten(line)})`);
      continue;
    }
    for (const token of tokens) refs.push(Number(token.slice(1)));
  }
  return { refs: [...new Set(refs)], problems };
}

/** Issue numbers from the `Provisional on:` line in the PR body ("none" -> []). */
export function parseProvisionalRefs(body = "") {
  return readProvisionalLines(body).refs;
}

/** Directive lines that could not be read confidently, as human-safe problem strings. */
export function findProvisionalLineProblems(body = "") {
  return readProvisionalLines(body).problems;
}

/**
 * labels: PR label names. body: PR body. issues: { [n]: { state, labels: string[] } | null }.
 * Returns { ok, problems: string[] }.
 */
export function evaluateProvisional({ labels = [], body = "", issues = {} }) {
  const parsed = readProvisionalLines(body);
  const problems = [...parsed.problems];
  const refs = parsed.refs;
  if (labels.includes("provisional") && refs.length === 0 && problems.length === 0) {
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
