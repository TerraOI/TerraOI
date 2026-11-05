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

/** Returns the lane key owning a path, or null for shared paths. */
export function laneOf(path) {
  for (const [lane, prefixes] of Object.entries(LANES)) {
    if (prefixes.some((p) => path.startsWith(p))) return lane;
  }
  return null;
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
