import { z } from "zod";

/**
 * T-114's Recall@10 harness, the pure half (plan §8.3 "start from a measured exact-search baseline";
 * the packet's last acceptance line). Nothing here touches a database: a run is a map from query id to
 * the chunk ids the caller actually retrieved, in order, and these functions only score what they are
 * given. That split is what makes the number auditable — and what makes it possible to state, in code,
 * which number has **not** been earned yet.
 *
 * **The honesty rule.** `Recall@10` over fixture expectations is a check on *this scorer*, never a
 * measurement of retrieval quality: scoring a case's expected ids as if they had been retrieved always
 * yields 1.0 and says nothing about a corpus. So the venue is an argument, not a comment
 * (`gateBaseline`), and a caller who does not name a real database gets `no_real_database` back with
 * the report labelled `NOT a baseline`. No number in this repository may be presented as a baseline
 * without one (COORDINATION §6a: evidence is deferred, never invented).
 */

/** §8.3 names Recall@10; the RPC caps one answer at 25 chunks, so k beyond that is not a question M1 asks. */
export const DEFAULT_RECALL_K = 10;
export const MAX_RECALL_K = 25;

export interface RecallCase {
  queryId: string;
  queryText: string;
  /** The chunk ids a correct answer must contain. A case with none is not scored (it cannot be failed). */
  expectedChunkIds: string[];
  /** Bait: ids that must never come back — another project's, another tenant's, a retired version's. */
  forbiddenChunkIds: string[];
  note: string;
}

export interface ParsedFixture {
  schemaVersion: number;
  synthetic: boolean;
  cases: RecallCase[];
}

/** The shape of `evals/retrieval/recall-queries.json`; a fixture that cannot be validated is not scored. */
export function parseRecallFixture(payload: unknown): ParsedFixture {
  const parsed = z
    .strictObject({
      schemaVersion: z.number().int().positive(),
      synthetic: z.literal(true),
      provenance: z.string().min(1).max(500),
      cases: z
        .array(
          z.strictObject({
            queryId: z.string().regex(/^SYNTH-Q[0-9]{2,4}$/),
            queryText: z.string().min(1).max(2000),
            expectedChunkIds: z.array(z.string().min(1).max(128)).min(1),
            forbiddenChunkIds: z.array(z.string().min(1).max(128)).default([]),
            note: z.string().min(1).max(400),
          }),
        )
        .min(1)
        .max(500),
    })
    .parse(payload);
  const seen = new Set<string>();
  for (const item of parsed.cases) {
    if (seen.has(item.queryId)) throw new Error(`recall fixture: duplicate queryId ${item.queryId}`);
    seen.add(item.queryId);
    const overlap = item.expectedChunkIds.filter((id) => item.forbiddenChunkIds.includes(id));
    if (overlap.length > 0) {
      throw new Error(`recall fixture: ${item.queryId} lists ${overlap.join(", ")} as both expected and forbidden`);
    }
  }
  return { schemaVersion: parsed.schemaVersion, synthetic: parsed.synthetic, cases: parsed.cases };
}

export interface CaseScore {
  queryId: string;
  expected: number;
  foundInTopK: number;
  /** |expected ∩ top-k| / |expected| — what Recall@k means, per case. */
  recall: number;
  hit: boolean;
  forbiddenRetrieved: number;
  runMissing: boolean;
}

export interface LaneScore {
  lane: "hybrid" | "lexical_only";
  k: number;
  cases: CaseScore[];
  scoredCases: number;
  /** Mean per-case recall. The Recall@k figure §8.3 asks for. */
  meanRecall: number;
  /** Share of cases with at least one expected id in the top k — the weaker, more forgiving figure. */
  hitRate: number;
  baitReturned: number;
  missingRuns: string[];
}

function resolveK(k: number): number {
  if (!Number.isInteger(k) || k < 1 || k > MAX_RECALL_K) {
    throw new Error(`recall: k must be an integer between 1 and ${MAX_RECALL_K} (the RPC caps one answer at ${MAX_RECALL_K} chunks)`);
  }
  return k;
}

/**
 * Score one lane's run. `retrieved` maps a query id to the chunk ids that came back, in returned order;
 * a query the run never attempted is reported in `missingRuns` and scored as zero, because dropping it
 * from the mean would quietly raise the number.
 */
export function scoreLane(
  cases: readonly RecallCase[],
  retrieved: Readonly<Record<string, readonly string[]>>,
  lane: LaneScore["lane"],
  k: number = DEFAULT_RECALL_K,
): LaneScore {
  const cutoff = resolveK(k);
  const scored: CaseScore[] = [];
  const missing: string[] = [];
  for (const item of cases) {
    const rows = retrieved[item.queryId];
    if (rows === undefined) missing.push(item.queryId);
    const topK = (rows ?? []).slice(0, cutoff);
    const expected = new Set(item.expectedChunkIds);
    const found = topK.filter((id) => expected.has(id)).length;
    const bait = new Set(item.forbiddenChunkIds);
    scored.push({
      queryId: item.queryId,
      expected: expected.size,
      foundInTopK: Math.min(found, expected.size),
      recall: Math.min(found, expected.size) / expected.size,
      hit: found > 0,
      forbiddenRetrieved: topK.filter((id) => bait.has(id)).length,
      runMissing: rows === undefined,
    });
  }
  const total = scored.reduce((sum, score) => sum + score.recall, 0);
  return {
    lane,
    k: cutoff,
    cases: scored,
    scoredCases: scored.length,
    meanRecall: scored.length === 0 ? 0 : total / scored.length,
    hitRate: scored.length === 0 ? 0 : scored.filter((score) => score.hit).length / scored.length,
    baitReturned: scored.reduce((sum, score) => sum + score.forbiddenRetrieved, 0),
    missingRuns: missing,
  };
}

