import type { FormTemplate } from "@/contracts/form-template";
import type { TenantContext } from "@/contracts/tenant-context";
import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { createFormsRpcClient } from "./forms-rpc";
import type { FormsPorts } from "./forms-service";
import { findSeededTemplateForTenant, listSeededTemplatesForTenant } from "./seeded-templates";

/**
 * Deployment wiring for the forms pages and submit route. Reuses `buildIdentityPorts` for session
 * and tenancy verification, and wires `createFormsRpcClient` to PostgREST over `withTenantRpc`.
 */

export type FormsEnv = Partial<IdentityEnv> & {
  POSTGREST_BASE_URL?: string;
};

export interface FormsAdapterOptions {
  fetchImpl?: FetchImpl;
  listTemplates?: (context: TenantContext) => Promise<FormTemplate[]>;
  findTemplate?: (context: TenantContext, templateId: string) => Promise<FormTemplate | null>;
}

function resolvePostgrestBase(env: FormsEnv): string | undefined {
  const explicit = typeof env.POSTGREST_BASE_URL === "string" ? env.POSTGREST_BASE_URL.trim() : "";
  if (explicit.length > 0) return explicit;
  const supabase = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim().replace(/\/+$/, "") : "";
  if (supabase.length === 0) return undefined;
  return supabase.endsWith("/rest/v1") ? supabase : `${supabase}/rest/v1`;
}

export function buildFormsPorts(env: FormsEnv, options: FormsAdapterOptions = {}): FormsPorts {
  const identity = buildIdentityPorts(env);
  const formsRpc = createFormsRpcClient({
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
    listTemplates: options.listTemplates ?? (async (ctx) => listSeededTemplatesForTenant(ctx)),
    findTemplate: options.findTemplate ?? (async (ctx, id) => findSeededTemplateForTenant(ctx, id)),
    formsRpc,
  };
}
