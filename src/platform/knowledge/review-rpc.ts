import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";
import {
  withTenantRpc,
  type BackendFailureReason,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

/**
 * Typed client for T-213 review/publish/revoke/reclass RPCs (F13/F14/#21, FAQ-0011, plan §7.2 steps 7–9).
 *
 * Every call goes through `withTenantRpc`: `p_organisation_id` comes only from `TenantContext`.
 * PostgREST bodies never reach employee copy.
 */

const UUID = z.uuid();
const DECISION = z.enum(["approve", "reject"]);
/** `review_decisions.reason` and `source_versions.failure_note` both check 1..500 characters. */
export const MAX_REVIEW_REASON_CHARS = 500;
const REASON = z.string().trim().min(1).max(MAX_REVIEW_REASON_CHARS);
/** M1-ingestible raise targets only; `restricted` is refused at the client (mirrors SQL #21). */
const RECLASS_DATA_CLASS = z.enum(["public", "internal", "client_confidential"]);

/** Mirrors `review_reclass_v1` SQL refusal for restricted (#21 / 23514). */
export const RESTRICTED_RECLASS_MESSAGE =
  "raising to restricted is refused in M1; revoke the sources instead";

export interface ReviewRpcDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export type ReviewRpcFailureKind =
  | "validation"
  | "tenancy"
  | "constraint"
  | "rejected"
  | "backend_failure"
  | "not_configured";

export interface ReviewRpcFailure {
  ok: false;
  kind: ReviewRpcFailureKind;
  message: string;
}

export type ReviewVoidOutcome = { ok: true } | ReviewRpcFailure;
export type ReviewIdOutcome = { ok: true; id: string } | ReviewRpcFailure;

/** Fixed employee-safe messages: no SQLSTATE, table, host or tenant name. */
export const SAFE_REVIEW_RPC_MESSAGE: Record<ReviewRpcFailureKind, string> = {
  validation: "Check the fields and try again.",
  tenancy:
    "You do not have permission to perform this action in this workspace.",
  constraint:
    "That change could not be applied. The target may not exist in this workspace.",
  rejected: "The change could not be applied. It may already have been made.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};

function mapBackendFailure(reason: BackendFailureReason): ReviewRpcFailure {
  switch (reason) {
    case "rejected":
      return {
        ok: false,
        kind: "rejected",
        message: SAFE_REVIEW_RPC_MESSAGE.rejected,
      };
    case "transport":
    case "timeout":
    case "server_error":
    case "invalid_response":
      return {
        ok: false,
        kind: "backend_failure",
        message: SAFE_REVIEW_RPC_MESSAGE.backend_failure,
      };
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return {
        ok: false,
        kind: "backend_failure",
        message: SAFE_REVIEW_RPC_MESSAGE.backend_failure,
      };
    }
  }
}

function mapTenantRpcFailure(failure: TenantRpcFailure): ReviewRpcFailure {
  switch (failure.kind) {
    case "tenancy":
      return {
        ok: false,
        kind: "tenancy",
        message: SAFE_REVIEW_RPC_MESSAGE.tenancy,
      };
    case "not_configured":
      return {
        ok: false,
        kind: "not_configured",
        message: SAFE_REVIEW_RPC_MESSAGE.not_configured,
      };
    case "backend_failure":
      return mapBackendFailure(failure.reason);
    default: {
      const _exhaustive: never = failure;
      void _exhaustive;
      return {
        ok: false,
        kind: "backend_failure",
        message: SAFE_REVIEW_RPC_MESSAGE.backend_failure,
      };
    }
  }
}

function parseUuidReturn(data: unknown): ReviewIdOutcome {
  const parsed = UUID.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "backend_failure",
      message: SAFE_REVIEW_RPC_MESSAGE.backend_failure,
    };
  }
  return { ok: true, id: parsed.data };
}

export interface ReviewDecisionInput {
  context: TenantContext;
  accessToken: string;
  sourceVersionId: string;
  decision: "approve" | "reject";
  reason?: string | null;
}

export interface PublishVersionInput {
  context: TenantContext;
  accessToken: string;
  sourceVersionId: string;
}

