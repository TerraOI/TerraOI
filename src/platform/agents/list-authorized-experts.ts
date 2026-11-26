import type { TenantContext } from "@/contracts/tenant-context";

import {
  SAFE_TENANT_RPC_MESSAGE,
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

import type { RouteCandidate } from "./route-expert";

export type { FetchImpl };

export interface ListAuthorizedExpertsDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

/**
 * Routing-safe projection of an entitled expert (#221 N1).
 * Deliberately excludes `model_chains` (#143 B8) and `collection_bindings`
 * (project-only collection ids must not reach ordinary members).
 */
export interface ListedAuthorizedExpert {
  expertKey: string;
  expertVersion: string;
  serviceKey: string;
  status: string;
}

export type ListAuthorizedExpertsOutcome =
  | { ok: true; experts: ReadonlyArray<ListedAuthorizedExpert> }
  | { ok: false; reason: TenantRpcFailure["kind"]; employeeMessage: string };

/**
 * Maps listed experts into F29 route candidates. Withdrawn releases are never suggested.
 * Registered and published both remain candidates so Auto can route before F36 publication.
 */
export function toRouteCandidates(
  rows: ReadonlyArray<ListedAuthorizedExpert>,
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  for (const row of rows) {
    if (row.status === "withdrawn") continue;
    candidates.push({ expertKey: row.expertKey, serviceKey: row.serviceKey });
  }
  return candidates;
}

/**
 * Scoped list via `list_authorized_experts_v1` (T-311 #221 N1).
 * Tenant comes only from `TenantContext` through `withTenantRpc` (FAQ-0011).
 */
export async function listAuthorizedExperts(
  context: TenantContext,
  accessToken: string,
  deps: ListAuthorizedExpertsDeps,
): Promise<ListAuthorizedExpertsOutcome> {
  const outcome = await withTenantRpc(context, "list_authorized_experts_v1", {}, accessToken, {
    postgrestBaseUrl: deps.postgrestBaseUrl,
    fetchImpl: deps.fetchImpl,
  });

  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.kind,
      employeeMessage: SAFE_TENANT_RPC_MESSAGE[outcome.kind],
    };
  }

  const experts = parseListedExperts(outcome.data);
  if (experts === undefined) {
    return {
      ok: false,
      reason: "backend_failure",
      employeeMessage: SAFE_TENANT_RPC_MESSAGE.backend_failure,
    };
  }

  return { ok: true, experts };
}

function parseListedExperts(data: unknown): ListedAuthorizedExpert[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const experts: ListedAuthorizedExpert[] = [];
  for (const item of data) {
    const row = parseListedExpert(item);
    if (row === undefined) return undefined;
    experts.push(row);
  }
  return experts;
}

function parseListedExpert(item: unknown): ListedAuthorizedExpert | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const raw = item as Record<string, unknown>;
  const expertKey = raw.expert_key;
  const expertVersion = raw.expert_version;
  const serviceKey = raw.service_key;
  const status = raw.status;
  if (typeof expertKey !== "string" || expertKey.length === 0) return undefined;
  if (typeof expertVersion !== "string" || expertVersion.length === 0) return undefined;
  if (typeof serviceKey !== "string" || serviceKey.length === 0) return undefined;
  if (typeof status !== "string" || status.length === 0) return undefined;
  // Only the four routing fields — never promote model_chains or collection_bindings.
  return { expertKey, expertVersion, serviceKey, status };
}
