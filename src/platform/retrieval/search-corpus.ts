import { z } from "zod";

import { DataClass, maxDataClass } from "@/contracts/data-class";
import type { EmbeddingIndex } from "@/contracts/provider-route";
import type { TenantContext } from "@/contracts/tenant-context";

/**
 * T-114 half 2: the typed caller of `public.search_corpus_v1` (plan §8.1–§8.3, §6.2; the SQL half is
 * `supabase/migrations/20261111030000_search_corpus.sql`, #160).
 *
 * This file constructs **no SQL**. It posts the ten named arguments of the RPC's signature to the
 * Data API and reads the `o_*` columns back. Two things it is deliberately not:
 *
 * - **Not an authorizer.** The RPC is `security invoker` (#136): RLS on the querying role decides
 *   what exists. The call carries the **signed-in user's own access token** (ADR-0003 §7), so
 *   `auth.uid()`, the `authenticated` grant and every policy behave exactly as the migration assumes.
 *   There is no service-role field in `SearchCorpusDeps`, and there must never be one (AGENTS.md §4.2,
 *   #37). The tenant is read off `TenantContext` and nothing else — the call type has no organisation
 *   field, so a caller cannot pass one, and `p_organisation_id` is only the cross-check the SQL
 *   refuses (28000) when it disagrees with the transaction scope.
 * - **Not the scope setter.** `set_tenant_scope` is transaction-local (`set_config(..., true)`,
 *   tenancy_core.sql:217), so it must be established inside the *same* request as this read: whoever
 *   carries this call to Postgres owns that. A request that gets here without a scope answers 28000,
 *   which this client reports as a refusal — never as an empty corpus.
 *
 * **Empty and failure are different answers** (§8.2), and the type system says so: the RPC emits one
 * `o_evidence_kind = 'diagnostics'` row when it found nothing, and raises a SQLSTATE when it could not
 * look. `no_accessible_evidence` / `coverage_unknown` come only from that row. `index_unavailable` /
 * `backend_failure` come from a raised state or a transport fault, and the local pre-flight refusals
 * below use the same names as the SQLSTATE that would have said the same thing, so a caller cannot
 * tell the two halves apart — which is the point.
 *
 * **No span, ever** (ADR-0008 rule 4): `o_body_text` is the chunk body as stored. `startChar` /
 * `endChar` are UTF-16 offsets into it and only the Worker derives them (verifier pass 1), so
 * `RetrievedChunk` has no such field and `EvidenceRef.ChunkEvidence` is built downstream from
 * `bodyText` plus a quote, not here.
 */

/** The RPC's own bounds (search_corpus.sql:138-153); enforced here so a bad call never reaches the socket. */
export const MAX_QUERY_CHARS = 2000;
export const MIN_EVIDENCE_LIMIT = 1;
export const MAX_EVIDENCE_LIMIT = 25;
/** The RPC's `coalesce(p_limit, 12)`; named so a caller never guesses the default. */
export const DEFAULT_EVIDENCE_LIMIT = 12;
/** Refusal details carry the database's message, bounded: query text never appears in one (§9.2). */
export const MAX_REFUSAL_DETAIL = 300;

const RPC_PATH = "/rest/v1/rpc/search_corpus_v1";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Same narrow shape as `identity/adapters.ts`: injected so the fake and the loopback test share it. */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SearchCorpusDeps {
  /** The Data API origin, e.g. `https://<ref>.supabase.co`. Not a connection string: no key, no host:port. */
  dataApiBaseUrl: string;
  /** The publishable (anon) key, sent as `apikey`. A service-role key has no field here at all. */
  publishableKey?: string;
  fetchImpl?: FetchImpl;
}

/**
 * One scoped question. Nothing here names a tenant or a user: the tenant is `context.organisationId`
 * and the caller is whoever the access token belongs to.
 */
export interface SearchCorpusCall {
  context: TenantContext;
  /** The signed-in user's Supabase access token for this request (ADR-0003 §7). */
  accessToken: string;
  queryText: string;
  /** Empty means the whole tenant corpus the member may read; a null would be an unasked-for widening. */
  serviceKeys?: readonly string[];
  /** Narrowing only: an id the caller may not read matches nothing, it never grants (#4.2). */
  collectionIds?: readonly string[];
  projectId?: string;
  /** `YYYY-MM-DD`: answer only from what was published on or before this date. */
  effectiveOn?: string;
  /** The RPC refuses these (§7.1 has no column yet); this client refuses them too, locally. */
  authorityFilters?: readonly string[];
  queryEmbedding?: readonly number[];
  /** The row id of the pinned generation — `EmbeddingIndex` pins identity, not the row. */
  embeddingIndexId?: string;
  /** The pinned identity the caller believes that row has (TOI-ADR-13); the database re-checks it. */
  embeddingIndex?: EmbeddingIndex;
  limit?: number;
}

