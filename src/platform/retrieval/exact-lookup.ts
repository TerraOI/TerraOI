import { z } from "zod";

import { DataClass, maxDataClass } from "@/contracts/data-class";
import type { TenantContext } from "@/contracts/tenant-context";
import {
  withTenantRpc,
  type BackendFailureReason,
  type FetchImpl,
  type TenantRpcArgs,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

/**
 * T-216 PR-2: typed caller of `public.exact_lookup_v1` (plan §8.1 step 4).
 * Deterministic identifier match before hybrid search. Same tenancy rules as search-corpus.ts.
 */

export const MAX_IDENTIFIER_CHARS = 200;
export const MIN_EXACT_LIMIT = 1;
export const MAX_EXACT_LIMIT = 25;
export const DEFAULT_EXACT_LIMIT = 12;
export const MAX_EXACT_REFUSAL_DETAIL = 300;

export interface ExactLookupDeps {
  postgrestBaseUrl?: string;
  dataApiBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export interface ExactLookupCall {
  context: TenantContext;
  accessToken: string;
  identifier: string;
  serviceKeys?: readonly string[];
  collectionIds?: readonly string[];
  projectId?: string;
  limit?: number;
}

export type ExactMatchKind = "body_phrase" | "filename" | "provision" | "equipment_model";

export interface ExactHit {
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
  matchKind: ExactMatchKind;
  rank: number;
}

export type ExactLookupRefusalReason =
  | "unwired"
  | "identifier_blank"
  | "identifier_too_long"
  | "limit_out_of_range"
  | "argument_shape"
  | "tenancy"
  | "scope_claim"
  | "argument"
  | "unauthenticated"
  | "retryable"
  | "transport"
  | "response_shape"
  | "database";

export interface ExactLookupRefusal {
  origin: "local" | "database" | "transport";
  reason: ExactLookupRefusalReason;
  sqlState: string | null;
  detail: string;
  reachedDatabase: boolean;
}

export type ExactLookupResult =
  | { ok: true; hits: ExactHit[]; dataClass: DataClass | null }
  | { ok: false; status: "backend_failure"; refusal: ExactLookupRefusal };

export interface ExactLookupClient {
  lookup(call: ExactLookupCall): Promise<ExactLookupResult>;
}

const Int = z.number().int();
const JsonObject = z.looseObject({}).transform((value) => value as Record<string, unknown>);

const HitRow = z.looseObject({
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
  o_match_kind: z.enum(["body_phrase", "filename", "provision", "equipment_model"]),
  o_rank: Int,
});

const REFUSAL_DETAIL: Record<ExactLookupRefusalReason, string> = {
  unwired: "exact lookup client is not configured for this deployment",
  identifier_blank: "identifier must not be blank",
  identifier_too_long: `identifier exceeds ${MAX_IDENTIFIER_CHARS} characters`,
  limit_out_of_range: `p_limit must be between ${MIN_EXACT_LIMIT} and ${MAX_EXACT_LIMIT}`,
  argument_shape: "one or more call arguments have the wrong shape",
  tenancy: "tenant scope refused this caller",
  scope_claim: "caller is not allowed to claim this resource in the current scope",
  argument: "the database refused an argument",
  unauthenticated: "no usable user access token for this request (ADR-0003 §7)",
  retryable: "the Data API is temporarily unavailable",
  transport: "the Data API request did not complete",
  response_shape: "the RPC returned a body that does not match its contract",
  database: "the database refused the exact lookup",
};

function bound(detail: string): string {
  return detail.length <= MAX_EXACT_REFUSAL_DETAIL
    ? detail
    : `${detail.slice(0, MAX_EXACT_REFUSAL_DETAIL - 1)}…`;
}

function detailFor(reason: ExactLookupRefusalReason, sqlState: string | null = null): string {
  const base = REFUSAL_DETAIL[reason];
  return bound(sqlState === null ? base : `${base} (${sqlState})`);
}

function refusal(
  reason: ExactLookupRefusalReason,
  options: { origin?: ExactLookupRefusal["origin"]; sqlState?: string | null; detail?: string } = {},
): ExactLookupResult {
  const origin = options.origin ?? "local";
  const sqlState = options.sqlState ?? null;
  return {
    ok: false,
    status: "backend_failure",
    refusal: {
      origin,
      reason,
      sqlState,
      detail: options.detail ?? detailFor(reason, sqlState),
      reachedDatabase: origin !== "local",
    },
  };
}

function mapBackendFailure(reason: BackendFailureReason): ExactLookupResult {
  switch (reason) {
    case "transport":
      return refusal("transport", { origin: "transport" });
    case "timeout":
      return refusal("retryable", { origin: "transport" });
    case "server_error":
      return refusal("retryable", { origin: "database" });
    case "rejected":
      return refusal("database", { origin: "database" });
    case "invalid_response":
      return refusal("response_shape", { origin: "database" });
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return refusal("database", { origin: "database" });
    }
  }
}

function mapTenantRpcFailure(failure: TenantRpcFailure): ExactLookupResult {
  if (failure.kind === "tenancy") {
    const reason: ExactLookupRefusalReason =
      failure.sqlstate === "42501" ? "scope_claim" : "tenancy";
    return refusal(reason, { origin: "database", sqlState: failure.sqlstate });
  }
  if (failure.kind === "not_configured") {
    const reason: ExactLookupRefusalReason =
      failure.reason === "access_token_unbound" || failure.reason === "access_token_invalid"
        ? "unauthenticated"
        : "unwired";
    return refusal(reason, { origin: "local" });
  }
  return mapBackendFailure(failure.reason);
}

type RpcArgs = TenantRpcArgs & {
  p_service_keys: string[];
  p_project_id: string | null;
  p_collection_ids: string[] | null;
  p_identifier: string;
  p_limit: number;
};

function validate(call: ExactLookupCall): { args: RpcArgs } | { refusal: ExactLookupResult } {
  const identifier = typeof call.identifier === "string" ? call.identifier : "";
  if (identifier.trim().length === 0) {
    return { refusal: refusal("identifier_blank") };
  }
  if (identifier.length > MAX_IDENTIFIER_CHARS) {
    return { refusal: refusal("identifier_too_long") };
  }
  const limit = call.limit ?? DEFAULT_EXACT_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_EXACT_LIMIT || limit > MAX_EXACT_LIMIT) {
    return { refusal: refusal("limit_out_of_range") };
  }
  const isUuid = (value: unknown) => z.uuid().safeParse(value).success;
  const serviceKeys = call.serviceKeys ?? [];
  if (
    !Array.isArray(serviceKeys) ||
    serviceKeys.some((key) => !z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).safeParse(key).success)
  ) {
    return { refusal: refusal("argument_shape") };
  }
  if (call.collectionIds !== undefined) {
    if (!Array.isArray(call.collectionIds) || call.collectionIds.some((id) => !isUuid(id))) {
      return { refusal: refusal("argument_shape") };
    }
  }
  if (call.projectId !== undefined && !isUuid(call.projectId)) {
    return { refusal: refusal("argument_shape") };
  }
  return {
    args: {
      p_service_keys: [...serviceKeys],
      p_project_id: call.projectId ?? null,
      p_collection_ids: call.collectionIds === undefined ? null : [...call.collectionIds],
      p_identifier: identifier,
      p_limit: limit,
    },
  };
}

