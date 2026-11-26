import type { TenantContext } from "@/contracts/tenant-context";

import {
  SAFE_TENANT_RPC_MESSAGE,
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

export type { FetchImpl };

export interface ListEvalCasesDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

/** Minimal fields needed to build `caseIdToUuid` and identify scored rows. */
export interface ListedEvalCase {
  id: string;
  caseKey: string;
  expertKey: string;
  status: string;
}

export type ListEvalCasesOutcome =
  | { ok: true; cases: ReadonlyArray<ListedEvalCase> }
  | { ok: false; reason: TenantRpcFailure["kind"]; employeeMessage: string };

/**
 * Builds fixture `case_key` → database `id` from a list result.
 * First-wins on duplicate keys (stable order from `list_eval_cases_v1`: expert_key, case_key, id).
 * Empty / whitespace-only keys are rejected (skipped) so they cannot invent map entries.
 */
export function caseIdToUuidFromList(
  rows: ReadonlyArray<Pick<ListedEvalCase, "id" | "caseKey">>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = row.caseKey.trim();
    if (key.length === 0) continue;
    if (map[key] !== undefined) continue;
    map[key] = row.id;
  }
  return map;
}

/**
 * Scoped list via `list_eval_cases_v1`. Tenant comes only from `TenantContext` through
 * `withTenantRpc`. Pass `status: "approved"` for the F35 scored set (F35 ignores unapproved).
 */
export async function listEvalCases(
  context: TenantContext,
  accessToken: string,
  status: string | null,
  deps: ListEvalCasesDeps,
): Promise<ListEvalCasesOutcome> {
  const outcome = await withTenantRpc(
    context,
    "list_eval_cases_v1",
    { p_status: status },
    accessToken,
    { postgrestBaseUrl: deps.postgrestBaseUrl, fetchImpl: deps.fetchImpl },
  );

  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.kind,
      employeeMessage: SAFE_TENANT_RPC_MESSAGE[outcome.kind],
    };
  }

  const cases = parseListedCases(outcome.data);
  if (cases === undefined) {
    return {
      ok: false,
      reason: "backend_failure",
      employeeMessage: SAFE_TENANT_RPC_MESSAGE.backend_failure,
    };
  }

  return { ok: true, cases };
}

function parseListedCases(data: unknown): ListedEvalCase[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const cases: ListedEvalCase[] = [];
  for (const item of data) {
    const row = parseListedCase(item);
    if (row === undefined) return undefined;
    cases.push(row);
  }
  return cases;
}

function parseListedCase(item: unknown): ListedEvalCase | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const raw = item as Record<string, unknown>;
  const id = raw.id;
  const caseKey = raw.case_key;
  const expertKey = raw.expert_key;
  const status = raw.status;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof caseKey !== "string") return undefined;
  if (typeof expertKey !== "string" || expertKey.length === 0) return undefined;
  if (typeof status !== "string" || status.length === 0) return undefined;
  return { id, caseKey, expertKey, status };
}