export type CorpusStatus = "ok" | "no_accessible_evidence" | "coverage_unknown" | "index_unavailable" | "backend_failure";

export type RefusalReason =
  | "unwired"
  | "query_blank"
  | "query_too_long"
  | "limit_out_of_range"
  | "authority_filters_unsupported"
  | "index_identity_missing"
  | "index_not_active"
  | "dimension_mismatch"
  | "argument_shape"
  | "tenancy"
  | "scope_claim"
  | "argument"
  | "index"
  | "unauthenticated"
  | "retryable"
  | "transport"
  | "response_shape"
  | "database";

export interface CorpusRefusal {
  /** `local` means the request never left the process: provable, and proven in the tests. */
  origin: "local" | "database" | "transport";
  reason: RefusalReason;
  /** The SQLSTATE the RPC raised, or null for a local or transport refusal. */
  sqlState: string | null;
  detail: string;
  reachedDatabase: boolean;
}

/** One `o_evidence_kind = 'chunk'` row. Field names follow `EvidenceRef`, minus the span (ADR-0008). */
export interface RetrievedChunk {
  organisationId: string;
  collectionId: string;
  projectId: string | null;
  sourceId: string;
  sourceVersionId: string;
  chunkId: string;
  chunkIndex: number;
  bodyText: string;
  locator: Record<string, unknown>;
  dataClass: DataClass;
  contentHash: string | null;
  publishedAt: string | null;
  serviceKey: string | null;
  indexGeneration: number | null;
  lane: "both" | "lexical" | "vector" | null;
  rank: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  exactMatch: boolean | null;
  rrfScore: number | null;
}

export interface CorpusDiagnostics {
  schemaVersion: number;
  resultStatus: "ok" | "no_accessible_evidence" | "coverage_unknown";
  retrievalMode: "hybrid" | "lexical_only";
  coverage: { collectionsVisible: number; sourceVersionsVisible: number; chunksVisible: number; chunksWithVectors: number };
  filters: { collectionsNarrowed: boolean; projectApplied: boolean; authorityFiltersApplied: boolean };
  limits: { limit: number | null; returned: number | null; truncated: boolean | null };
  signals: { coverageUnknown: boolean; historicalGap: boolean; indexUnavailable: boolean; maxDataClass: DataClass | null };
}

/** `historical_gap` and `index_unavailable` are caveats, not failures: the answer came, labelled (§8.1 step 6). */
export type CorpusCaveat = "coverage_unknown" | "historical_gap" | "index_unavailable";

export type SearchCorpusResult =
  | {
      ok: true;
      status: "ok";
      evidence: RetrievedChunk[];
      /** §6.2: the highest class among the evidence actually returned. */
      dataClass: DataClass;
      retrievalMode: "hybrid" | "lexical_only";
      caveats: CorpusCaveat[];
      diagnostics: CorpusDiagnostics;
    }
  | {
      ok: false;
      status: "no_accessible_evidence" | "coverage_unknown";
      evidence: [];
      retrievalMode: "hybrid" | "lexical_only";
      caveats: CorpusCaveat[];
      diagnostics: CorpusDiagnostics;
    }
  | {
      ok: false;
      status: "index_unavailable" | "backend_failure";
      evidence: [];
      caveats: CorpusCaveat[];
      diagnostics: CorpusDiagnostics | null;
      refusal: CorpusRefusal;
    };

export interface SearchCorpusClient {
  search(call: SearchCorpusCall): Promise<SearchCorpusResult>;
}

/** The typed-unavailable port, in the `object-store.ts` shape: a missing binding is a refusal, never a silent empty. */
export type SearchCorpusClientOrUnavailable = SearchCorpusClient | null;

// ---------------------------------------------------------------- the wire shape of the RPC's rows

const Int = z.number().int();
const JsonObject = z.looseObject({}).transform((value) => value as Record<string, unknown>);

