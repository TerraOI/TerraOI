import { z } from "zod";

import type { HostRecord, MembershipRecord } from "@/platform/tenancy/resolve-tenant-context";

/**
 * Tenancy lookups over the Data API (#37(b)): anon for host resolution, the user's access token
 * for membership and policy reads. Role keys that need `current_organisation_id()` wait on
 * `withTenantRpc` (T-101c / #167); until then `roles` is the fail-closed empty list.
 */

export type TenancyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type TenancyDataApiOptions = {
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: TenancyFetch;
};

export type TenancyDataApi = {
  findHost(host: string): Promise<HostRecord | null>;
  findMembership(organisationId: string, userId: string, accessToken: string): Promise<MembershipRecord | null>;
  policyRevision(organisationId: string, accessToken: string): Promise<number>;
};

const HostRow = z.object({
  organisation_id: z.uuid(),
  organisation_status: z.enum(["provisioning", "active", "suspended", "archived", "deleting"]),
});

const MembershipRow = z.object({
  id: z.uuid(),
  status: z.enum(["invited", "active", "suspended", "removed"]),
});

const PolicyRow = z.object({
  policy_revision: z.number().int().positive(),
});

async function readJson(response: { ok: boolean; status: number; text: () => Promise<string> }): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) throw new Error(`tenancy Data API refused with status ${response.status}`);
  if (body.length === 0) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("tenancy Data API returned unreadable JSON");
  }
}

export function createTenancyDataApi(options: TenancyDataApiOptions): TenancyDataApi {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl: TenancyFetch = options.fetchImpl ?? ((fetch as unknown) as TenancyFetch);

  const anonHeaders = (): Record<string, string> => ({
    apikey: options.anonKey,
    authorization: `Bearer ${options.anonKey}`,
    "content-type": "application/json",
  });

  const userHeaders = (accessToken: string): Record<string, string> => ({
    apikey: options.anonKey,
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  });

  return {
    async findHost(host: string): Promise<HostRecord | null> {
      const response = await fetchImpl(`${base}/rest/v1/rpc/resolve_tenant_host`, {
        method: "POST",
        headers: anonHeaders(),
        body: JSON.stringify({ p_host: host }),
      });
      const payload = await readJson(response);
      const rows = Array.isArray(payload) ? payload : [];
      const first = rows[0];
      if (first === undefined) return null;
      const parsed = HostRow.safeParse(first);
      if (!parsed.success) return null;
      return {
        organisationId: parsed.data.organisation_id,
        organisationStatus: parsed.data.organisation_status,
      };
    },

    async findMembership(organisationId: string, userId: string, accessToken: string): Promise<MembershipRecord | null> {
      if (accessToken.length === 0) throw new Error("findMembership needs the user's access token (#37)");
      const url =
        `${base}/rest/v1/organisation_memberships` +
        `?organisation_id=eq.${encodeURIComponent(organisationId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&select=id,status`;
      const response = await fetchImpl(url, { method: "GET", headers: userHeaders(accessToken) });
      const payload = await readJson(response);
      const rows = Array.isArray(payload) ? payload : [];
      const first = rows[0];
      if (first === undefined) return null;
      const parsed = MembershipRow.safeParse(first);
      if (!parsed.success) return null;
      return {
        membershipId: parsed.data.id,
        status: parsed.data.status,
        roles: [],
        permittedServiceKeys: [],
        permittedProjectIds: [],
      };
    },

    async policyRevision(organisationId: string, accessToken: string): Promise<number> {
      if (accessToken.length === 0) throw new Error("policyRevision needs the user's access token (#37)");
      const url =
        `${base}/rest/v1/organisations` +
        `?id=eq.${encodeURIComponent(organisationId)}` +
        `&select=policy_revision`;
      const response = await fetchImpl(url, { method: "GET", headers: userHeaders(accessToken) });
      const payload = await readJson(response);
      const rows = Array.isArray(payload) ? payload : [];
      const first = rows[0];
      if (first === undefined) throw new Error("policyRevision: organisation not visible under RLS");
      const parsed = PolicyRow.safeParse(first);
      if (!parsed.success) throw new Error("policyRevision: unexpected row shape");
      return parsed.data.policy_revision;
    },
  };
}