export interface LaneComparison {
  hybrid: LaneScore;
  lexical: LaneScore;
  /** hybrid − lexical. Negative means the vector lane is costing recall on this fixture set (§8.3). */
  delta: number;
  /** Cases the hybrid lane lost that the labelled lexical lane found: the ones a reviewer reads first. */
  regressions: string[];
  gains: string[];
}

/** The degraded-lane comparison of §8.1 step 6: what the labelled `lexical_only` lane still gets right. */
export function compareLanes(
  cases: readonly RecallCase[],
  hybridRun: Readonly<Record<string, readonly string[]>>,
  lexicalRun: Readonly<Record<string, readonly string[]>>,
  k: number = DEFAULT_RECALL_K,
): LaneComparison {
  const hybrid = scoreLane(cases, hybridRun, "hybrid", k);
  const lexical = scoreLane(cases, lexicalRun, "lexical_only", k);
  const byQuery = new Map(hybrid.cases.map((score) => [score.queryId, score]));
  const regressions: string[] = [];
  const gains: string[] = [];
  for (const lexicalScore of lexical.cases) {
    const hybridScore = byQuery.get(lexicalScore.queryId);
    if (hybridScore === undefined) continue;
    if (hybridScore.recall < lexicalScore.recall) regressions.push(lexicalScore.queryId);
    if (hybridScore.recall > lexicalScore.recall) gains.push(lexicalScore.queryId);
  }
  return { hybrid, lexical, delta: hybrid.meanRecall - lexical.meanRecall, regressions, gains };
}

export type Venue =
  /** Scoring the fixture against itself: proves the arithmetic, measures nothing about a corpus. */
  | { kind: "unit-fixture" }
  /** A real Postgres with the corpus in it: CI's `database` job, or staging. */
  | { kind: "real-database"; evidence: string };

export type BaselineGate =
  | { ok: true; label: string }
  | { ok: false; reason: "no_real_database"; because: string };

/** The gate that makes a fabricated baseline impossible rather than merely discouraged. */
export function gateBaseline(venue: Venue): BaselineGate {
  if (venue.kind !== "real-database") {
    return {
      ok: false,
      reason: "no_real_database",
      because:
        "no corpus was searched: these rows came from the fixture expectations themselves. A Recall@10 baseline needs a real database (CI's database job or staging) — COORDINATION §6a defers that evidence, it does not waive it.",
    };
  }
  const evidence = venue.evidence.trim();
  if (evidence.length === 0) {
    return { ok: false, reason: "no_real_database", because: "a real-database venue must name the run it came from." };
  }
  return { ok: true, label: `venue: real database (${evidence})` };
}

export interface HarnessInput {
  cases: readonly RecallCase[];
  hybridRun: Readonly<Record<string, readonly string[]>>;
  lexicalRun: Readonly<Record<string, readonly string[]>>;
  venue: Venue;
  k?: number;
}

export interface HarnessReport {
  lines: string[];
  comparison: LaneComparison;
  baseline: BaselineGate;
}

const r4 = (value: number) => value.toFixed(4);

/**
 * The runner. It prints the number for the rows the caller supplies and says, in the same breath,
 * whether that number is a baseline. The last line is the one a human pastes into a PR.
 */
export function runRecallHarness(input: HarnessInput): HarnessReport {
  const comparison = compareLanes(input.cases, input.hybridRun, input.lexicalRun, input.k ?? DEFAULT_RECALL_K);
  const gate = gateBaseline(input.venue);
  const header = gate.ok
    ? `Recall@${comparison.hybrid.k} baseline — ${gate.label}`
    : `NOT a baseline (venue: ${input.venue.kind}) — refusal: ${gate.because}`;
  const lines = [
    header,
    `cases: ${comparison.hybrid.scoredCases} synthetic queries, k=${comparison.hybrid.k}`,
    `hybrid       mean recall ${r4(comparison.hybrid.meanRecall)}  hit@k ${r4(comparison.hybrid.hitRate)}`,
    `lexical_only mean recall ${r4(comparison.lexical.meanRecall)}  hit@k ${r4(comparison.lexical.hitRate)}`,
    `degraded-lane delta (hybrid - lexical): ${r4(comparison.delta)}`,
    `regressions the vector lane introduced: ${comparison.regressions.length > 0 ? comparison.regressions.join(", ") : "none"}`,
    `bait rows returned (must be 0): hybrid ${comparison.hybrid.baitReturned}, lexical_only ${comparison.lexical.baitReturned}`,
    `runs never attempted: hybrid ${comparison.hybrid.missingRuns.length}, lexical_only ${comparison.lexical.missingRuns.length}`,
  ];
  if (!gate.ok) lines.push(`refusal: ${gate.reason} — no baseline may be quoted from this run.`);
  return { lines, comparison, baseline: gate };
}
