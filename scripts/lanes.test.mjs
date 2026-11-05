import { describe, expect, it } from "vitest";
import { checkLanes, laneOf } from "./lanes.mjs";

describe("laneOf", () => {
  it("maps owned paths to their lane and shared paths to null", () => {
    expect(laneOf("src/platform/tenancy/host.ts")).toBe("lane-1-platform-experience");
    expect(laneOf("src/platform/gateway/chain.ts")).toBe("lane-2-knowledge-intelligence");
    expect(laneOf("supabase/migrations/0001_core.sql")).toBeNull();
    expect(laneOf("src/contracts/answer.ts")).toBeNull();
  });

  it("gives Lane 2 its HTTP route folders inside Lane 1's src/app/ (#11)", () => {
    expect(laneOf("src/app/api/jobs/route.ts")).toBe("lane-2-knowledge-intelligence");
    expect(laneOf("src/app/api/jobs/[id]/lease/route.ts")).toBe("lane-2-knowledge-intelligence");
    expect(laneOf("src/app/api/knowledge/review/route.ts")).toBe("lane-2-knowledge-intelligence");
  });

  it("keeps the rest of src/app/ in Lane 1, matching whole folder names only", () => {
    expect(laneOf("src/app/api/chat/route.ts")).toBe("lane-1-platform-experience");
    expect(laneOf("src/app/api/jobs-status/route.ts")).toBe("lane-1-platform-experience");
    expect(laneOf("src/app/(tenant)/knowledge/page.tsx")).toBe("lane-1-platform-experience");
  });
});

describe("checkLanes", () => {
  it("passes a single-lane PR with shared files", () => {
    expect(checkLanes(["src/app/page.tsx", "src/contracts/x.ts"]).ok).toBe(true);
  });
  it("fails a PR touching both lanes without the label", () => {
    const r = checkLanes(["src/app/page.tsx", "workers/ingest.ts"]);
    expect(r.ok).toBe(false);
    expect(r.lanes).toHaveLength(2);
  });
  it("passes a two-lane PR that carries the cross-lane label", () => {
    expect(checkLanes(["src/app/page.tsx", "workers/ingest.ts"], ["cross-lane"]).ok).toBe(true);
  });
});
