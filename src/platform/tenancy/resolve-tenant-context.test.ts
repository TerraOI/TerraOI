import { describe, expect, it } from "vitest";

import { SAFE_FAILURE_MESSAGE, resolveTenantContext, type TenancyStore } from "./resolve-tenant-context";

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const USER = "00000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

function fakeStore(overrides: Partial<TenancyStore> = {}): TenancyStore {
  return {
    findHost: async (host) =>
      host === "company1.terraoi.app"
        ? { organisationId: C1, organisationStatus: "active" }
        : host === "dead.terraoi.app"
          ? { organisationId: C2, organisationStatus: "suspended" }
          : null,
    findMembership: async (organisationId, userId) =>
      organisationId === C1 && userId === USER
        ? {
            membershipId: MEMBERSHIP,
            status: "active",
            roles: ["member"],
            permittedServiceKeys: [],
            permittedProjectIds: [],
          }
        : null,
    policyRevision: async () => 4,
    ...overrides,
  };
}

const headersFor = (host: string) => new Headers({ host, "cf-connecting-ip": "203.0.113.7" });

describe("resolveTenantContext (plan §4.1 step 4, F01+F02)", () => {
  it("builds a frozen context for an active member of an active tenant", async () => {
    const result = await resolveTenantContext({
      headers: headersFor("company1.terraoi.app"),
      userId: USER,
      store: fakeStore(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.organisationId).toBe(C1);
    expect(result.context.host).toBe("company1.terraoi.app");
    expect(result.context.policyRevision).toBe(4);
    expect(Object.isFrozen(result.context)).toBe(true);
  });

  it("refuses every host that is not in the registry, with the same generic reason", async () => {
    for (const host of ["company3.terraoi.app", "company1.terraoi.app.evil.test", "my-app.workers.dev", "127.0.0.1"]) {
      const result = await resolveTenantContext({ headers: headersFor(host), userId: USER, store: fakeStore() });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(["unknown_host", "too_many_labels", "preview_alias", "ip_literal"]).toContain(result.reason);
      expect(SAFE_FAILURE_MESSAGE[result.reason]).not.toContain("terraoi.app");
    }
  });

  it("gives platform and admin hosts no tenant context (the public site is not a default tenant)", async () => {
    for (const host of ["terraoi.app", "www.terraoi.app", "admin.terraoi.app"]) {
      const result = await resolveTenantContext({ headers: headersFor(host), userId: USER, store: fakeStore() });
      expect(result).toEqual({ ok: false, reason: "reserved_host" });
    }
  });

  it("a suspended tenant produces nothing even for a member who was valid yesterday", async () => {
    const result = await resolveTenantContext({
      headers: headersFor("dead.terraoi.app"),
      userId: USER,
      store: fakeStore({ findMembership: async () => ({ membershipId: MEMBERSHIP, status: "active", roles: [], permittedServiceKeys: [], permittedProjectIds: [] }) }),
    });
    expect(result).toEqual({ ok: false, reason: "tenant_not_live" });
  });

  it("identity without membership grants nothing, and a removed membership grants nothing", async () => {
    const stranger = await resolveTenantContext({
      headers: headersFor("company1.terraoi.app"),
      userId: "00000000-0000-4000-8000-0000000000b1",
      store: fakeStore(),
    });
    expect(stranger).toEqual({ ok: false, reason: "not_a_member" });

    const removed = await resolveTenantContext({
      headers: headersFor("company1.terraoi.app"),
      userId: USER,
      store: fakeStore({
        findMembership: async () => ({ membershipId: MEMBERSHIP, status: "suspended", roles: [], permittedServiceKeys: [], permittedProjectIds: [] }),
      }),
    });
    expect(removed).toEqual({ ok: false, reason: "membership_not_active" });
  });

  it("an unauthenticated request on a tenant host is a session failure, not a tenant failure", async () => {
    const result = await resolveTenantContext({ headers: headersFor("company1.terraoi.app"), userId: null, store: fakeStore() });
    expect(result).toEqual({ ok: false, reason: "no_session" });
  });

  it("a spoofed tenant header or query value never reaches the context (AGENTS.md §4.1)", async () => {
    const headers = new Headers({
      host: "company1.terraoi.app",
      "cf-connecting-ip": "203.0.113.7",
      "x-organisation-id": C2,
      "x-tenant": "company2",
    });
    const result = await resolveTenantContext({ headers, userId: USER, store: fakeStore() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.organisationId).toBe(C1);
  });

  it("concurrent requests for different tenants resolve independently (no process-global scope)", async () => {
    const store: TenancyStore = {
      findHost: async (host) =>
        host === "company1.terraoi.app"
          ? { organisationId: C1, organisationStatus: "active" }
          : { organisationId: C2, organisationStatus: "active" },
      findMembership: async () => ({
        membershipId: MEMBERSHIP,
        status: "active",
        roles: ["member"],
        permittedServiceKeys: [],
        permittedProjectIds: [],
      }),
      policyRevision: async (organisationId) => (organisationId === C1 ? 1 : 2),
    };
    const [a, b] = await Promise.all([
      resolveTenantContext({ headers: headersFor("company1.terraoi.app"), userId: USER, store }),
      resolveTenantContext({ headers: headersFor("company2.terraoi.app"), userId: USER, store }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.context.organisationId).toBe(C1);
    expect(b.context.organisationId).toBe(C2);
    expect(a.context.policyRevision).toBe(1);
    expect(b.context.policyRevision).toBe(2);
  });

  it("a store that throws fails closed with a safe reason, never a half-built context", async () => {
    const result = await resolveTenantContext({
      headers: headersFor("company1.terraoi.app"),
      userId: USER,
      store: fakeStore({ findMembership: async () => { throw new Error("database down"); } }),
    });
    expect(result).toEqual({ ok: false, reason: "backend_failure" });
    expect(SAFE_FAILURE_MESSAGE.backend_failure).not.toContain("database");
  });
});
