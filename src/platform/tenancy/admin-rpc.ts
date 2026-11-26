import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";
import { canonicalEmail } from "@/platform/identity/email";
import {
  withTenantRpc,
  type BackendFailureReason,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

/**
 * Typed client for the T-202 tenant-admin RPCs (FAQ-0011, plan §4.2 / §15.0).
 *
 * Every call goes through `withTenantRpc`: `p_organisation_id` comes only from `TenantContext`.
 * No page may pass an organisation id (#163). PostgREST bodies never reach employee copy.
 */

const UUID = z.uuid();
const PROJECT_KEY = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const PROJECT_NAME = z.string().trim().min(1).max(200);
const PROJECT_VISIBILITY = z.enum(["organisation", "project"]);
const COLLECTION_KEY = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const COLLECTION_NAME = z.string().trim().min(1).max(200);
const DATA_CLASS = z.enum(["public", "internal", "client_confidential"]);
const COLLECTION_SERVICE = z.string().trim().min(1).max(64);

/**
 * `23514` is a plain check_violation. Only the revoke RPC raises it to mean "this would remove the
 * last admin" (#202 / FAQ-0014); for every other RPC it is an ordinary refused value.
 */
const LAST_ADMIN_RPCS: ReadonlySet<string> = new Set(["revoke_membership_role_v1"]);

export interface AdminRpcDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export type AdminRpcFailureKind =
  | "validation"
  | "target_inactive"
  | "tenancy"
  | "constraint"
  | "last_admin"
  | "rejected"
  | "backend_failure"
  | "not_configured";

export interface AdminRpcFailure {
  ok: false;
  kind: AdminRpcFailureKind;
  message: string;
}

export type AdminVoidOutcome = { ok: true } | AdminRpcFailure;
export type AdminCreateOutcome = { ok: true; id: string } | AdminRpcFailure;

/** Fixed employee-safe messages: no SQLSTATE, table, host or tenant name. */
export const SAFE_ADMIN_RPC_MESSAGE: Record<AdminRpcFailureKind, string> = {
  validation: "Check the fields and try again.",
  target_inactive: "That person is not an active member of this workspace.",
  tenancy: "You do not have permission to perform this action in this workspace.",
  constraint: "That change could not be applied. The target may not exist in this workspace.",
  last_admin: "This workspace must keep at least one active admin.",
  rejected: "The change could not be applied. It may already have been made.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};

function mapBackendFailure(
  rpc: string,
  reason: BackendFailureReason,
  sqlstate: string | undefined,
): AdminRpcFailure {
  if (sqlstate === "23514") {
    return LAST_ADMIN_RPCS.has(rpc)
      ? { ok: false, kind: "last_admin", message: SAFE_ADMIN_RPC_MESSAGE.last_admin }
      : { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
  }
  if (sqlstate === "22023") {
    // The merged RPCs raise 22023 for a suspended or removed target and for bad arguments; the
    // client has already validated the arguments, so the target is what is left.
    return { ok: false, kind: "target_inactive", message: SAFE_ADMIN_RPC_MESSAGE.target_inactive };
  }
  if (sqlstate === "23503" || sqlstate === "23505") {
    return { ok: false, kind: "constraint", message: SAFE_ADMIN_RPC_MESSAGE.constraint };
  }
  switch (reason) {
    case "rejected":
      return { ok: false, kind: "rejected", message: SAFE_ADMIN_RPC_MESSAGE.rejected };
    case "transport":
    case "timeout":
    case "server_error":
    case "invalid_response":
      return { ok: false, kind: "backend_failure", message: SAFE_ADMIN_RPC_MESSAGE.backend_failure };
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_ADMIN_RPC_MESSAGE.backend_failure };
    }
  }
}

function mapTenantRpcFailure(rpc: string, failure: TenantRpcFailure): AdminRpcFailure {
  switch (failure.kind) {
    case "tenancy":
      return { ok: false, kind: "tenancy", message: SAFE_ADMIN_RPC_MESSAGE.tenancy };
    case "not_configured":
      return { ok: false, kind: "not_configured", message: SAFE_ADMIN_RPC_MESSAGE.not_configured };
    case "backend_failure":
      return mapBackendFailure(rpc, failure.reason, failure.sqlstate);
    default: {
      const _exhaustive: never = failure;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_ADMIN_RPC_MESSAGE.backend_failure };
    }
  }
}

function parseUuidReturn(data: unknown): AdminCreateOutcome {
  const parsed = UUID.safeParse(data);
  if (!parsed.success) {
    return { ok: false, kind: "backend_failure", message: SAFE_ADMIN_RPC_MESSAGE.backend_failure };
  }
  return { ok: true, id: parsed.data };
}

export interface MemberRoleInput {
  context: TenantContext;
  accessToken: string;
  userId: string;
  roleId: string;
}

export interface CreateProjectInput {
  context: TenantContext;
  accessToken: string;
  key: string;
  name: string;
  visibility: "organisation" | "project";
}

