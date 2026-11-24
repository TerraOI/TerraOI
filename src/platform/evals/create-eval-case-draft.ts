import type { TenantContext } from "@/contracts/tenant-context";

import {
  SAFE_TENANT_RPC_MESSAGE,
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

const CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { FetchImpl };

export interface CreateEvalCaseDraftDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

/**
 * Body for `create_eval_case_draft_v1` (`p_body`). Column fields required by the SQL; optional
 * `payload` becomes the jsonb blob stored on the row (defaults to `{}` in SQL when omitted).
 */
export interface CreateEvalCaseDraftPayload {
  caseKey: string;
  expertKey: string;
  origin: string;
  caseType: string;
  question: string;
  dataClass: string;
  draftedBy: string;
  /** ISO date `YYYY-MM-DD` (SQL casts `drafted_on` to date). */
  draftedOn: string;
  payload?: Readonly<Record<string, unknown>>;
}

export type CreateEvalCaseDraftOutcome =
  | { ok: true; caseId: string }
  | { ok: false; reason: TenantRpcFailure["kind"]; employeeMessage: string };

/**
 * Scoped draft insert via `create_eval_case_draft_v1`. Tenant comes only from `TenantContext`
 * through `withTenantRpc`. Status is always `drafted` in SQL; approval is `review_eval_case_v1`.
 */
export async function createEvalCaseDraft(
  context: TenantContext,
  accessToken: string,
  payload: CreateEvalCaseDraftPayload,
  deps: CreateEvalCaseDraftDeps,
): Promise<CreateEvalCaseDraftOutcome> {
  const outcome = await withTenantRpc(
    context,
    "create_eval_case_draft_v1",
    { p_body: toRpcBody(payload) },
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

  const caseId = parseCaseId(outcome.data);
  if (caseId === undefined) {
    return {
      ok: false,
      reason: "backend_failure",
      employeeMessage: SAFE_TENANT_RPC_MESSAGE.backend_failure,
    };
  }

  return { ok: true, caseId };
}

function toRpcBody(payload: CreateEvalCaseDraftPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    case_key: payload.caseKey,
    expert_key: payload.expertKey,
    origin: payload.origin,
    case_type: payload.caseType,
    question: payload.question,
    data_class: payload.dataClass,
    drafted_by: payload.draftedBy,
    drafted_on: payload.draftedOn,
  };
  if (payload.payload !== undefined) {
    body.payload = payload.payload;
  }
  return body;
}

function parseCaseId(data: unknown): string | undefined {
  if (typeof data === "string" && CASE_UUID.test(data)) return data;
  return undefined;
}
