import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EmbeddingIndex } from "@/contracts/provider-route";
import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";

import {
  createSearchCorpusClient,
  unavailableSearchCorpusClient,
  type CorpusRefusal,
  type FetchImpl,
  type SearchCorpusCall,
  type SearchCorpusResult,
} from "./search-corpus";

/**
 * T-114 half 2, written first (packet "Acceptance tests", the unit half; plan §8.2, §6.2; ADR-0008).
 *
 * Two things are being proven here, and they are not the same thing:
 *
 * 1. **The client never guesses.** Every argument the RPC refuses (blank query, limit out of range,
 *    a query vector without a pinned index, a vector whose dimensions disagree with that index, an
 *    authority filter) is refused **before the socket opens** — the fake transport counts calls, so
 *    "refused locally" is an observable fact, not a comment. The same names are used for the local
 *    refusal and for the SQLSTATE that would have said the same thing, so a caller cannot tell two
 *    versions of the same mistake apart by which side caught it.
 * 2. **Empty is not failure, and failure is not empty.** `no_accessible_evidence` /
 *    `coverage_unknown` come from the diagnostics row the RPC emits when it found nothing;
 *    `index_unavailable` / `backend_failure` come from a raised SQLSTATE or a transport fault. A
 *    test that only checked "no rows" could not tell those apart, which is exactly the confusion
 *    §8.2 forbids, so each case asserts the status name.
 *
 * Everything is synthetic: `SYNTH-*` ids, invented sentences, a fake JWT. The last block is the
 * loopback harness COORDINATION §6a requires: a real `fetch` to a `127.0.0.1:listen(0)` listener,
 * asserting what actually crossed the socket.
 */

const ORG = "0f9fd6dd-0f0a-4b02-9b45-2fda5e6d1e01";
const OTHER_ORG = "11111111-1111-4111-8111-111111111111";
const USER = "6f0a1e6a-8f4a-4b57-9e30-1d6b9a0e4a11";
const COLLECTION = "2c2f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e01";
const PROJECT = "3d3f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e02";
const SOURCE = "4e4f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e03";
const VERSION = "5f5f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e04";
const CHUNK_A = "6a6a1a5d-4a5d-4e33-9b0e-7c2f1a5d8e05";
const CHUNK_B = "7b7b1a5d-4a5d-4e33-9b0e-7c2f1a5d8e06";
const INDEX_ID = "8c8c1a5d-4a5d-4e33-9b0e-7c2f1a5d8e07";

/** The pin of issue #6 / embeddings.test.ts: one model, one dimension, one metric. */
const INDEX = EmbeddingIndex.parse({
  indexKey: "m1-bge-m3",
  providerKey: "workers_ai",
  model: "@cf/baai/bge-m3",
  dimensions: 1024,
  metric: "cosine",
  generation: 2,
  status: "active",
  clearedFor: ["public", "internal"],
});

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return createTenantContext({
    organisationId: ORG,
    host: "company1.terraoi.app",
    userId: USER,
    membershipId: "b1d1e0a6-1a5c-4d7e-9c47-2c1e6a5b0f22",
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: ["uav", "gpr"],
    permittedProjectIds: [PROJECT],
    policyRevision: 4,
    resolvedAt: "2026-11-10T09:00:00.000Z",
    ...overrides,
  });
}

const DIAGNOSTICS = {
  schema_version: 1,
  result_status: "ok",
  retrieval_mode: "hybrid",
  fusion: { method: "reciprocal_rank", k: 60, lanes: 2 },
  lanes: {
    lexical: { queried: true, matched: 4, candidate_budget: 72 },
    vector: {
      queried: true,
      matched: 6,
      candidate_budget: 72,
      index_id: INDEX_ID,
      index_key: "m1-bge-m3",
      model: "@cf/baai/bge-m3",
      dimensions: 1024,
      metric: "cosine",
      generation: 2,
    },
  },
  coverage: {
    collections_visible: 2,
    source_versions_visible: 3,
    chunks_visible: 41,
    chunks_with_vectors: 38,
  },
  filters: {
    service_keys: ["uav"],
    collections_narrowed: false,
    project_applied: false,
    effective_on: null,
    authority_filters_applied: false,
  },
  limits: { limit: 12, returned: 2, truncated: false },
  signals: {
    coverage_unknown: false,
    historical_gap: true,
    index_unavailable: false,
    max_data_class: "client_confidential",
  },
};

function chunkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    o_result_status: "ok",
    o_evidence_kind: "chunk",
    o_organisation_id: ORG,
    o_collection_id: COLLECTION,
    o_project_id: null,
    o_source_id: SOURCE,
    o_source_version_id: VERSION,
    o_chunk_id: CHUNK_A,
    o_chunk_index: 3,
    o_body_text: "The SYNTH-KX-9 payload must be re-calibrated every 40 flight hours.",
    o_locator: { page: 12, section: "Maintenance intervals" },
    o_data_class: "internal",
    o_content_hash: "a".repeat(64),
    o_published_at: "2026-10-01T08:00:00+00:00",
    o_service_key: "uav",
    o_index_generation: 2,
    o_lane: "both",
    o_rank: 1,
    o_lexical_rank: 1,
    o_vector_rank: 2,
    o_exact_match: true,
    o_rrf_score: 0.0325,
    o_diagnostics: DIAGNOSTICS,
    ...overrides,
  };
}

function diagnosticsRow(status: string, signals: Record<string, unknown> = {}): Record<string, unknown> {
  return chunkRow({
    o_result_status: status,
    o_evidence_kind: "diagnostics",
    o_chunk_id: null,
    o_chunk_index: null,
    o_body_text: null,
    o_locator: null,
    o_data_class: null,
    o_content_hash: null,
    o_published_at: null,
    o_service_key: null,
    o_index_generation: null,
    o_lane: null,
    o_lexical_rank: null,
    o_vector_rank: null,
    o_exact_match: null,
    o_rrf_score: null,
    o_diagnostics: {
      ...DIAGNOSTICS,
      result_status: status,
      retrieval_mode: "lexical_only",
      coverage: {
        collections_visible: 0,
        source_versions_visible: 0,
        chunks_visible: 0,
        chunks_with_vectors: 0,
      },
      limits: { limit: 12, returned: 0, truncated: false },
      signals: {
        coverage_unknown: status === "coverage_unknown",
        historical_gap: false,
        index_unavailable: true,
        max_data_class: null,
        ...signals,
      },
    },
  });
}

// ---------------------------------------------------------------- the fake Data API transport

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeTransport(reply: () => { status: number; body: unknown }): {
  fetchImpl: FetchImpl;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const sent = reply();
    return {
      ok: sent.status >= 200 && sent.status < 300,
      status: sent.status,
      json: async () => sent.body,
    };
  };
  return { fetchImpl, calls };
}

function rowsTransport(rows: unknown[]): { fetchImpl: FetchImpl; calls: Captured[] } {
  return fakeTransport(() => ({ status: 200, body: rows }));
}

function sqlstateTransport(code: string, message: string): { fetchImpl: FetchImpl; calls: Captured[] } {
  return fakeTransport(() => ({ status: 400, body: { code, message, details: null, hint: null } }));
}

function client(fetchImpl: FetchImpl) {
  return createSearchCorpusClient({
    dataApiBaseUrl: "https://synthetic.supabase.co",
    publishableKey: "synthetic-publishable-key",
    fetchImpl,
  });
}

function baseCall(overrides: Partial<SearchCorpusCall> = {}): SearchCorpusCall {
  return {
    context: context(),
    accessToken: "eyJhbGciOi synthetic-user-token",
    queryText: "SYNTH-KX-9 re-calibration interval",
    ...overrides,
  };
}

