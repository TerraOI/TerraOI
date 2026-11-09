import { afterEach, describe, expect, it, vi } from "vitest";

import { SAFE_FAILURE_MESSAGE, type TenancyStore } from "./resolve-tenant-context";

import {
  ROUTED_HOST_HEADER,
  pageRoutedHost,
  resolvePageTenantContext,
  type ResolvePageTenantContextInput,
} from "./page-host";

// ADR-0006, rule 2: a page gets the tenant host only through this helper, and a page with no proxy
// header fails closed with the generic failure — never a default tenant. The header is the proxy's
// value from `new URL(request.url).host`; `Host` and `X-Forwarded-Host` are not read here at all.

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const USER = "00000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeStore(overrides: Partial<TenancyStore> = {}) {
  const calls = { hosts: 0, memberships: 0 };
  const store: TenancyStore = {
    async findHost(host) {
      calls.hosts += 1;
      if (host === "company1.terraoi.app") return { organisationId: C1, organisationStatus: "active" };
      if (host === "company2.terraoi.app") return { organisationId: C2, organisationStatus: "active" };
      if (host === "dead.terraoi.app") return { organisationId: C2, organisationStatus: "suspended" };
      return null;
    },
    async findMembership(organisationId, userId) {
      calls.memberships += 1;
      if (userId !== USER) return null;
      void organisationId;
      return {
        membershipId: MEMBERSHIP,
        status: "active",
        roles: ["member"],
        permittedServiceKeys: [],
        permittedProjectIds: [],
      };
    },
    async policyRevision() {
      return 4;
    },
    ...overrides,
  };
  return { store, calls };
}

function pageHeaders(values: Record<string, string>): Headers {
  const h = new Headers();
  for (const [name, value] of Object.entries(values)) h.set(name, value);
  return h;
}

function inputFor(values: Record<string, string>, store: TenancyStore, extra: Partial<ResolvePageTenantContextInput> = {}): ResolvePageTenantContextInput {
  return { headers: pageHeaders(values), userId: USER, store, ...extra };
}

