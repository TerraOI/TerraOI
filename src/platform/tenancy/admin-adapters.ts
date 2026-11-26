import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { createAdminRpcClient } from "./admin-rpc";
import type { AdminPorts } from "./admin-service";

/**
 * Deployment wiring for `/admin/*` pages and the create-project route (T-202 PR-2).
 */

export type AdminEnv = Partial<IdentityEnv> & {
  POSTGREST_BASE_URL?: string;
};

export interface AdminAdapterOptions {
  fetchImpl?: FetchImpl;
}

function resolvePostgrestBase(env: AdminEnv): string | undefined {
  const explicit = typeof env.POSTGREST_BASE_URL === "string" ? env.POSTGREST_BASE_URL.trim() : "";
  if (explicit.length > 0) return explicit;
  const supabase = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim().replace(/\/+$/, "") : "";
  if (supabase.length === 0) return undefined;
  return supabase.endsWith("/rest/v1") ? supabase : `${supabase}/rest/v1`;
}

export function buildAdminPorts(env: AdminEnv, options: AdminAdapterOptions = {}): AdminPorts {
  const identity = buildIdentityPorts(env);
  const adminRpc = createAdminRpcClient({
    postgrestBaseUrl: resolvePostgrestBase(env),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  return {
    now: () => identity.now(),
    signingSecret: () => identity.signingSecret(),
    sessionStore: () => identity.sessionStore(),
    tokenCipher: () => identity.tokenCipher(),
    findHost: (host) => identity.findHost(host),
    findMembership: (organisationId, accessToken) => identity.findMembership(organisationId, accessToken),
    policyRevision: (organisationId, accessToken) => identity.policyRevision(organisationId, accessToken),
    adminRpc,
  };
}