const DiagnosticsJson = z.looseObject({
  schema_version: Int,
  result_status: z.enum(["ok", "no_accessible_evidence", "coverage_unknown"]),
  retrieval_mode: z.enum(["hybrid", "lexical_only"]),
  coverage: z.looseObject({
    collections_visible: Int,
    source_versions_visible: Int,
    chunks_visible: Int,
    chunks_with_vectors: Int,
  }),
  filters: z.looseObject({
    collections_narrowed: z.boolean(),
    project_applied: z.boolean(),
    authority_filters_applied: z.boolean(),
  }),
  limits: z.looseObject({
    limit: Int.nullable(),
    returned: Int.nullable(),
    truncated: z.boolean().nullable(),
  }),
  signals: z.looseObject({
    coverage_unknown: z.boolean(),
    historical_gap: z.boolean(),
    index_unavailable: z.boolean(),
    max_data_class: DataClass.nullable(),
  }),
});
type DiagnosticsJson = z.infer<typeof DiagnosticsJson>;

const RowEnvelope = z.looseObject({
  o_result_status: z.string(),
  o_evidence_kind: z.string(),
  o_diagnostics: DiagnosticsJson,
});

const ChunkRow = z.looseObject({
  o_result_status: z.string(),
  o_evidence_kind: z.string(),
  o_organisation_id: z.uuid(),
  o_collection_id: z.uuid(),
  o_project_id: z.uuid().nullable(),
  o_source_id: z.uuid(),
  o_source_version_id: z.uuid(),
  o_chunk_id: z.uuid(),
  o_chunk_index: Int.min(0),
  o_body_text: z.string().min(1),
  o_locator: JsonObject,
  o_data_class: DataClass,
  o_content_hash: z.string().nullable(),
  o_published_at: z.string().nullable(),
  o_service_key: z.string().nullable(),
  o_index_generation: Int.nullable(),
  o_lane: z.enum(["both", "lexical", "vector"]).nullable(),
  o_rank: Int,
  o_lexical_rank: Int.nullable(),
  o_vector_rank: Int.nullable(),
  o_exact_match: z.boolean().nullable(),
  // PostgREST renders `numeric` as a JSON number, but a quoted one is not a reason to lose the row.
  o_rrf_score: z.union([z.number(), z.string()]).nullable(),
  o_diagnostics: DiagnosticsJson,
});

// ---------------------------------------------------------------- refusal helpers

function bound(detail: string): string {
  return detail.length <= MAX_REFUSAL_DETAIL ? detail : `${detail.slice(0, MAX_REFUSAL_DETAIL - 1)}…`;
}

function refusal(
  status: "index_unavailable" | "backend_failure",
  reason: RefusalReason,
  detail: string,
  options: { origin?: CorpusRefusal["origin"]; sqlState?: string | null } = {},
): SearchCorpusResult {
  const origin = options.origin ?? "local";
  return {
    ok: false,
    status,
    evidence: [],
    caveats: [],
    diagnostics: null,
    refusal: { origin, reason, sqlState: options.sqlState ?? null, detail: bound(detail), reachedDatabase: origin !== "local" },
  };
}

/** The closed SQLSTATE set the migration raises. Anything unmapped is a database fault, never an empty. */
function sqlStateRefusal(code: string, message: string): SearchCorpusResult {
  if (code === "55000") return refusal("index_unavailable", "index", message, { origin: "database", sqlState: code });
  if (code === "42501") return refusal("backend_failure", "scope_claim", message, { origin: "database", sqlState: code });
  if (code === "28000") return refusal("backend_failure", "tenancy", message, { origin: "database", sqlState: code });
  if (code === "22023" || code === "22P02") return refusal("backend_failure", "argument", message, { origin: "database", sqlState: code });
  if (/^(08|40|53|57)/.test(code)) return refusal("backend_failure", "retryable", message, { origin: "database", sqlState: code });
  return refusal("backend_failure", "database", message, { origin: "database", sqlState: code });
}

function statusRefusal(status: number, message: string): SearchCorpusResult {
  if (status === 401 || status === 403) return refusal("backend_failure", "unauthenticated", message, { origin: "database" });
  if (status === 408 || status === 429 || status >= 500) return refusal("backend_failure", "retryable", message, { origin: "database" });
  return refusal("backend_failure", "database", message, { origin: "database" });
}

function shapeRefusal(detail: string): SearchCorpusResult {
  return refusal("backend_failure", "response_shape", detail, { origin: "database" });
}