export interface RevokeSourceInput {
  context: TenantContext;
  accessToken: string;
  sourceId: string;
  reason?: string | null;
}

export interface ReclassCollectionInput {
  context: TenantContext;
  accessToken: string;
  collectionId: string;
  /** Runtime-validated; `restricted` is refused client-side with the SQL message. */
  newDataClass: string;
}

export interface ReviewRpcClient {
  reviewDecision(input: ReviewDecisionInput): Promise<ReviewIdOutcome>;
  publishKnowledgeVersion(input: PublishVersionInput): Promise<ReviewIdOutcome>;
  revokeSource(input: RevokeSourceInput): Promise<ReviewVoidOutcome>;
  reclassCollection(input: ReclassCollectionInput): Promise<ReviewIdOutcome>;
}

export function createReviewRpcClient(deps: ReviewRpcDeps): ReviewRpcClient {
  const config = {
    postgrestBaseUrl: deps.postgrestBaseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };

  return {
    async reviewDecision(input) {
      if (
        !UUID.safeParse(input.sourceVersionId).success ||
        !DECISION.safeParse(input.decision).success
      ) {
        return {
          ok: false,
          kind: "validation",
          message: SAFE_REVIEW_RPC_MESSAGE.validation,
        };
      }
      const reason =
        input.reason === undefined ||
        input.reason === null ||
        input.reason === ""
          ? undefined
          : REASON.safeParse(input.reason);
      if (reason !== undefined && !reason.success) {
        return {
          ok: false,
          kind: "validation",
          message: SAFE_REVIEW_RPC_MESSAGE.validation,
        };
      }
      const outcome = await withTenantRpc(
        input.context,
        "review_decision_v1",
        {
          p_source_version_id: input.sourceVersionId,
          p_decision: input.decision,
          ...(reason === undefined ? {} : { p_reason: reason.data }),
        },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure(outcome);
      return parseUuidReturn(outcome.data);
    },

    async publishKnowledgeVersion(input) {
      if (!UUID.safeParse(input.sourceVersionId).success) {
        return {
          ok: false,
          kind: "validation",
          message: SAFE_REVIEW_RPC_MESSAGE.validation,
        };
      }
      const outcome = await withTenantRpc(
        input.context,
        "publish_knowledge_version_v1",
        { p_source_version_id: input.sourceVersionId },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure(outcome);
      return parseUuidReturn(outcome.data);
    },

    async revokeSource(input) {
      if (!UUID.safeParse(input.sourceId).success) {
        return {
          ok: false,
          kind: "validation",
          message: SAFE_REVIEW_RPC_MESSAGE.validation,
        };
      }
      const reason =
        input.reason === undefined ||
        input.reason === null ||
        input.reason === ""
          ? undefined
          : REASON.safeParse(input.reason);
      if (reason !== undefined && !reason.success) {
        return {
          ok: false,
          kind: "validation",
          message: SAFE_REVIEW_RPC_MESSAGE.validation,
        };
      }
      const outcome = await withTenantRpc(
        input.context,
        "revoke_source_v1",
        {
          p_source_id: input.sourceId,
          ...(reason === undefined ? {} : { p_reason: reason.data }),
        },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure(outcome);
      return { ok: true };
    },

    async reclassCollection(input) {
      if (!UUID.safeParse(input.collectionId).success) {
        return { ok: false, kind: "validation", message: SAFE_REVIEW_RPC_MESSAGE.validation };
      }
      // Refuse restricted before the enum parse so the message mirrors SQL (#21).
      if (input.newDataClass === "restricted") {
        return { ok: false, kind: "validation", message: RESTRICTED_RECLASS_MESSAGE };
      }
      const dataClass = RECLASS_DATA_CLASS.safeParse(input.newDataClass);
      if (!dataClass.success) {
        return { ok: false, kind: "validation", message: SAFE_REVIEW_RPC_MESSAGE.validation };
      }
      const outcome = await withTenantRpc(
        input.context,
        "review_reclass_v1",
        {
          p_collection_id: input.collectionId,
          p_new_data_class: dataClass.data,
        },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure(outcome);
      return parseUuidReturn(outcome.data);
    },
  };
}