describe("pageRoutedHost (the only page-side host source, ADR-0006 rule 2)", () => {
  it("is the header name the proxy sets, and nothing else", () => {
    expect(ROUTED_HOST_HEADER).toBe("x-toi-routed-host");
    expect(pageRoutedHost(pageHeaders({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" }))).toBe(
      "company1.terraoi.app",
    );
  });

  it("returns null when the header is missing, and never falls back to Host or X-Forwarded-Host", () => {
    const forged = pageHeaders({
      host: "company1.terraoi.app",
      "x-forwarded-host": "company1.terraoi.app",
      cookie: "brand=company1",
    });
    expect(pageRoutedHost(forged)).toBeNull();
  });

  // Two copies are what a cache or a second proxy chain leaves behind. `Headers.get` follows the
  // Fetch spec and joins repeated values with ", ", so the helper cannot hand a page "the first
  // value" and silently resolve one of two tenants.
  it("never picks the first of two duplicated values", () => {
    const doubled = new Headers();
    doubled.append(ROUTED_HOST_HEADER, "company1.terraoi.app");
    doubled.append(ROUTED_HOST_HEADER, "company2.terraoi.app");
    expect(pageRoutedHost(doubled)).toBe("company1.terraoi.app, company2.terraoi.app");
  });
});

describe("resolvePageTenantContext: fail closed with no proxy header", () => {
  it("a page with no proxy header gets the generic failure, not a default tenant", async () => {
    const { store, calls } = fakeStore();
    const result = await resolvePageTenantContext(
      inputFor({ host: "company1.terraoi.app", "x-forwarded-host": "company1.terraoi.app" }, store),
    );
    expect(result).toEqual({ ok: false, reason: "missing_host" });
    expect(SAFE_FAILURE_MESSAGE.missing_host).toBe("This address is not recognized.");
    // Fail closed means the registry is never consulted: no host to look up, no tenant to guess.
    expect(calls.hosts).toBe(0);
    expect(calls.memberships).toBe(0);
  });

  it("an empty or whitespace header value is a malformed host, not a missing one and not a default", async () => {
    const { store } = fakeStore();
    for (const value of ["", " ", "  \t "]) {
      const result = await resolvePageTenantContext(inputFor({ [ROUTED_HOST_HEADER]: value }, store));
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(["missing_host", "malformed_host"]).toContain(result.reason);
    }
  });

  // The proxy deletes then sets, so a real page sees exactly one copy. If one ever arrives doubled —
  // a cache, a second proxy chain — `Headers.get` joins the values, and the joined string is not a
  // host. It must fail closed here, never resolve whichever tenant happens to come first.
  it("a duplicated header fails closed instead of choosing the first tenant", async () => {
    const { store, calls } = fakeStore();
    const doubled = new Headers();
    doubled.append(ROUTED_HOST_HEADER, "company1.terraoi.app");
    doubled.append(ROUTED_HOST_HEADER, "company2.terraoi.app");
    const result = await resolvePageTenantContext({ headers: doubled, userId: USER, store });
    expect(result).toEqual({ ok: false, reason: "malformed_host" });
    expect(calls.hosts).toBe(0);
    expect(calls.memberships).toBe(0);
  });
});

describe("resolvePageTenantContext: the header is the authority, and it is validated", () => {
  it("company1 and company2 headers resolve to different contexts (the packet's third test)", async () => {
    const { store } = fakeStore();
    const one = await resolvePageTenantContext(
      inputFor({ [ROUTED_HOST_HEADER]: "company1.terraoi.app", host: "company2.terraoi.app" }, store),
    );
    const two = await resolvePageTenantContext(
      inputFor({ [ROUTED_HOST_HEADER]: "company2.terraoi.app", host: "company1.terraoi.app" }, store),
    );
    expect(one.ok && two.ok && one.context.organisationId).toBe(C1);
    expect(two.ok && two.context.organisationId).toBe(C2);
    if (one.ok && two.ok) {
      expect(one.context.host).toBe("company1.terraoi.app");
      expect(two.context.host).toBe("company2.terraoi.app");
      expect(one.context.organisationId).not.toBe(two.context.organisationId);
    }
  });

  it("a hostile Host or X-Forwarded-Host cannot re-point the page at another tenant", async () => {
    const { store } = fakeStore();
    const result = await resolvePageTenantContext(
      inputFor(
        {
          [ROUTED_HOST_HEADER]: "company1.terraoi.app",
          host: "company2.terraoi.app",
          "x-forwarded-host": "company2.terraoi.app",
          "x-tenant": "company2.terraoi.app",
        },
        store,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.organisationId).toBe(C1);
  });

  it("rejects a header that is not a bare host, and never repairs it", async () => {
    const { store } = fakeStore();
    const cases: [string, string[]][] = [
      ["company1.terraoi.app/evil", ["malformed_host"]],
      ["company1.terraoi.app?x=1", ["malformed_host"]],
      ["evil.example/redirect?to=company1.terraoi.app", ["malformed_host"]],
      ["u@company1.terraoi.app", ["malformed_host"]],
      ["company1.terraoi.app:8443", ["missing_host", "malformed_host"]],
      ["company1.terraoi.app\u00a0", ["malformed_host"]],
      ["deep.sub.company1.terraoi.app", ["too_many_labels"]],
      ["my-app.workers.dev", ["preview_alias"]],
      ["127.0.0.1", ["ip_literal"]],
      ["terraoi.app.evil.test", ["too_many_labels", "malformed_host", "unknown_host"]],
    ];
    for (const [value, allowed] of cases) {
      const result = await resolvePageTenantContext(inputFor({ [ROUTED_HOST_HEADER]: value }, store));
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(allowed, JSON.stringify(value)).toContain(result.reason);
    }
  });

  it("normalizes case the way the merged resolver does, rather than rejecting it", async () => {
    const { store } = fakeStore();
    const result = await resolvePageTenantContext(
      inputFor({ [ROUTED_HOST_HEADER]: "Company1.terraoi.app" }, store),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.host).toBe("company1.terraoi.app");
  });

  it("platform, admin and unknown hosts get no tenant context on a page either", async () => {
    const { store } = fakeStore();
    const platform = await resolvePageTenantContext(
      inputFor({ [ROUTED_HOST_HEADER]: "terraoi.app" }, store),
    );
    expect(platform).toEqual({ ok: false, reason: "reserved_host" });
    const admin = await resolvePageTenantContext(
      inputFor({ [ROUTED_HOST_HEADER]: "admin.terraoi.app" }, store),
    );
    expect(admin).toEqual({ ok: false, reason: "reserved_host" });
    const unknown = await resolvePageTenantContext(
      inputFor({ [ROUTED_HOST_HEADER]: "nosuch.terraoi.app" }, store),
    );
    expect(unknown).toEqual({ ok: false, reason: "unknown_host" });
    const suspended = await resolvePageTenantContext(
      inputFor({ [ROUTED_HOST_HEADER]: "dead.terraoi.app" }, store),
    );
    expect(suspended).toEqual({ ok: false, reason: "tenant_not_live" });
  });

  it("a developmentHost parameter is honoured only in an explicit development runtime", async () => {
    const { store } = fakeStore();
    // Production-like: the proxy header is the only source, so no header is no tenant.
    vi.stubEnv("NODE_ENV", "production");
    const prod = await resolvePageTenantContext(
      inputFor({}, store, { hostOptions: { developmentHost: "company1.terraoi.app" } }),
    );
    expect(prod).toEqual({ ok: false, reason: "missing_host" });

    vi.stubEnv("NODE_ENV", "development");
    const dev = await resolvePageTenantContext(
      inputFor({}, store, { hostOptions: { developmentHost: "company1.terraoi.app" } }),
    );
    expect(dev.ok).toBe(true);
    if (dev.ok) expect(dev.context.host).toBe("company1.terraoi.app");
  });
});