function caveatsOf(diagnostics: CorpusDiagnostics): CorpusCaveat[] {
  const out: CorpusCaveat[] = [];
  if (diagnostics.signals.coverageUnknown) out.push("coverage_unknown");
  if (diagnostics.signals.historicalGap) out.push("historical_gap");
  if (diagnostics.signals.indexUnavailable) out.push("index_unavailable");
  return out;
}

function mapDiagnostics(raw: DiagnosticsJson): CorpusDiagnostics {
  return {
    schemaVersion: raw.schema_version,
    resultStatus: raw.result_status,
    retrievalMode: raw.retrieval_mode,
    coverage: {
      collectionsVisible: raw.coverage.collections_visible,
      sourceVersionsVisible: raw.coverage.source_versions_visible,
      chunksVisible: raw.coverage.chunks_visible,
      chunksWithVectors: raw.coverage.chunks_with_vectors,
    },
    filters: {
      collectionsNarrowed: raw.filters.collections_narrowed,
      projectApplied: raw.filters.project_applied,
      authorityFiltersApplied: raw.filters.authority_filters_applied,
    },
    limits: { limit: raw.limits.limit, returned: raw.limits.returned, truncated: raw.limits.truncated },
    signals: {
      coverageUnknown: raw.signals.coverage_unknown,
      historicalGap: raw.signals.historical_gap,
      indexUnavailable: raw.signals.index_unavailable,
      maxDataClass: raw.signals.max_data_class,
    },
  };
}

// ---------------------------------------------------------------- the call, validated before it leaves

interface RpcArgs {
  p_organisation_id: string;
  p_service_keys: string[];
  p_project_id: string | null;
  p_collection_ids: string[] | null;
  p_query_text: string;
  p_query_embedding: number[] | null;
  p_embedding_index_id: string | null;
  p_effective_on: string | null;
  p_authority_filters: string[] | null;
  p_limit: number;
}

function validate(call: SearchCorpusCall): { args: RpcArgs } | { refusal: SearchCorpusResult } {
  const queryText = typeof call.queryText === "string" ? call.queryText : "";
  if (queryText.trim().length === 0) {
    // The RPC has no "return the corpus" mode; neither does this client.
    return { refusal: refusal("backend_failure", "query_blank", "query text must not be blank") };
  }
  if (queryText.length > MAX_QUERY_CHARS) {
    return { refusal: refusal("backend_failure", "query_too_long", `query text exceeds ${MAX_QUERY_CHARS} characters`) };
  }
  const limit = call.limit ?? DEFAULT_EVIDENCE_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_EVIDENCE_LIMIT || limit > MAX_EVIDENCE_LIMIT) {
    return { refusal: refusal("backend_failure", "limit_out_of_range", `p_limit must be between ${MIN_EVIDENCE_LIMIT} and ${MAX_EVIDENCE_LIMIT}`) };
  }

  const isUuid = (value: unknown) => z.uuid().safeParse(value).success;
  const serviceKeys = call.serviceKeys ?? [];
  if (!Array.isArray(serviceKeys) || serviceKeys.some((key) => !z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).safeParse(key).success)) {
    return { refusal: refusal("backend_failure", "argument_shape", "service keys must be lowercase service keys") };
  }
  if (call.collectionIds !== undefined) {
    if (!Array.isArray(call.collectionIds) || call.collectionIds.some((id) => !isUuid(id))) {
      return { refusal: refusal("backend_failure", "argument_shape", "collection ids must be uuids") };
    }
  }
  if (call.projectId !== undefined && !isUuid(call.projectId)) {
    return { refusal: refusal("backend_failure", "argument_shape", "project id must be a uuid") };
  }
  if (call.effectiveOn !== undefined && !DATE_ONLY.test(call.effectiveOn)) {
    return { refusal: refusal("backend_failure", "argument_shape", "effectiveOn must be a YYYY-MM-DD date") };
  }
  if (call.authorityFilters !== undefined && call.authorityFilters.length > 0) {
    return {
      refusal: refusal("backend_failure", "authority_filters_unsupported", "authority filters cannot be evaluated by this corpus yet (§7.1); passing them would return more than was asked for"),
    };
  }

  const embedding = call.queryEmbedding;
  const indexId = call.embeddingIndexId;
  const index = call.embeddingIndex;
  if (embedding !== undefined && embedding !== null) {
    if (indexId === undefined || index === undefined) {
      return {
        refusal: refusal("backend_failure", "index_identity_missing", "a query vector needs the pinned index identity it was produced for (§8.3, TOI-ADR-13)"),
      };
    }
    if (!isUuid(indexId)) {
      return { refusal: refusal("backend_failure", "argument_shape", "embedding index id must be a uuid") };
    }
    if (index.status !== "active") {
      return { refusal: refusal("index_unavailable", "index_not_active", `${index.indexKey} g${index.generation} is ${index.status}: no vector lane without an active pointer`) };
    }
    if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
      return { refusal: refusal("backend_failure", "argument_shape", "query embedding must be a non-empty vector of finite numbers") };
    }
    if (embedding.length !== index.dimensions) {
      // Mirrors embeddings.ts: refusing here is what keeps an incomparable vector off the wire, and
      // the same name as the 55000 the database would have raised.
      return { refusal: refusal("index_unavailable", "dimension_mismatch", `${index.indexKey} g${index.generation} pins ${index.dimensions} dimensions, the query vector has ${embedding.length}`) };
    }
  } else if (indexId !== undefined || index !== undefined) {
    // An index with no vector is legal in the RPC (it only reports coverage), but a caller that names
    // a retired generation should hear about it before the query runs.
    if (index !== undefined && index.status !== "active") {
      return { refusal: refusal("index_unavailable", "index_not_active", `${index.indexKey} g${index.generation} is ${index.status}`) };
    }
    if (indexId !== undefined && !isUuid(indexId)) {
      return { refusal: refusal("backend_failure", "argument_shape", "embedding index id must be a uuid") };
    }
  }

  return {
    args: {
      // The tenant, from the resolved context only. The SQL cross-checks it against the transaction
      // scope and raises 28000 when they disagree (§4.1).
      p_organisation_id: call.context.organisationId,
      p_service_keys: [...serviceKeys],
      p_project_id: call.projectId ?? null,
      // An empty array is kept as an empty array: null would widen the search to every collection,
      // which §8.2 forbids and the packet's negative test pins.
      p_collection_ids: call.collectionIds === undefined ? null : [...call.collectionIds],
      p_query_text: queryText,
      p_query_embedding: embedding === undefined || embedding === null ? null : [...embedding],
      p_embedding_index_id: embedding === undefined || embedding === null ? null : (indexId ?? null),
      p_effective_on: call.effectiveOn ?? null,
      p_authority_filters: null,
      p_limit: limit,
    },
  };
}