export interface ProjectMemberInput {
  context: TenantContext;
  accessToken: string;
  projectId: string;
  userId: string;
}

export interface CreateCollectionInput {
  context: TenantContext;
  accessToken: string;
  key: string;
  name: string;
  /** Service key for the collection (T-111b); not a free-form description. */
  service: string;
  dataClass: "public" | "internal" | "client_confidential";
  projectId: string | null;
}

export interface InviteMemberInput {
  context: TenantContext;
  accessToken: string;
  /** Raw address from the form; canonicalized before the RPC (plan §4.2). */
  email: string;
  roleId: string;
}

export interface AdminRpcClient {
  grantMembershipRole(input: MemberRoleInput): Promise<AdminVoidOutcome>;
  revokeMembershipRole(input: MemberRoleInput): Promise<AdminVoidOutcome>;
  inviteMember(input: InviteMemberInput): Promise<AdminVoidOutcome>;
  createProject(input: CreateProjectInput): Promise<AdminCreateOutcome>;
  addProjectMember(input: ProjectMemberInput): Promise<AdminVoidOutcome>;
  removeProjectMember(input: ProjectMemberInput): Promise<AdminVoidOutcome>;
  createCollection(input: CreateCollectionInput): Promise<AdminCreateOutcome>;
}

export function createAdminRpcClient(deps: AdminRpcDeps): AdminRpcClient {
  const config = {
    postgrestBaseUrl: deps.postgrestBaseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };

  async function voidRpc(
    context: TenantContext,
    name: string,
    args: Record<string, unknown>,
    accessToken: string,
  ): Promise<AdminVoidOutcome> {
    const outcome = await withTenantRpc(context, name, args, accessToken, config);
    if (!outcome.ok) return mapTenantRpcFailure(name, outcome);
    return { ok: true };
  }

  return {
    async grantMembershipRole(input) {
      if (!UUID.safeParse(input.userId).success || !UUID.safeParse(input.roleId).success) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      return voidRpc(
        input.context,
        "grant_membership_role_v1",
        { p_user_id: input.userId, p_role_id: input.roleId },
        input.accessToken,
      );
    },

    async revokeMembershipRole(input) {
      if (!UUID.safeParse(input.userId).success || !UUID.safeParse(input.roleId).success) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      return voidRpc(
        input.context,
        "revoke_membership_role_v1",
        { p_user_id: input.userId, p_role_id: input.roleId },
        input.accessToken,
      );
    },

    async inviteMember(input) {
      const email = canonicalEmail(input.email);
      if (email === null || !UUID.safeParse(input.roleId).success) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      return voidRpc(
        input.context,
        "invite_member_v1",
        { p_email: email, p_role_id: input.roleId },
        input.accessToken,
      );
    },

    async createProject(input) {
      if (
        !PROJECT_KEY.safeParse(input.key).success ||
        !PROJECT_NAME.safeParse(input.name).success ||
        !PROJECT_VISIBILITY.safeParse(input.visibility).success
      ) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      const outcome = await withTenantRpc(
        input.context,
        "create_project_v1",
        { p_key: input.key, p_name: input.name, p_visibility: input.visibility },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure("create_project_v1", outcome);
      return parseUuidReturn(outcome.data);
    },

    async addProjectMember(input) {
      if (!UUID.safeParse(input.projectId).success || !UUID.safeParse(input.userId).success) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      return voidRpc(
        input.context,
        "add_project_member_v1",
        { p_project_id: input.projectId, p_user_id: input.userId },
        input.accessToken,
      );
    },

    async removeProjectMember(input) {
      if (!UUID.safeParse(input.projectId).success || !UUID.safeParse(input.userId).success) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      return voidRpc(
        input.context,
        "remove_project_member_v1",
        { p_project_id: input.projectId, p_user_id: input.userId },
        input.accessToken,
      );
    },

    async createCollection(input) {
      const service = COLLECTION_SERVICE.safeParse(input.service);
      if (
        !COLLECTION_KEY.safeParse(input.key).success ||
        !COLLECTION_NAME.safeParse(input.name).success ||
        !service.success ||
        !DATA_CLASS.safeParse(input.dataClass).success
      ) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      if (input.dataClass === "client_confidential" && input.projectId === null) {
        return {
          ok: false,
          kind: "validation",
          message: "A client-confidential collection must belong to a project.",
        };
      }
      if (input.projectId !== null && !UUID.safeParse(input.projectId).success) {
        return { ok: false, kind: "validation", message: SAFE_ADMIN_RPC_MESSAGE.validation };
      }
      const outcome = await withTenantRpc(
        input.context,
        "create_collection_v1",
        {
          p_key: input.key,
          p_name: input.name,
          p_service: service.data,
          p_project_id: input.projectId,
          p_data_class: input.dataClass,
        },
        input.accessToken,
        config,
      );
      if (!outcome.ok) return mapTenantRpcFailure("create_collection_v1", outcome);
      return parseUuidReturn(outcome.data);
    },
  };
}