function resolvePostgrestBase(deps: ExactLookupDeps): string | undefined {
  const preferred = typeof deps.postgrestBaseUrl === "string" ? deps.postgrestBaseUrl.trim() : "";
  if (preferred.length > 0) return preferred;
  const legacy = typeof deps.dataApiBaseUrl === "string" ? deps.dataApiBaseUrl.trim() : "";
  return legacy.length > 0 ? legacy : undefined;
}

export function createExactLookupClient(deps: ExactLookupDeps): ExactLookupClient {
  const postgrestBaseUrl = resolvePostgrestBase(deps);
  if (postgrestBaseUrl === undefined) {
    return {
      lookup: async () => refusal("unwired"),
    };
  }
  const fetchImpl = deps.fetchImpl;

  return {
    lookup: async (call: ExactLookupCall): Promise<ExactLookupResult> => {
      const checked = validate(call);
      if ("refusal" in checked) return checked.refusal;

      const outcome = await withTenantRpc(call.context, "exact_lookup_v1", checked.args, call.accessToken, {
        postgrestBaseUrl,
        fetchImpl,
      });
      if (!outcome.ok) return mapTenantRpcFailure(outcome);

      const payload = outcome.data;
      if (!Array.isArray(payload)) {
        return refusal("response_shape", { origin: "database", detail: "expected a row array" });
      }
      if (payload.length === 0) {
        return { ok: true, hits: [], dataClass: null };
      }

      const hits: ExactHit[] = [];
      for (const row of payload) {
        const parsed = HitRow.safeParse(row);
        if (!parsed.success) {
          return refusal("response_shape", {
            origin: "database",
            detail: "an exact-lookup row is missing a column or carries an unknown class",
          });
        }
        hits.push({
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
          matchKind: parsed.data.o_match_kind,
          rank: parsed.data.o_rank,
        });
      }
      return {
        ok: true,
        hits,
        dataClass: maxDataClass(hits.map((hit) => hit.dataClass)),
      };
    },
  };
}
