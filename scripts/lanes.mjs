// Lane ownership from plan §20.2. Paths not listed here are shared (no lane).
export const LANES = {
  "lane-1-platform-experience": [
    "src/app/",
    "src/components/",
    "src/platform/tenancy/",
    "src/platform/identity/",
    "src/platform/branding/",
    "src/platform/chat/",
    "src/platform/forms/",
    "src/platform/notifications/",
  ],
  "lane-2-knowledge-intelligence": [
    // HTTP surfaces whose handler, auth boundary and tests belong to Lane 2 (#11, FAQ-0005).
    // They sit inside Lane 1's src/app/, so laneOf() must pick the longest matching prefix.
    "src/app/api/jobs/",
    "src/app/api/knowledge/",
    "src/platform/knowledge/",
    "src/platform/retrieval/",
    "src/platform/agents/",
    "src/platform/gateway/",
    "src/platform/evals/",
    "src/platform/budgets/",
    "src/platform/audit/",
    "workers/",
    "localbox/",
    "evals/",
  ],
};

export const CROSS_LANE_LABEL = "cross-lane";

/**
 * Returns the lane key owning a path, or null for shared paths.
 * The longest matching prefix wins, so a narrower folder can belong to the other lane
 * (e.g. src/app/api/jobs/ is Lane 2 inside Lane 1's src/app/), whatever the order above.
 */
export function laneOf(path) {
  let owner = null;
  let longest = 0;
  for (const [lane, prefixes] of Object.entries(LANES)) {
    for (const p of prefixes) {
      if (p.length > longest && path.startsWith(p)) {
        owner = lane;
        longest = p.length;
      }
    }
  }
  return owner;
}

/**
 * A PR may touch one lane plus shared paths. Touching both lanes needs the cross-lane label.
 * Returns { ok, lanes, message }.
 */
export function checkLanes(changedPaths, labels = []) {
  const lanes = [...new Set(changedPaths.map(laneOf).filter(Boolean))].sort();
  if (lanes.length <= 1) return { ok: true, lanes, message: `Lane check passed (${lanes[0] ?? "shared only"}).` };
  if (labels.includes(CROSS_LANE_LABEL)) {
    return { ok: true, lanes, message: `Touches ${lanes.join(" + ")}; allowed by '${CROSS_LANE_LABEL}' label.` };
  }
  return {
    ok: false,
    lanes,
    message: `This PR touches ${lanes.join(" + ")}. Split it, or add the '${CROSS_LANE_LABEL}' label and explain why in the PR (plan §20.1).`,
  };
}
