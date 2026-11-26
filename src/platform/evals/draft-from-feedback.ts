import type { TenantContext } from "@/contracts/tenant-context";

import {
  SAFE_TENANT_RPC_MESSAGE,
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

const CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { FetchImpl };

export interface DraftEvalCaseFromFeedbackDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

/** Rating values accepted by `draft_eval_case_from_feedback_v1` (#102). */
export type FeedbackDraftRating = "incorrect" | "suggest_correction";

/**
 * Body for `draft_eval_case_from_feedback_v1` (`p_body`). Column fields required by the SQL;
 * optional `caseType` defaults to `must_refuse` in SQL; optional `payload` defaults to `{}`.
 */
export interface DraftEvalCaseFromFeedbackPayload {
  expertKey: string;
  question: string;
  /**
   * The caller's label. Since round 1 on #254 the RPC stores the highest of this, the rated run's class
   * and the conversation's: a lower label is raised, never trusted (§6.2).
   */
  dataClass: string;
  rating: FeedbackDraftRating;
  derivedFromRunId: string;
  derivedFromMessageId: string;
  caseType?: string;
  payload?: Readonly<Record<string, unknown>>;
}

export type DraftEvalCaseFromFeedbackOutcome =
  | { ok: true; caseId: string }
  | { ok: false; reason: TenantRpcFailure["kind"]; employeeMessage: string };

/**
 * Scoped pilot draft via `draft_eval_case_from_feedback_v1` (#102). Tenant comes only from
 * `TenantContext` through `withTenantRpc`. Always creates `origin = 'pilot'` drafted rows in SQL;
 * T-302 caller wire-up is out of scope for this client.
 */
export async function draftEvalCaseFromFeedback(
  context: TenantContext,
  accessToken: string,
  payload: DraftEvalCaseFromFeedbackPayload,
  deps: DraftEvalCaseFromFeedbackDeps,
): Promise<DraftEvalCaseFromFeedbackOutcome> {
  const outcome = await withTenantRpc(
    context,
    "draft_eval_case_from_feedback_v1",
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

function toRpcBody(payload: DraftEvalCaseFromFeedbackPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    expert_key: payload.expertKey,
    question: payload.question,
    data_class: payload.dataClass,
    rating: payload.rating,
    derived_from_run_id: payload.derivedFromRunId,
    derived_from_message_id: payload.derivedFromMessageId,
  };
  if (payload.caseType !== undefined) {
    body.case_type = payload.caseType;
  }
  if (payload.payload !== undefined) {
    body.payload = payload.payload;
  }
  return body;
}

function parseCaseId(data: unknown): string | undefined {
  if (typeof data === "string" && CASE_UUID.test(data)) return data;
  return undefined;
}