function posted(calls: Captured[], index = 0): Record<string, unknown> {
  const call = calls[index];
  if (call === undefined) throw new Error(`expected a Data API call at ${index}`);
  return JSON.parse(call.body) as Record<string, unknown>;
}

function refusalOf(result: SearchCorpusResult): CorpusRefusal {
  if (result.ok || !("refusal" in result)) throw new Error("expected a refusal that names why");
  return result.refusal;
}

function failureOf(result: SearchCorpusResult): { status: string; reason?: string; origin?: string; sqlState?: string | null } {
  const found = refusalOf(result);
  return { status: result.status, reason: found.reason, origin: found.origin, sqlState: found.sqlState };
}

// ---------------------------------------------------------------- refuses before any network call

describe("search_corpus_v1 client: local refusals (no socket opened)", () => {
  it("a query vector whose dimensions disagree with the pinned index is refused locally", async () => {
    // Mirrors embeddings.ts: vectors from different models are incomparable (TOI-ADR-13), and the
    // SQL would raise 55000. Refusing here is what keeps a wrong-shaped vector off the wire.
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    const result = await client(fetchImpl).search(
      baseCall({ embeddingIndexId: INDEX_ID, embeddingIndex: INDEX, queryEmbedding: new Array(1536).fill(0.5) }),
    );
    expect(calls).toHaveLength(0);
    expect(failureOf(result)).toMatchObject({ status: "index_unavailable", reason: "dimension_mismatch", origin: "local" });
    expect(refusalOf(result).reachedDatabase).toBe(false);
  });

  it("a query vector without the pinned index identity is refused, as the RPC refuses it", async () => {
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    const missingId = await client(fetchImpl).search(baseCall({ queryEmbedding: new Array(1024).fill(0.1), embeddingIndex: INDEX }));
    const missingPin = await client(fetchImpl).search(baseCall({ queryEmbedding: new Array(1024).fill(0.1), embeddingIndexId: INDEX_ID }));
    expect(calls).toHaveLength(0);
    expect(failureOf(missingId).status).toBe("backend_failure");
    expect(failureOf(missingId).reason).toBe("index_identity_missing");
    expect(failureOf(missingPin).reason).toBe("index_identity_missing");
  });

  it("a pinned index that is not active is refused before the vector lane is asked for", async () => {
    const retired = EmbeddingIndex.parse({ ...INDEX, status: "retired" });
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    const result = await client(fetchImpl).search(
      baseCall({ embeddingIndexId: INDEX_ID, embeddingIndex: retired, queryEmbedding: new Array(1024).fill(0.1) }),
    );
    expect(calls).toHaveLength(0);
    expect(failureOf(result)).toMatchObject({ status: "index_unavailable", reason: "index_not_active" });
  });

  it("the argument bounds the RPC states are enforced locally: blank, oversized, out-of-range limit", async () => {
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    const blank = await client(fetchImpl).search(baseCall({ queryText: "   " }));
    const oversized = await client(fetchImpl).search(baseCall({ queryText: "q".repeat(2001) }));
    const tooMany = await client(fetchImpl).search(baseCall({ limit: 26 }));
    const zero = await client(fetchImpl).search(baseCall({ limit: 0 }));
    expect(calls).toHaveLength(0);
    expect(failureOf(blank).reason).toBe("query_blank");
    expect(failureOf(oversized).reason).toBe("query_too_long");
    expect(failureOf(tooMany).reason).toBe("limit_out_of_range");
    expect(failureOf(zero).reason).toBe("limit_out_of_range");
  });

  it("authority filters are refused, not dropped: passing them would silently widen the answer", async () => {
    // The migration raises 22023 for the same reason (§7.1 has no column yet). A client that
    // accepted the filter and searched without it would return more than the caller asked for.
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    const result = await client(fetchImpl).search(baseCall({ authorityFilters: ["vendor_manual"] }));
    expect(calls).toHaveLength(0);
    expect(failureOf(result).reason).toBe("authority_filters_unsupported");
  });

  it("a malformed id or date is caught locally rather than sent as a cast error", async () => {
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    const badProject = await client(fetchImpl).search(baseCall({ projectId: "project-1" }));
    const badDate = await client(fetchImpl).search(baseCall({ effectiveOn: "10-11-2026" }));
    expect(calls).toHaveLength(0);
    expect(failureOf(badProject).reason).toBe("argument_shape");
    expect(failureOf(badDate).reason).toBe("argument_shape");
  });

  it("the unwired port answers backend_failure, never an empty corpus", async () => {
    const result = await unavailableSearchCorpusClient("no Data API binding in this deployment").search(baseCall());
    expect(failureOf(result)).toMatchObject({ status: "backend_failure", reason: "unwired", origin: "local" });
  });
});

