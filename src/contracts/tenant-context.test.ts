import { describe, expect, it } from "vitest";

import { TenantContext, createTenantContext } from "./tenant-context";

// AGENTS.md §4.1: the organization comes only from the verified host plus current membership,
// so the context object is built by the server and frozen. Plan §4.1 step 1: hosts are
// normalized (lowercase, no scheme, no port, no path).
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

const validContext = () => ({
  organisationId: ORG_ID,
  host: "company1.terraoi.app",
  userId: USER_ID,
  membershipId: MEMBERSHIP_ID,
  membershipStatus: "active" as const,
  roles: ["member"],
  permittedServiceKeys: ["gpr", "uav"],
  permittedProjectIds: [PROJECT_ID],
  policyRevision: 7,
  resolvedAt: "2026-11-04T12:00:00Z",
});

describe("TenantContext (plan §4.1–§4.3)", () => {
  it("parses a complete server-resolved context", () => {
    const parsed = TenantContext.parse(validContext());
    expect(parsed.host).toBe("company1.terraoi.app");
    expect(parsed.permittedProjectIds).toEqual([PROJECT_ID]);
  });

  it("rejects a context with no user or no membership (identity is required for tenant data)", () => {
    expect(() => TenantContext.parse({ ...validContext(), userId: undefined })).toThrow();
    expect(() => TenantContext.parse({ ...validContext(), membershipId: undefined })).toThrow();
  });

  it("rejects unknown keys, so no client-supplied tenant field can ride along", () => {
    for (const extra of [
      { tenantId: ORG_ID },
      { organisation_id: ORG_ID },
      { orgId: ORG_ID },
      { xForwardedHost: "company2.terraoi.app" },
      { accessToken: "eyJ..." },
    ]) {
      expect(() => TenantContext.parse({ ...validContext(), ...extra })).toThrow();
    }
  });

  it("refuses a non-active membership or organisation state (suspended tenants get nothing)", () => {
    expect(() => TenantContext.parse({ ...validContext(), membershipStatus: "invited" })).toThrow();
    expect(() => TenantContext.parse({ ...validContext(), membershipStatus: "removed" })).toThrow();
  });

  it("normalizes the host: lowercase, no scheme, no port, no path, no extra subdomain level", () => {
    for (const host of [
      "Company1.TerraOI.app",
      "https://company1.terraoi.app",
      "company1.terraoi.app:8443",
      "company1.terraoi.app/chat",
      "deep.sub.company1.terraoi.app",
      "company1.terraoi.app.evil.test",
      "",
    ]) {
      expect(() => TenantContext.parse({ ...validContext(), host })).toThrow();
    }
    expect(TenantContext.parse({ ...validContext(), host: "admin.terraoi.app" }).host).toBe(
      "admin.terraoi.app",
    );
  });

  it("requires uuid ids and a non-negative policy revision", () => {
    expect(() => TenantContext.parse({ ...validContext(), organisationId: "company1" })).toThrow();
    expect(() => TenantContext.parse({ ...validContext(), policyRevision: -1 })).toThrow();
    expect(() => TenantContext.parse({ ...validContext(), permittedServiceKeys: ["GPR!"] })).toThrow();
  });

  it("createTenantContext deep-freezes the value so handlers cannot re-point it at another tenant", () => {
    const ctx = createTenantContext(validContext());
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.permittedServiceKeys)).toBe(true);
    expect(Object.isFrozen(ctx.permittedProjectIds)).toBe(true);
    expect(() => {
      (ctx as { organisationId: string }).organisationId = "00000000-0000-4000-8000-000000000000";
    }).toThrow();
    expect(ctx.organisationId).toBe(ORG_ID);
  });
});
