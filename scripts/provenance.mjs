// Did a commit reach the protected branch through a merged pull request?
// Stopgap for missing branch protection on GitHub Free private repos (docs/status).

/** True when one of the commit's associated PRs was merged into `base`. */
export function cameThroughMergedPr(pulls, base = "main") {
  return Array.isArray(pulls) && pulls.some((p) => Boolean(p?.merged_at) && p?.base?.ref === base);
}

/**
 * Evaluates a push. `forced` pushes always violate; otherwise every commit
 * must have come through a merged PR. Returns { ok, violations: [{ sha, reason }] }.
 */
export function evaluatePush({ forced, commits, base = "main" }) {
  const violations = [];
  if (forced) violations.push({ sha: "(push)", reason: "force-push to protected branch" });
  for (const { sha, pulls } of commits) {
    if (!cameThroughMergedPr(pulls, base)) violations.push({ sha, reason: "not part of a merged pull request" });
  }
  return { ok: violations.length === 0, violations };
}
