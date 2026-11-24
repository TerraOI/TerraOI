import type { TenantContext } from "@/contracts/tenant-context";

import {
  SAFE_TENANT_RPC_MESSAGE,
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

export type { FetchImpl };

export interface ReviewEvalCaseDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export type ReviewEvalCaseDecision = "approve" | "edit" | "reject";

/** Args for `review_eval_case_v1` besides `p_organisation_id` (injected by withTenantRpc). */
export interface ReviewEvalCaseInput {
  caseId: string;
  decision: ReviewEvalCaseDecision;
  /** Optional review edits jsonb; SQL coalesces null to `{}`. */
  edits?: Readonly<Record<string, unknown>> | null;
}

export type ReviewEvalCaseOutcome =
  | { ok: true }
  | { ok: false; reason: TenantRpcFailure["kind"]; employeeMessage: string };

/**
 * Scoped review via `review_eval_case_v1` (#82). Tenant comes only from `TenantContext` through
 * `withTenantRpc`. SQL enforces non-author + `evals.review` write; this client fails closed on
 * transport/tenancy and never invents success from a malformed response.
 */
export async function reviewEvalCase(
  context: TenantContext,
  accessToken: string,
  input: ReviewEvalCaseInput,
  deps: ReviewEvalCaseDeps,
): Promise<ReviewEvalCaseOutcome> {
  const outcome = await withTenantRpc(
    context,
    "review_eval_case_v1",
    {
      p_case_id: input.caseId,
      p_decision: input.decision,
      p_edits: input.edits ?? {},
    },
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

  // Void RPC: PostgREST returns 204/null. Any other payload shape is treated as failure.
  if (outcome.data !== null && outcome.data !== undefined) {
    return {
      ok: false,
      reason: "backend_failure",
      employeeMessage: SAFE_TENANT_RPC_MESSAGE.backend_failure,
    };
  }

  return { ok: true };
}