// ---------------------------------------------------------------- the wire call

describe("search_corpus_v1 client: what the call asks for", () => {
  it("posts to the RPC with the ten argument names of the migration signature", async () => {
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    await client(fetchImpl).search(baseCall({ limit: 5 }));
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://synthetic.supabase.co/rest/v1/rpc/search_corpus_v1");
    expect(posted(calls)).toMatchObject({
      p_organisation_id: ORG,
      p_service_keys: [],
      p_project_id: null,
      p_collection_ids: null,
      p_query_text: "SYNTH-KX-9 re-calibration interval",
      p_query_embedding: null,
      p_embedding_index_id: null,
      p_effective_on: null,
      p_authority_filters: null,
      p_limit: 5,
    });
  });

  it("takes the tenant only from TenantContext: no call shape carries another organisation", async () => {
    // `SearchCorpusCall` has no organisationId field, so the only tenant a caller can name is the one
    // already resolved into TenantContext — and that is what reaches the wire.
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    const search = client(fetchImpl).search;
    await search({ ...baseCall(), context: context({ organisationId: OTHER_ORG }) });
    expect(posted(calls).p_organisation_id).toBe(OTHER_ORG);
    // And when the database says the scope disagrees with the caller's membership, that is a refusal
    // the caller must not be able to mistake for "nothing in the corpus matched".
    const refused = sqlstateTransport("28000", "search_corpus_v1: p_organisation_id does not match this transaction's tenant scope (§4.1)");
    const refusal = await client(refused.fetchImpl).search(baseCall());
    expect(failureOf(refusal)).toMatchObject({ status: "backend_failure", reason: "tenancy", sqlState: "28000" });
  });

  it("a narrowing filter is never widened: empty arrays stay empty arrays, never null", async () => {
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    await client(fetchImpl).search(
      baseCall({ collectionIds: [], serviceKeys: [], projectId: PROJECT, effectiveOn: "2026-06-30", limit: 12 }),
    );
    const body = posted(calls);
    // `p_collection_ids = '{}'` matches nothing (§8.2: filters narrow). Turning it into null would
    // search the whole tenant — the widening the packet's negative test forbids.
    expect(body.p_collection_ids).toEqual([]);
    expect(body.p_service_keys).toEqual([]);
    expect(body.p_project_id).toBe(PROJECT);
    expect(body.p_effective_on).toBe("2026-06-30");
  });

  it("sends the vector and the pinned index id together, as one pinned identity", async () => {
    // A 4-dimension pin so the vector on the wire is readable; the rule is about pairing, not size.
    const tiny = EmbeddingIndex.parse({ ...INDEX, dimensions: 4 });
    const { fetchImpl, calls } = rowsTransport([chunkRow()]);
    await client(fetchImpl).search(
      baseCall({ embeddingIndexId: INDEX_ID, embeddingIndex: tiny, queryEmbedding: [0.25, -1, 0, 3.5] }),
    );
    const body = posted(calls);
    expect(body.p_embedding_index_id).toBe(INDEX_ID);
    expect(body.p_query_embedding).toEqual([0.25, -1, 0, 3.5]);
  });

  it("an index named without a vector is still sent: a stated argument is never dropped locally", async () => {
    // The RPC accepts `p_embedding_index_id` with no query vector: it resolves and pins that row under
    // RLS and reports how much of the readable corpus has vectors, which is the only way
    // `coverage.chunks_with_vectors` and the `index_unavailable` signal can mean anything. Substituting
    // null here would be the silently-dropped-filter mistake in the other direction (§8.2).
    const { fetchImpl, calls } = rowsTransport([chunkRow({ o_lane: "lexical", o_index_generation: null })]);
    await client(fetchImpl).search(baseCall({ embeddingIndexId: INDEX_ID, embeddingIndex: INDEX }));
    const body = posted(calls);
    expect(body.p_embedding_index_id).toBe(INDEX_ID);
    expect(body.p_query_embedding).toBeNull();
  });

  it("an unscoped-but-valid lexical-only search still runs: no embedding means no vector lane", async () => {
    const { fetchImpl, calls } = rowsTransport([diagnosticsRow("no_accessible_evidence")]);
    const result = await client(fetchImpl).search(baseCall());
    expect(calls).toHaveLength(1);
    expect(posted(calls).p_query_embedding).toBeNull();
    expect(result.ok).toBe(false);
    if (!result.ok && result.diagnostics) expect(result.diagnostics.retrievalMode).toBe("lexical_only");
  });
});

