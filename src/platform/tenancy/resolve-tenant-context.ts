import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";

import { parseHost, requestHost, type HostRejectReason } from "./host";

/**
 * F01 + F02, second half: host → tenant → membership → one frozen `TenantContext`.
 *
 * The store is a port so this module is testable without a database; the Postgres/Supabase
 * adapter arrives with T-102 (the session packet), and the SQL side of both lookups is already
 * enforced by RLS and `resolve_tenant_host` in
 * `supabase/migrations/20261105060000_tenancy_core.sql`.
 */
export interface HostRecord {
  organisationId: string;
  organisationStatus: "provisioning" | "active" | "suspended" | "archived" | "deleting";
}

export interface MembershipRecord {
  membershipId: string;
  status: "invited" | "active" | "suspended" | "removed";
  roles: string[];
  /**
   * Computed server-side. Empty means "no services enabled for this member" — the service
   * registry (plan §6.1 `tenant_services`) is not built yet, so an empty list is the fail-closed
   * value, not a TODO to widen.
   */
  permittedServiceKeys: string[];
  permittedProjectIds: string[];
}

export interface TenancyStore {
  findHost(host: string): Promise<HostRecord | null>;
  findMembership(organisationId: string, userId: string): Promise<MembershipRecord | null>;
  policyRevision(organisationId: string): Promise<number>;
}

export type TenantFailureReason =
  | HostRejectReason
  | "unknown_host"
  | "reserved_host"
  | "tenant_not_live"
  | "no_session"
  | "not_a_member"
  | "membership_not_active"
  | "backend_failure";

export type TenantResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; reason: TenantFailureReason };

/**
 * Employee-visible text. It never names a tenant, a host or a provider, and the reason codes are
 * coarse enough that the page cannot be used to probe which companies exist (plan §4.1 step 3,
 * §8.2 "employee-facing messages must not disclose inaccessible records").
 */
export const SAFE_FAILURE_MESSAGE: Record<TenantFailureReason, string> = {
  missing_host: "This address is not recognized.",
  malformed_host: "This address is not recognized.",
  too_many_labels: "This address is not recognized.",
  preview_alias: "This address is not recognized.",
  ip_literal: "This address is not recognized.",
  unknown_host: "This address is not recognized.",
  reserved_host: "That workspace is not available at this address.",
  tenant_not_live: "This workspace is not available right now.",
  no_session: "Please sign in to continue.",
  not_a_member: "You do not have access to this workspace.",
  membership_not_active: "Your access to this workspace has ended.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
};

export interface ResolveTenantContextInput {
  headers: Headers;
  userId: string | null;
  store: TenancyStore;
}

/** Order matters: host first, then tenant state, then membership. Nothing here trusts input. */
export async function resolveTenantContext(
  input: ResolveTenantContextInput,
): Promise<TenantResolution> {
  const parsed = parseHost(requestHost(input.headers));
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.class !== "tenant") return { ok: false, reason: "reserved_host" };
  if (input.userId === null) return { ok: false, reason: "no_session" };

  try {
    const hostRecord = await input.store.findHost(parsed.host);
    if (hostRecord === null) return { ok: false, reason: "unknown_host" };
    if (hostRecord.organisationStatus !== "active") return { ok: false, reason: "tenant_not_live" };

    const membership = await input.store.findMembership(hostRecord.organisationId, input.userId);
    if (membership === null) return { ok: false, reason: "not_a_member" };
    if (membership.status !== "active") return { ok: false, reason: "membership_not_active" };

    const policyRevision = await input.store.policyRevision(hostRecord.organisationId);
    const context = createTenantContext({
      organisationId: hostRecord.organisationId,
      host: parsed.host,
      userId: input.userId,
      membershipId: membership.membershipId,
      membershipStatus: "active",
      roles: membership.roles,
      permittedServiceKeys: membership.permittedServiceKeys,
      permittedProjectIds: membership.permittedProjectIds,
      policyRevision,
      resolvedAt: new Date().toISOString(),
    });
    return { ok: true, context };
  } catch {
    // A database or adapter failure is not a licence to serve an unscoped page.
    return { ok: false, reason: "backend_failure" };
  }
}
