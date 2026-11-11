import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECALL_K,
  compareLanes,
  gateBaseline,
  parseRecallFixture,
  runRecallHarness,
  scoreLane,
  type RecallCase,
} from "./recall";

/**
 * T-114's Recall@10 harness, unit half (packet: "recall on the synthetic fixture set is measured and
 * printed, plan §8.3"). The fixtures are read from `evals/retrieval/` with `node:fs`, the way
 * `src/platform/gateway/provider-boundary.test.ts` reads the tree — vitest only collects `src/**`, so a
 * `.ts` under `evals/` would be neither typechecked nor run.
 *
 * What these tests hold: the arithmetic, the degraded-lane comparison, and — the part that matters for
 * what goes in a PR body — that a baseline **cannot** be produced from the fixtures themselves.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function rawFixture(): unknown {
  return JSON.parse(readFileSync(`${ROOT}/evals/retrieval/recall-queries.json`, "utf8"));
}

function loadFixture(): { cases: RecallCase[] } {
  return parseRecallFixture(rawFixture());
}

describe("the shipped synthetic fixture set", () => {
  it("parses, is synthetic, and every case can actually be failed", () => {
    const fixture = loadFixture();
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.synthetic).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(fixture.cases.map((item) => item.queryId));
    expect(ids.size).toBe(fixture.cases.length);
    // A case with no expected id scores 0/0 and would silently inflate the mean.
    for (const item of fixture.cases) expect(item.expectedChunkIds.length).toBeGreaterThan(0);
    // §8.3's cross-tenant/project bait has to be in the set, or the harness cannot fail a leak loudly.
    expect(fixture.cases.some((item) => item.forbiddenChunkIds.length > 0)).toBe(true);
  });

  it("refuses a fixture that contradicts itself", () => {
    const raw = rawFixture() as { cases: unknown[] };
    const broken = { ...raw, cases: [{ queryId: "SYNTH-Q90", queryText: "x", expectedChunkIds: ["SYNTH-C1"], forbiddenChunkIds: ["SYNTH-C1"], note: "n" }] };
    expect(() => parseRecallFixture(broken)).toThrow(/both expected and forbidden/);
  });
});

describe("Recall@k arithmetic", () => {
  const cases: RecallCase[] = [
    { queryId: "Q1", queryText: "a", expectedChunkIds: ["C1", "C2"], forbiddenChunkIds: ["B1"], note: "" },
    { queryId: "Q2", queryText: "b", expectedChunkIds: ["C3"], forbiddenChunkIds: [], note: "" },
  ];

  it("counts expected ids inside the cut and ignores the ones outside it", () => {
    const withinTen = Array.from({ length: 9 }, (_, index) => `N${index}`);
    const score = scoreLane(cases, { Q1: ["C1", ...withinTen], Q2: [...withinTen, "C3"] }, "hybrid");
    expect(score.k).toBe(DEFAULT_RECALL_K);
    // Q1: C1 inside the ten, C2 pushed past the cut. Q2: C3 is the tenth row.
    expect(score.cases[0]).toMatchObject({ foundInTopK: 1, recall: 0.5, hit: true });
    expect(score.cases[1]).toMatchObject({ foundInTopK: 1, recall: 1 });
    expect(score.meanRecall).toBeCloseTo(0.75);
    expect(score.hitRate).toBe(1);
  });

  it("a wider k is a different question, and an out-of-range k is refused", () => {
    // Both expected ids sit at rows 14 and 15: outside Recall@10, inside a wider cut. §8.3 asks for 10,
    // and the RPC never returns more than 25, so anything past that is not a question M1 can answer.
    const rows = Array.from({ length: 13 }, (_, index) => `N${index}`).concat(["C1", "C2"]);
    expect(scoreLane(cases, { Q1: rows, Q2: [] }, "hybrid", 15).cases[0].recall).toBe(1);
    expect(scoreLane(cases, { Q1: rows, Q2: [] }, "hybrid", 10).cases[0].recall).toBe(0);
    expect(() => scoreLane(cases, {}, "hybrid", 0)).toThrow(/between 1 and 25/);
    expect(() => scoreLane(cases, {}, "hybrid", 26)).toThrow(/between 1 and 25/);
  });

  it("counts bait without touching recall, and reports a run that never happened as zero", () => {
    const score = scoreLane(cases, { Q1: ["B1", "C1", "C2"] }, "hybrid");
    expect(score.cases[0]).toMatchObject({ recall: 1, forbiddenRetrieved: 1 });
    expect(score.baitReturned).toBe(1);
    // Q2 was never attempted: it must not vanish from the mean.
    expect(score.cases[1]).toMatchObject({ recall: 0, runMissing: true });
    expect(score.missingRuns).toEqual(["Q2"]);
    expect(score.meanRecall).toBeCloseTo(0.5);
  });
});

describe("the degraded-lane comparison", () => {
  const cases: RecallCase[] = [
    { queryId: "Q1", queryText: "a", expectedChunkIds: ["C1"], forbiddenChunkIds: [], note: "" },
    { queryId: "Q2", queryText: "b", expectedChunkIds: ["C2"], forbiddenChunkIds: [], note: "" },
  ];

  it("names the queries the hybrid lane lost to the labelled lane and the ones it earned", () => {
    // Q1: only the hybrid lane finds C1. Q2: only the lexical lane finds C2 — the shape §8.3 worries
    // about, where adding the vector lane costs recall on a case the cheap lane already answered.
    const comparison = compareLanes(
      cases,
      { Q1: ["N1", "N2", "C1"], Q2: ["N1", "N2", "N3"] },
      { Q1: ["N1", "N2", "N3"], Q2: ["N1", "C2"] },
    );
    expect(comparison.hybrid.lane).toBe("hybrid");
    expect(comparison.lexical.lane).toBe("lexical_only");
    expect(comparison.regressions).toEqual(["Q2"]);
    expect(comparison.gains).toEqual(["Q1"]);
    expect(comparison.delta).toBeCloseTo(0);
  });
});

describe("the venue gate: no baseline without a real database", () => {
  it("scores a perfect run over the fixture's own expectations and still refuses to call it a baseline", () => {
    // This is the fabricated-number trap: feeding each case's expected ids back as "retrieved" scores
    // 1.0 and measures nothing about any corpus. The harness prints it and refuses the word baseline.
    const fixture = loadFixture();
    const selfRun = Object.fromEntries(fixture.cases.map((item) => [item.queryId, item.expectedChunkIds]));
    const report = runRecallHarness({
      cases: fixture.cases,
      hybridRun: selfRun,
      lexicalRun: selfRun,
      venue: { kind: "unit-fixture" },
    });
    expect(report.comparison.hybrid.meanRecall).toBe(1);
    expect(report.baseline).toMatchObject({ ok: false, reason: "no_real_database" });
    expect(report.lines[0]).toMatch(/^NOT a baseline/);
    expect(report.lines.join("\n")).toContain("no_real_database");
  });

  it("a real-database venue must name the run it came from", () => {
    expect(gateBaseline({ kind: "real-database", evidence: "" })).toMatchObject({ ok: false, reason: "no_real_database" });
    expect(gateBaseline({ kind: "real-database", evidence: "CI run 1234, database job, head abc1234" }).ok).toBe(true);
    const fixture = loadFixture();
    const report = runRecallHarness({
      cases: fixture.cases,
      hybridRun: {},
      lexicalRun: {},
      venue: { kind: "real-database", evidence: "staging company1 corpus" },
      k: 10,
    });
    expect(report.lines[0]).toContain("baseline — venue: real database");
    // A run with no rows attempted scores zero, loudly, rather than reporting nothing.
    expect(report.comparison.hybrid.meanRecall).toBe(0);
    expect(report.comparison.hybrid.missingRuns).toHaveLength(fixture.cases.length);
  });
});