// ---------------------------------------------------------------- rows into evidence

describe("search_corpus_v1 client: rows, evidence and diagnostics", () => {
  it("splits evidence rows from the diagnostics row and maps ids, locator, class and text", async () => {
    const { fetchImpl } = rowsTransport([
      chunkRow(),
      chunkRow({
        o_chunk_id: CHUNK_B,
        o_rank: 2,
        o_lexical_rank: null,
        o_vector_rank: 1,
        o_lane: "vector",
        o_exact_match: false,
        o_data_class: "client_confidential",
        o_locator: { table: "Toll intervals" },
      }),
    ]);
    const result = await client(fetchImpl).search(
      baseCall({ embeddingIndexId: INDEX_ID, embeddingIndex: INDEX, queryEmbedding: new Array(1024).fill(0.1) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.map((row) => row.chunkId)).toEqual([CHUNK_A, CHUNK_B]);
    expect(result.evidence.map((row) => row.rank)).toEqual([1, 2]);
    expect(result.evidence[1]?.lane).toBe("vector");
    expect(result.evidence[0]?.locator).toEqual({ page: 12, section: "Maintenance intervals" });
    expect(result.evidence[0]?.sourceVersionId).toBe(VERSION);
    expect(result.evidence[0]?.bodyText).toContain("SYNTH-KX-9");
    // §6.2: the class of the answer's material is the highest class among the evidence it came from.
    expect(result.dataClass).toBe("client_confidential");
    expect(result.retrievalMode).toBe("hybrid");
    expect(result.caveats).toContain("historical_gap");
  });

  it("returns text, never an offset: no span field of any shape comes back (ADR-0008)", async () => {
    const { fetchImpl } = rowsTransport([chunkRow()]);
    const result = await client(fetchImpl).search(baseCall());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dumped = JSON.stringify(result.evidence);
    expect(dumped).not.toMatch(/startChar|endChar|"span"|quotedText|objectKey|signedUrl|storage/);
  });

  it("a zero-evidence answer is a named empty status, and never carries a data class", async () => {
    const { fetchImpl } = rowsTransport([diagnosticsRow("no_accessible_evidence")]);
    const result = await client(fetchImpl).search(baseCall());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("no_accessible_evidence");
    expect(result.evidence).toEqual([]);
    // maxDataClass([]) throws on purpose (§6.2): an answer with nothing under it is not `public`.
    expect(result).not.toHaveProperty("dataClass");
    expect(result.diagnostics?.coverage.chunksVisible).toBe(0);
  });

  it("coverage_unknown is a different answer from no_accessible_evidence", async () => {
    const { fetchImpl } = rowsTransport([diagnosticsRow("coverage_unknown")]);
    const result = await client(fetchImpl).search(baseCall());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("coverage_unknown");
    expect(result.caveats).toContain("coverage_unknown");
  });

  it("a degraded lexical_only lane is labelled, not a failure (§8.1 step 6)", async () => {
    // The embedding route was unavailable, so the caller sent no vector: the RPC answers on the
    // labelled lane and says so in the diagnostics. Still authorized, still an answer.
    const degradedDiagnostics = {
      ...DIAGNOSTICS,
      retrieval_mode: "lexical_only",
      lanes: { ...DIAGNOSTICS.lanes, vector: { ...DIAGNOSTICS.lanes.vector, queried: false, matched: 0, index_id: null, index_key: null, model: null, dimensions: null, metric: null, generation: null } },
      signals: { ...DIAGNOSTICS.signals, index_unavailable: true },
    };
    const { fetchImpl } = rowsTransport([
      chunkRow({ o_lane: "lexical", o_index_generation: null, o_vector_rank: null, o_diagnostics: degradedDiagnostics }),
    ]);
    const result = await client(fetchImpl).search(baseCall());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.retrievalMode).toBe("lexical_only");
    expect(result.caveats).toContain("index_unavailable");
  });
});

// ---------------------------------------------------------------- failures are not empties

describe("search_corpus_v1 client: refusals and transport", () => {
  it("maps the closed SQLSTATE set to the packet's taxonomy, never to an empty result", async () => {
    const cases: [string, string, string][] = [
      ["55000", "index_unavailable", "index"],
      ["42501", "backend_failure", "scope_claim"],
      ["22023", "backend_failure", "argument"],
      ["28000", "backend_failure", "tenancy"],
    ];
    for (const [sqlState, status, reason] of cases) {
      const transport = sqlstateTransport(sqlState, `search_corpus_v1: refused (${sqlState})`);
      const result = await client(transport.fetchImpl).search(baseCall());
      expect(transport.calls).toHaveLength(1);
      expect(failureOf(result)).toMatchObject({ status, reason, origin: "database", sqlState });
      if (!result.ok) expect(result.status).not.toBe("no_accessible_evidence");
    }
  });

  it("a transport fault is backend_failure and echoes nothing from the fault body", async () => {
    const leaking: FetchImpl = async () => {
      throw new Error("connect ECONNREFUSED internal.replica:6432 password=hunter2");
    };
    const result = await client(leaking).search(baseCall());
    expect(failureOf(result)).toMatchObject({ status: "backend_failure", reason: "transport", origin: "transport" });
    const detail = refusalOf(result).detail;
    expect(detail).not.toContain("hunter2");
    expect(detail.length).toBeLessThanOrEqual(300);
  });

  it("a 503 from the Data API is a failure with the status preserved, not an empty corpus", async () => {
    const transport = fakeTransport(() => ({ status: 503, body: { code: "08006", message: "database connection failure" } }));
    const result = await client(transport.fetchImpl).search(baseCall());
    expect(failureOf(result)).toMatchObject({ status: "backend_failure", reason: "retryable", sqlState: "08006" });
  });

  it("rejects a row set that contradicts the RPC contract instead of answering from it", async () => {
    // ok + no chunk rows, an unknown data class, a non-array body, and a chunk row beside a
    // diagnostics row are all things the migration guarantees cannot happen; a client that guessed
    // would be inventing rows.
    const malformed: unknown[] = [
      [diagnosticsRow("ok")],
      [chunkRow({ o_data_class: "secret_squirrel" })],
      [chunkRow(), diagnosticsRow("no_accessible_evidence")],
      "not-an-array",
    ];
    for (const body of malformed) {
      const transport = fakeTransport(() => ({ status: 200, body }));
      const result = await client(transport.fetchImpl).search(baseCall());
      expect(failureOf(result)).toMatchObject({ status: "backend_failure", reason: "response_shape", origin: "database" });
    }
  });

  it("never echoes the query text into a refusal detail", async () => {
    const transport = sqlstateTransport("22023", "search_corpus_v1: p_query_text exceeds the 2000-character question bound (§9.2)");
    const result = await client(transport.fetchImpl).search(baseCall({ queryText: "the exact provision number SYNTH-4412/B" }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SYNTH-4412/B");
  });
});

// ---------------------------------------------------------------- loopback (COORDINATION §6a)

const USER_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.synthetic-user.4069";
const SERVICE_ROLE_CANARY = "sb_secret_synthetic_service_role_canary_must_never_leave";
const PUBLISHABLE = "synthetic-publishable-anon-key";

let server: Server;
let base = "";
const wire: Captured[] = [];
let replyBody: unknown = [chunkRow()];
/** PostgREST answers a raised SQLSTATE with a 4xx and the state in the body, never with a 200. */
let replyStatus = 200;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value.join(",") : (value ?? "");
      }
      wire.push({ url: req.url ?? "", method: req.method ?? "", headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(replyStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(replyBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the client against a loopback listener: what actually crossed the socket (COORD 6a)", () => {
  it("carries the user's own token, and nothing service-role-shaped leaves the process", async () => {
    // ADR-0003 §7: server-side Data API calls use the signed-in user's token so auth.uid(), RLS and
    // the `authenticated` grant all behave as the migration assumes. The canary sits in the same env
    // bag a real deployment would have; the client type has no field that could carry it.
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_CANARY;
    replyStatus = 200;
    replyBody = [chunkRow()];
    const search = createSearchCorpusClient({ dataApiBaseUrl: base, publishableKey: PUBLISHABLE });
    const result = await search.search(
      baseCall({ accessToken: USER_TOKEN, collectionIds: [], serviceKeys: ["uav"], projectId: PROJECT }),
    );
    expect(result.ok).toBe(true);
    const call = wire[wire.length - 1];
    if (!call) throw new Error("expected a request on the loopback socket");
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/rest/v1/rpc/search_corpus_v1");
    expect(call.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(call.headers.apikey).toBe(PUBLISHABLE);
    const crossed = `${Object.entries(call.headers).map(([k, v]) => `${k}:${v}`).join("\n")}${call.url}${call.body}`;
    expect(crossed).not.toContain(SERVICE_ROLE_CANARY);
    expect(crossed).not.toMatch(/service_role|sb_secret_|postgres:\/\//);
    // The tenant on the wire is the one TenantContext resolved, and the empty collection list stayed
    // empty on the wire — both facts are read off the socket, not off the client's own state.
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.p_organisation_id).toBe(ORG);
    expect(body.p_collection_ids).toEqual([]);
    expect(body.p_service_keys).toEqual(["uav"]);
    expect(body.p_project_id).toBe(PROJECT);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("a SQLSTATE refusal over the socket answers with the taxonomy name, and the query text stays in the body", async () => {
    replyStatus = 400;
    replyBody = { code: "42501", message: "search_corpus_v1: project is not readable in this scope (§4.2)" };
    const search = createSearchCorpusClient({ dataApiBaseUrl: base, publishableKey: PUBLISHABLE });
    const result = await search.search(baseCall({ accessToken: USER_TOKEN, projectId: PROJECT }));
    expect(failureOf(result)).toMatchObject({ status: "backend_failure", reason: "scope_claim", sqlState: "42501" });
    expect(JSON.stringify(result)).not.toContain("SYNTH-KX-9");
  });
});
