import type { TenantContext } from "@/contracts/tenant-context";

import {
  MAX_IDENTIFIER_CHARS,
  type ExactHit,
  type ExactLookupClient,
  type ExactLookupResult,
} from "./exact-lookup";
import type {
  RetrievedChunk,
  SearchCorpusCall,
  SearchCorpusClient,
  SearchCorpusResult,
} from "./search-corpus";

/**
 * T-216 PR-2: query planning — exact identifier lookup before hybrid search (plan §8.1 steps 4–5).
 * Condensation (F30) is a later slice (needs T-104 conversation history).
 *
 * Both the original question and the searched query are recorded on every result so audit / eval
 * can see what ran. Exact hits short-circuit hybrid; a miss or a soft exact failure falls through.
 */

export type RetrievalLane = "exact" | "hybrid";

export interface QueryPlanInput {
  context: TenantContext;
  accessToken: string;
  /** Employee question as asked (always recorded). */
  originalQuery: string;
  /**
   * Query actually searched. Until F30 lands this equals `originalQuery`; condensation may rewrite
   * it later without changing the original.
   */
  searchedQuery?: string;
  serviceKeys?: readonly string[];
  collectionIds?: readonly string[];
  projectId?: string;
  limit?: number;
  /** Forwarded to hybrid only when exact misses. */
  hybrid?: Omit<SearchCorpusCall, "context" | "accessToken" | "queryText">;
}

export type QueryPlanResult =
  | {
      ok: true;
      lane: "exact";
      originalQuery: string;
      searchedQuery: string;
      hits: ExactHit[];
      evidence: RetrievedChunk[];
      exactSkipped: false;
    }
  | {
      ok: true;
      lane: "hybrid";
      originalQuery: string;
      searchedQuery: string;
      hits: [];
      hybrid: SearchCorpusResult;
      exactSkipped: boolean;
      exactSkipReason?: string;
    }
  | {
      ok: false;
      originalQuery: string;
      searchedQuery: string;
      exact: ExactLookupResult;
      exactSkipped: false;
    };

export interface QueryPlanDeps {
  exact: ExactLookupClient;
  hybrid: SearchCorpusClient;
}

function exactHitsToEvidence(hits: ExactHit[]): RetrievedChunk[] {
  return hits.map((hit) => ({
    organisationId: hit.organisationId,
    collectionId: hit.collectionId,
    projectId: hit.projectId,
    sourceId: hit.sourceId,
    sourceVersionId: hit.sourceVersionId,
    chunkId: hit.chunkId,
    chunkIndex: hit.chunkIndex,
    bodyText: hit.bodyText,
    locator: hit.locator,
    dataClass: hit.dataClass,
    contentHash: hit.contentHash,
    publishedAt: hit.publishedAt,
    serviceKey: hit.serviceKey,
    indexGeneration: null,
    lane: null,
    rank: hit.rank,
    lexicalRank: null,
    vectorRank: null,
    exactMatch: true,
    rrfScore: null,
  }));
}

/**
 * Soft exact failures (transport / unwired / retryable) fall through to hybrid so a down exact
 * path is not a dead end. Hard tenancy refusals stop the plan — empty hybrid would hide the deny.
 */
function shouldFallThrough(
  exact: ExactLookupResult,
): exact is Extract<ExactLookupResult, { ok: false }> {
  if (exact.ok) return false;
  switch (exact.refusal.reason) {
    case "unwired":
    case "retryable":
    case "transport":
    case "response_shape":
    case "database":
      return true;
    case "tenancy":
    case "scope_claim":
    case "unauthenticated":
    case "identifier_blank":
    case "identifier_too_long":
    case "limit_out_of_range":
    case "argument_shape":
    case "argument":
      return false;
    default: {
      const _exhaustive: never = exact.refusal.reason;
      void _exhaustive;
      return false;
    }
  }
}

export async function planCorpusQuery(
  input: QueryPlanInput,
  deps: QueryPlanDeps,
): Promise<QueryPlanResult> {
  const originalQuery = input.originalQuery;
  const searchedQuery = input.searchedQuery ?? originalQuery;

  // An ordinary question longer than an identifier can be is not an identifier: skip the exact lane
  // (no RPC call) and search hybrid, instead of failing a question hybrid would accept (2000 chars).
  if (searchedQuery.length > MAX_IDENTIFIER_CHARS) {
    return runHybrid(
      input,
      deps,
      originalQuery,
      searchedQuery,
      "identifier_too_long",
    );
  }

  const exact = await deps.exact.lookup({
    context: input.context,
    accessToken: input.accessToken,
    identifier: searchedQuery,
    serviceKeys: input.serviceKeys,
    collectionIds: input.collectionIds,
    projectId: input.projectId,
    limit: input.limit,
  });

  if (exact.ok && exact.hits.length > 0) {
    return {
      ok: true,
      lane: "exact",
      originalQuery,
      searchedQuery,
      hits: exact.hits,
      evidence: exactHitsToEvidence(exact.hits),
      exactSkipped: false,
    };
  }

  if (!exact.ok && !shouldFallThrough(exact)) {
    return {
      ok: false,
      originalQuery,
      searchedQuery,
      exact,
      exactSkipped: false,
    };
  }

  return runHybrid(
    input,
    deps,
    originalQuery,
    searchedQuery,
    exact.ok ? undefined : exact.refusal.reason,
  );
}

async function runHybrid(
  input: QueryPlanInput,
  deps: QueryPlanDeps,
  originalQuery: string,
  searchedQuery: string,
  exactSkipReason: string | undefined,
): Promise<QueryPlanResult> {
  const exactSkipped = exactSkipReason !== undefined;
  const hybrid = await deps.hybrid.search({
    context: input.context,
    accessToken: input.accessToken,
    queryText: searchedQuery,
    serviceKeys: input.serviceKeys,
    collectionIds: input.collectionIds,
    projectId: input.projectId,
    limit: input.limit,
    ...input.hybrid,
  });

  return {
    ok: true,
    lane: "hybrid",
    originalQuery,
    searchedQuery,
    hits: [],
    hybrid,
    exactSkipped,
    ...(exactSkipReason === undefined ? {} : { exactSkipReason }),
  };
}
