import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";
import {
  withTenantRpc,
  type BackendFailureReason,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

/**
 * Shared source-access decision client (T-214 PR-1, F08 minimal).
 *
 * Citation and history paths call the same RPC in later packets; this module is the only TypeScript
 * dial. Organisation id comes only from `TenantContext` via `withTenantRpc` (FAQ-0011).
 */

const UUID = z.uuid();
const PURPOSE = z.enum(["retrieve", "cite", "history", "download"]);

export type AuthorizeSourcePurpose = z.infer<typeof PURPOSE>;

export interface SourceAclDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export type SourceAclFailureKind =
  | "validation"
  | "tenancy"
  | "backend_failure"
  | "not_configured";

export interface SourceAclFailure {
  ok: false;
  kind: SourceAclFailureKind;
  message: string;
}

export type AuthorizeSourceAccessOutcome =
  | { ok: true; authorized: boolean }
  | SourceAclFailure;

/** Fixed employee-safe messages: no SQLSTATE, table, host or tenant name. */
export const SAFE_SOURCE_ACL_MESSAGE: Record<SourceAclFailureKind, string> = {
  validation: "Check the fields and try again.",
  tenancy: "You do not have permission to perform this action in this workspace.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};

function mapBackendFailure(reason: BackendFailureReason): SourceAclFailure {
  switch (reason) {
    case "rejected":
    case "transport":
    case "timeout":
    case "server_error":
    case "invalid_response":
      return { ok: false, kind: "backend_failure", message: SAFE_SOURCE_ACL_MESSAGE.backend_failure };
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_SOURCE_ACL_MESSAGE.backend_failure };
    }
  }
}

function mapTenantRpcFailure(failure: TenantRpcFailure): SourceAclFailure {
  switch (failure.kind) {
    case "tenancy":
      return { ok: false, kind: "tenancy", message: SAFE_SOURCE_ACL_MESSAGE.tenancy };
    case "not_configured":
      return { ok: false, kind: "not_configured", message: SAFE_SOURCE_ACL_MESSAGE.not_configured };
    case "backend_failure":
      return mapBackendFailure(failure.reason);
    default: {
      const _exhaustive: never = failure;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_SOURCE_ACL_MESSAGE.backend_failure };
    }
  }
}

function parseBooleanReturn(data: unknown): AuthorizeSourceAccessOutcome {
  if (data === true || data === false) {
    return { ok: true, authorized: data };
  }
  return { ok: false, kind: "backend_failure", message: SAFE_SOURCE_ACL_MESSAGE.backend_failure };
}

export interface AuthorizeSourceAccessInput {
  context: TenantContext;
  accessToken: string;
  sourceId: string;
  purpose: AuthorizeSourcePurpose;
}

export async function authorizeSourceAccess(
  input: AuthorizeSourceAccessInput,
  deps?: SourceAclDeps,
): Promise<AuthorizeSourceAccessOutcome> {
  if (!UUID.safeParse(input.sourceId).success || !PURPOSE.safeParse(input.purpose).success) {
    return { ok: false, kind: "validation", message: SAFE_SOURCE_ACL_MESSAGE.validation };
  }

  const config = {
    postgrestBaseUrl: deps?.postgrestBaseUrl,
    ...(deps?.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };

  const outcome = await withTenantRpc(
    input.context,
    "authorize_source_access_v1",
    {
      p_source_id: input.sourceId,
      p_purpose: input.purpose,
    },
    input.accessToken,
    config,
  );

  if (!outcome.ok) return mapTenantRpcFailure(outcome);
  return parseBooleanReturn(outcome.data);
}