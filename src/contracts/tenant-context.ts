import { z } from "zod";

import { NormalizedHost, ServiceKey } from "./keys";

/**
 * TenantContext (plan §4.1 step 4, §4.3; AGENTS.md §4.1).
 *
 * Built **only** by the request pipeline from the verified host (F01) plus current membership
 * state (F02). It is the sole source of organization for everything downstream: data access,
 * tools, budget and gateway calls. Nothing in it may come from a request body, query string,
 * header, cookie value, model output or client state.
 */
export const TenantContext = z.strictObject({
  organisationId: z.uuid(),
  host: NormalizedHost,
  userId: z.uuid(),
  membershipId: z.uuid(),
  // Only an active membership produces a context at all; suspended tenants and removed members
  // never reach this type (plan §4.2, F28).
  membershipStatus: z.literal("active"),
  roles: z.array(z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,63}$/)),
  // Server-computed intersection of tenant entitlement, service permission and user roles.
  permittedServiceKeys: z.array(ServiceKey),
  permittedProjectIds: z.array(z.uuid()),
  // Bumped whenever tenancy, membership, role or data policy changes, so runs can be re-checked
  // against the revision they were authorized under (plan §6.2, §9.4).
  policyRevision: z.number().int().nonnegative(),
  resolvedAt: z.iso.datetime(),
});

export type TenantContext = z.infer<typeof TenantContext>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Parses and deep-freezes a context. Handlers receive a value that cannot be re-pointed at
 * another tenant mid-request, and a nested array cannot be widened to another project.
 */
export function createTenantContext(input: unknown): TenantContext {
  return deepFreeze(TenantContext.parse(input));
}
