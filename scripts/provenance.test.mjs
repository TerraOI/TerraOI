import { describe, expect, it } from "vitest";
import { cameThroughMergedPr, evaluatePush } from "./provenance.mjs";

const merged = { merged_at: "2026-11-05T00:00:00Z", base: { ref: "main" } };

describe("cameThroughMergedPr", () => {
  it("accepts a PR merged into main", () => expect(cameThroughMergedPr([merged])).toBe(true));
  it("rejects a commit with no PR", () => expect(cameThroughMergedPr([])).toBe(false));
  it("rejects an open (unmerged) PR", () =>
    expect(cameThroughMergedPr([{ merged_at: null, base: { ref: "main" } }])).toBe(false));
  it("rejects a PR merged into another branch", () =>
    expect(cameThroughMergedPr([{ ...merged, base: { ref: "feature-x" } }])).toBe(false));
});

describe("evaluatePush", () => {
  it("passes when every commit came through a merged PR", () => {
    expect(evaluatePush({ forced: false, commits: [{ sha: "a", pulls: [merged] }] }).ok).toBe(true);
  });
  it("flags a direct commit", () => {
    const r = evaluatePush({ forced: false, commits: [{ sha: "a", pulls: [merged] }, { sha: "b", pulls: [] }] });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.sha)).toEqual(["b"]);
  });
  it("always flags a force-push, even of reviewed commits", () => {
    expect(evaluatePush({ forced: true, commits: [{ sha: "a", pulls: [merged] }] }).ok).toBe(false);
  });
});