// ---------------------------------------------------------------- the client

export function createSearchCorpusClient(deps: SearchCorpusDeps): SearchCorpusClient {
  const base = typeof deps.dataApiBaseUrl === "string" ? deps.dataApiBaseUrl.replace(/\/+$/, "") : "";
  if (base.length === 0) {
    throw new Error("search_corpus_v1 client: a Data API base URL binding is required (ADR-0003 §7)");
  }
  const fetchImpl: FetchImpl = deps.fetchImpl ?? ((fetch as unknown) as FetchImpl);
  const publishableKey = typeof deps.publishableKey === "string" ? deps.publishableKey : "";

  return {
    search: async (call: SearchCorpusCall): Promise<SearchCorpusResult> => {
      const checked = validate(call);
      if ("refusal" in checked) return checked.refusal;
      const accessToken = typeof call.accessToken === "string" ? call.accessToken.trim() : "";
      if (accessToken.length === 0) {
        // No token, no auth.uid(), no RLS: the call would be unauthenticated, so it is not made.
        return refusal("backend_failure", "unauthenticated", "no user access token for this request (ADR-0003 §7)");
      }

      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      };
      if (publishableKey.length > 0) headers.apikey = publishableKey;

      let response: Awaited<ReturnType<FetchImpl>>;
      try {
        response = await fetchImpl(`${base}${RPC_PATH}`, { method: "POST", headers, body: JSON.stringify(checked.args) });
      } catch {
        // The fault's own message can name hosts and credentials, so it is not echoed.
        return refusal("backend_failure", "transport", "the Data API request did not complete", { origin: "transport" });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (response.ok) return shapeRefusal("the Data API answered a 2xx with a body that is not JSON");
        return statusRefusal(response.status, `the Data API answered ${response.status}`);
      }

      if (!response.ok) {
        const error = payload as { code?: unknown; message?: unknown } | null;
        const code = typeof error?.code === "string" ? error.code : null;
        const message = typeof error?.message === "string" ? error.message : `the Data API answered ${response.status}`;
        return code === null ? statusRefusal(response.status, message) : sqlStateRefusal(code, message);
      }

      if (!Array.isArray(payload)) return shapeRefusal("expected the RPC to return a row array");
      const envelopes: Array<z.infer<typeof RowEnvelope>> = [];
      for (const row of payload) {
        const parsed = RowEnvelope.safeParse(row);
        if (!parsed.success) return shapeRefusal("a returned row does not have the RPC's o_ columns");
        envelopes.push(parsed.data);
      }

      const chunkRows = envelopes.filter((row) => row.o_evidence_kind === "chunk");
      const diagnosticRows = envelopes.filter((row) => row.o_evidence_kind === "diagnostics");
      if (chunkRows.length + diagnosticRows.length !== envelopes.length) {
        return shapeRefusal(`unknown o_evidence_kind in the returned rows: ${envelopes.map((row) => row.o_evidence_kind).join(", ")}`);
      }
      if (chunkRows.length > 0) {
        if (diagnosticRows.length > 0) return shapeRefusal("the RPC emitted both evidence rows and a diagnostics row");
        const rows: RetrievedChunk[] = [];
        for (const row of chunkRows) {
          const parsed = ChunkRow.safeParse(row);
          if (!parsed.success) return shapeRefusal("an evidence row is missing a column or carries an unknown data class");
          if (parsed.data.o_result_status !== "ok") return shapeRefusal("evidence rows came back with a non-ok result status");
          rows.push({
            organisationId: parsed.data.o_organisation_id,
            collectionId: parsed.data.o_collection_id,
            projectId: parsed.data.o_project_id,
            sourceId: parsed.data.o_source_id,
            sourceVersionId: parsed.data.o_source_version_id,
            chunkId: parsed.data.o_chunk_id,
            chunkIndex: parsed.data.o_chunk_index,
            bodyText: parsed.data.o_body_text,
            locator: parsed.data.o_locator,
            dataClass: parsed.data.o_data_class,
            contentHash: parsed.data.o_content_hash,
            publishedAt: parsed.data.o_published_at,
            serviceKey: parsed.data.o_service_key,
            indexGeneration: parsed.data.o_index_generation,
            lane: parsed.data.o_lane,
            rank: parsed.data.o_rank,
            lexicalRank: parsed.data.o_lexical_rank,
            vectorRank: parsed.data.o_vector_rank,
            exactMatch: parsed.data.o_exact_match,
            rrfScore: parsed.data.o_rrf_score === null || parsed.data.o_rrf_score === undefined ? null : Number(parsed.data.o_rrf_score),
          });
        }
        const diagnostics = mapDiagnostics((chunkRows[chunkRows.length - 1] as z.infer<typeof RowEnvelope>).o_diagnostics);
        if (diagnostics.resultStatus !== "ok") return shapeRefusal("the diagnostics row disagrees with the evidence rows");
        return {
          ok: true,
          status: "ok",
          evidence: rows,
          // §6.2: whatever is composed from these rows carries the highest class among them.
          dataClass: maxDataClass(rows.map((row) => row.dataClass)),
          retrievalMode: diagnostics.retrievalMode,
          caveats: caveatsOf(diagnostics),
          diagnostics,
        };
      }

      // Zero evidence rows: exactly one diagnostics row, or the contract was broken (§8.2).
      if (diagnosticRows.length !== 1) return shapeRefusal("a search with no evidence must return exactly one diagnostics row");
      const diagnostics = mapDiagnostics((diagnosticRows[0] as z.infer<typeof RowEnvelope>).o_diagnostics);
      if (diagnostics.resultStatus === "ok") return shapeRefusal("the RPC claimed ok while returning no evidence rows");
      return {
        ok: false,
        status: diagnostics.resultStatus,
        evidence: [],
        retrievalMode: diagnostics.retrievalMode,
        caveats: caveatsOf(diagnostics),
        diagnostics,
      };
    },
  };
}

/**
 * The unwired port, in the style of `identity/adapters.ts`: a deployment with no Data API binding
 * answers `backend_failure` rather than inventing an empty corpus or reaching for a key it was never
 * given. The reason goes in the detail so the operator can tell this from a database fault.
 */
export function unavailableSearchCorpusClient(detail: string): SearchCorpusClient {
  return { search: async () => refusal("backend_failure", "unwired", detail, { origin: "local" }) };
}
