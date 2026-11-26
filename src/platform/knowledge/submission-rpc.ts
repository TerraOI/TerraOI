import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";
import {
  CreateKnowledgeSubmissionRequest,
  ReviewKnowledgeSubmissionRequest,
  type KnowledgeSubmissionKind,
} from "@/contracts/knowledge-submission";
import {
  withTenantRpc,
  type BackendFailureReason,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

/**
 * Typed client for T-302b F15 RPCs (FAQ-0011, ADR-0013).
 *
 * Every call goes through `withTenantRpc`: `p_organisation_id` comes only from `TenantContext`.
 */

const UUID = z.uuid();

export interface SubmissionRpcDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export type SubmissionRpcFailureKind =
  | "validation"
  | "tenancy"
  | "constraint"
  | "rejected"
  | "backend_failure"
  | "not_configured";

export interface SubmissionRpcFailure {
  ok: false;
  kind: SubmissionRpcFailureKind;
  message: string;
}

export type SubmissionIdOutcome = { ok: true; id: string } | SubmissionRpcFailure;

export const SAFE_SUBMISSION_RPC_MESSAGE: Record<SubmissionRpcFailureKind, string> = {
  validation: "Check the fields and try again.",
  tenancy: "You do not have permission to perform this action in this workspace.",
  constraint: "That change could not be applied. The target may not exist in this workspace.",
  rejected: "The change could not be applied. It may already have been made.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};

function mapBackendFailure(reason: BackendFailureReason): SubmissionRpcFailure {
  switch (reason) {
    case "rejected":
      return { ok: false, kind: "rejected", message: SAFE_SUBMISSION_RPC_MESSAGE.rejected };
    case "transport":
    case "timeout":
    case "server_error":
    case "invalid_response":
      return { ok: false, kind: "backend_failure", message: SAFE_SUBMISSION_RPC_MESSAGE.backend_failure };
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_SUBMISSION_RPC_MESSAGE.backend_failure };
    }
  }
}

function mapTenantRpcFailure(failure: TenantRpcFailure): SubmissionRpcFailure {
  switch (failure.kind) {
    case "tenancy":
      return { ok: false, kind: "tenancy", message: SAFE_SUBMISSION_RPC_MESSAGE.tenancy };
    case "not_configured":
      return { ok: false, kind: "not_configured", message: SAFE_SUBMISSION_RPC_MESSAGE.not_configured };
    case "backend_failure":
      return mapBackendFailure(failure.reason);
    default: {
      const _exhaustive: never = failure;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_SUBMISSION_RPC_MESSAGE.backend_failure };
    }
  }
}

function parseUuidReturn(data: unknown): SubmissionIdOutcome {
  const parsed = UUID.safeParse(data);
  if (!parsed.success) {
    return { ok: false, kind: "backend_failure", message: SAFE_SUBMISSION_RPC_MESSAGE.backend_failure };
  }
  return { ok: true, id: parsed.data };
}

export interface SubmitKnowledgeInput {
  context: TenantContext;
  accessToken: string;
  collectionId: string;
  kind: KnowledgeSubmissionKind;
  proposedText: string;
  contextDataClass: string;
  citedSourceVersionIds?: string[];
  agentRunId?: string | null;
  reviewBy?: string | null;
}

export interface ReviewSubmissionInput {
  context: TenantContext;
  accessToken: string;
  submissionId: string;
  decision: "approve" | "reject";
  reason?: string | null;
}

export interface WithdrawSubmissionInput {
  context: TenantContext;
  accessToken: string;
  submissionId: string;
}

export interface SubmissionRpcClient {
  submit(input: SubmitKnowledgeInput): Promise<SubmissionIdOutcome>;
  review(input: ReviewSubmissionInput): Promise<SubmissionIdOutcome>;
  withdraw(input: WithdrawSubmissionInput): Promise<SubmissionIdOutcome>;
}

export function createSubmissionRpcClient(deps: SubmissionRpcDeps): SubmissionRpcClient {
  const config = {
    postgrestBaseUrl: deps.postgrestBaseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };

  return {
    async submit(input) {
      const parsed = CreateKnowledgeSubmissionRequest.safeParse({
        collectionId: input.collectionId,
        kind: input.kind,
        proposedText: input.proposedText,
        contextDataClass: input.contextDataClass,
        citedSourceVersionIds: input.citedSourceVersionIds ?? [],
        ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
        ...(input.reviewBy ? { reviewBy: input.reviewBy } : {}),
      });
      if (!parsed.success) {
        return { ok: false, kind: "validation", message: SAFE_SUBMISSION_RPC_MESSAGE.validation };
      }
      const outcome = await withTenantRpc(
        input.context,
        "submit_employee_knowledge_v1",
        {
          p_collection_id: parsed.data.collectionId,
          p_kind: parsed.data.kind,
          p_proposed_text: parsed.data.proposedText,
          p_context_data_class: parsed.data.contextDataClass,
          p_cited_source_version_ids: parsed.data.citedSourceVersionIds,
          ...(parsed.data.agentRunId === undefined ? {} : { p_agent_run_id: parsed.data.agentRunId }),
          ...(parsed.data.reviewBy === undefined ? {} : { p_review_by: parsed.data.reviewBy }),
        },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure(outcome);
      return parseUuidReturn(outcome.data);
    },

    async review(input) {
      if (!UUID.safeParse(input.submissionId).success) {
        return { ok: false, kind: "validation", message: SAFE_SUBMISSION_RPC_MESSAGE.validation };
      }
      const parsed = ReviewKnowledgeSubmissionRequest.safeParse({
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (!parsed.success) {
        return { ok: false, kind: "validation", message: SAFE_SUBMISSION_RPC_MESSAGE.validation };
      }
      const outcome = await withTenantRpc(
        input.context,
        "review_knowledge_submission_v1",
        {
          p_submission_id: input.submissionId,
          p_decision: parsed.data.decision,
          ...(parsed.data.reason === undefined ? {} : { p_reason: parsed.data.reason }),
        },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure(outcome);
      return parseUuidReturn(outcome.data);
    },

    async withdraw(input) {
      if (!UUID.safeParse(input.submissionId).success) {
        return { ok: false, kind: "validation", message: SAFE_SUBMISSION_RPC_MESSAGE.validation };
      }
      const outcome = await withTenantRpc(
        input.context,
        "withdraw_knowledge_submission_v1",
        { p_submission_id: input.submissionId },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure(outcome);
      return parseUuidReturn(outcome.data);
    },
  };
}
