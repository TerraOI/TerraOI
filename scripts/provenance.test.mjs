import { describe, expect, it } from "vitest";
import { attributeStacked, evaluate, isReviewed, mergedInto } from "./provenance.mjs";

const pr = { number: 7, merged_at: "2026-11-05T00:00:00Z", base: { ref: "main" }, user: { login: "alice" }, head: { sha: "h2" } };
const approve = (login, commit_id = "h2") => ({ user: { login }, state: "APPROVED", commit_id });

describe("mergedInto", () => {
  it("keeps only PRs merged into main", () => {
    expect(mergedInto([pr, { ...pr, merged_at: null }, { ...pr, base: { ref: "dev" } }])).toEqual([pr]);
  });
});

describe("isReviewed", () => {
  it("accepts a non-author approval of the final commit", () => expect(isReviewed(pr, [approve("bob")])).toBe(true));
  it("rejects self-approval", () => expect(isReviewed(pr, [approve("alice")])).toBe(false));
  it("rejects a stale approval of an earlier commit", () => expect(isReviewed(pr, [approve("bob", "h1")])).toBe(false));
  it("uses the reviewer's latest decision", () =>
    expect(isReviewed(pr, [approve("bob"), { user: { login: "bob" }, state: "CHANGES_REQUESTED", commit_id: "h2" }])).toBe(false));
  it("ignores comments when finding the latest decision", () =>
    expect(isReviewed(pr, [approve("bob"), { user: { login: "bob" }, state: "COMMENTED", commit_id: "h2" }])).toBe(true));
  it("exempts PRs authored by a supervisor", () => expect(isReviewed(pr, [], ["alice"])).toBe(true));
});

describe("evaluate", () => {
  const ok = { sha: "a", pulls: [pr] };
  it("passes reviewed, merged commits", () =>
    expect(evaluate({ commits: [ok], reviewsByPr: { 7: [approve("bob")] } }).ok).toBe(true));
  it("flags a direct commit", () =>
    expect(evaluate({ commits: [{ sha: "b", pulls: [] }] }).violations[0].sha).toBe("b"));
  it("flags merged-but-unreviewed", () => expect(evaluate({ commits: [ok], reviewsByPr: {} }).ok).toBe(false));
  it("always flags a force-push", () =>
    expect(evaluate({ forced: true, commits: [ok], reviewsByPr: { 7: [approve("bob")] } }).ok).toBe(false));
  it("fails closed when the range is unknown", () =>
    expect(evaluate({ rangeProblem: "compare API 404" }).ok).toBe(false));
  it("blocks while a policy-violation issue is open", () =>
    expect(evaluate({ openViolations: [3], commits: [ok], reviewsByPr: { 7: [approve("bob")] } }).ok).toBe(false));
});

describe("attributeStacked", () => {
  // #29: commits first merged by #23 into a feature branch, then brought to main by #26.
  const stacked = { number: 23, merged_at: "2026-11-05T00:00:00Z", base: { ref: "feat/x" }, user: { login: "alice" }, head: { sha: "s1" } };
  const carrier = { number: 26, merged_at: "2026-11-05T01:00:00Z", base: { ref: "main" }, user: { login: "alice" }, head: { sha: "m1" } };
  const commits = [{ sha: "s1", pulls: [stacked] }, { sha: "m1", pulls: [carrier] }];

  it("credits an orphan commit to a main-merged PR in the range that lists it", () => {
    const out = attributeStacked(commits, { 26: ["s1", "m1"] });
    expect(mergedInto(out[0].pulls).map((p) => p.number)).toEqual([26]);
    expect(evaluate({ commits: out, reviewsByPr: { 26: [approve("bob", "m1")] } }).ok).toBe(true);
  });
  it("still flags an orphan that no main-merged PR lists (a direct push)", () => {
    const out = attributeStacked([{ sha: "d1", pulls: [] }, commits[1]], { 26: ["m1"] });
    expect(evaluate({ commits: out, reviewsByPr: { 26: [approve("bob", "m1")] } }).violations.map((v) => v.sha)).toEqual(["d1"]);
  });
  it("keeps the review rule: the carrier PR itself must be approved", () => {
    const out = attributeStacked(commits, { 26: ["s1", "m1"] });
    expect(evaluate({ commits: out, reviewsByPr: { 26: [] } }).ok).toBe(false);
  });
  it("leaves commits that already have a main-merged PR untouched", () => {
    expect(attributeStacked(commits, { 26: ["s1", "m1"] })[1]).toBe(commits[1]);
  });
});
