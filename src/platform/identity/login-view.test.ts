import { afterEach, describe, expect, it, vi } from "vitest";

import { issueSession } from "./session";
import { buildLoginView, type LoginViewPorts } from "./login-view";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const LEFT = "00000000-0000-4000-8000-0000000000a3";
const OUTSIDER = "00000000-0000-4000-8000-0000000000b1";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

// The seeded identities and hosts of supabase/seed.sql: the gate is the thing that decides who sees
// the no-access surface, so the fixtures are the ones the staging demo will use.
function ports(overrides: Partial<LoginViewPorts> = {}): LoginViewPorts {
  return {
    now: () => NOW,
    signingSecret: () => SECRET,
    findHost: async (host) =>
      host === "company1.terraoi.app" || host === "company2.terraoi.app"
        ? { organisationId: host === "company1.terraoi.app" ? C1 : C2, organisationStatus: "active" }
        : null,
    findMembership: async (organisationId, userId) =>
      organisationId === C1 && userId === OWNER1
        ? { membershipId: MEMBERSHIP, status: "active", roles: ["member"], permittedServiceKeys: [], permittedProjectIds: [] }
        : organisationId === C1 && userId === LEFT
          ? { membershipId: MEMBERSHIP, status: "suspended", roles: [], permittedServiceKeys: [], permittedProjectIds: [] }
          : null,
    policyRevision: async () => 1,
    ...overrides,
  };
}

async function sessionCookieFor(userId: string, host = "company1.terraoi.app") {
  const session = await issueSession({ userId, host, secret: SECRET, now: NOW, secureTransport: true });
  return `${session.cookie.name}=${session.cookie.value}`;
}

// Vitest runs in a node environment without DOM globals, so the view is exercised through a plain
// Request: the page hands it `new Request(url, { headers })` from the route.
function makeRequest(host: string, cookieHeader: string | null): Request {
  const headers = new Headers();
  if (cookieHeader !== null) headers.set("cookie", cookieHeader);
  return new Request(`https://${host}/login`, { headers });
}

// Restores NODE_ENV after the `next dev` host case (the tenancy adapter binds it to the runtime).
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildLoginView (the surface F02 chooses, plan §4.1 step 4, §4.2)", () => {
  it("asks a signed-out visitor on a live tenant host to sign in", async () => {
    const view = await buildLoginView({ request: makeRequest("company1.terraoi.app", null), ports: ports() });
    expect(view.kind).toBe("sign_in");
  });

  it("gives an unregistered address the generic page, never a sign-in prompt", async () => {
    const view = await buildLoginView({ request: makeRequest("nosuch.terraoi.app", null), ports: ports() });
    expect(view).toEqual({ kind: "unknown_address" });
  });

  it("gives a reserved platform host the generic page too", async () => {
    const view = await buildLoginView({ request: makeRequest("admin.terraoi.app", null), ports: ports() });
    expect(view).toEqual({ kind: "unknown_address" });
  });

  it("a suspended tenant is tenant_not_live whatever the session says", async () => {
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", null),
      ports: ports({ findHost: async () => ({ organisationId: C1, organisationStatus: "suspended" }) }),
    });
    expect(view).toEqual({ kind: "tenant_not_live" });
  });

  // Acceptance item: a valid identity with no / suspended / invited membership sees the generic
  // no-access page. Identity alone grants nothing (plan §4.2, F02).
  it("a live session for a stranger to this tenant is no_access", async () => {
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(OUTSIDER)),
      ports: ports(),
    });
    expect(view).toEqual({ kind: "no_access", reason: "not_a_member" });
  });

  it("a live session for a suspended member is no_access, whatever the cookie claimed", async () => {
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(LEFT)),
      ports: ports(),
    });
    expect(view).toEqual({ kind: "no_access", reason: "membership_not_active" });
  });

  it("an invited membership grants no access on its own", async () => {
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(OUTSIDER)),
      ports: ports({
        findMembership: async () => ({
          membershipId: MEMBERSHIP,
          status: "invited",
          roles: [],
          permittedServiceKeys: [],
          permittedProjectIds: [],
        }),
      }),
    });
    expect(view).toEqual({ kind: "no_access", reason: "membership_not_active" });
  });

  it("an active member of this tenant is signed in", async () => {
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(OWNER1)),
      ports: ports(),
    });
    expect(view).toEqual({ kind: "signed_in" });
  });

  // Acceptance item: the session cookie of company1 is not accepted on company2. It is not a
  // weaker company2 session — it is no session at all, so nothing looks a user up in company2 and
  // the visitor is asked to sign in on the host they actually reached (plan §4.2, F02 cross-host replay).
  it("a company1 session on company2 is no session at all: no membership lookup, no tenant data", async () => {
    const lookedUp: string[] = [];
    const view = await buildLoginView({
      request: makeRequest("company2.terraoi.app", await sessionCookieFor(OWNER1, "company1.terraoi.app")),
      ports: ports({
        findMembership: async (organisationId) => {
          lookedUp.push(organisationId);
          return null;
        },
      }),
    });
    expect(view.kind).toBe("sign_in");
    expect(lookedUp).toEqual([]);
  });

  it("no denied surface carries a tenant name, host or id (no branding beyond the public login surface)", async () => {
    for (const [host, cookie] of [
      ["nosuch.terraoi.app", null],
      ["company1.terraoi.app", await sessionCookieFor(OUTSIDER)],
      ["company1.terraoi.app", await sessionCookieFor(LEFT)],
    ] as const) {
      const view = await buildLoginView({ request: makeRequest(host, cookie), ports: ports() });
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("company1");
      expect(serialized).not.toContain("Company1");
      expect(serialized).not.toContain(C1);
      expect(serialized).not.toContain(OUTSIDER);
    }
  });

  it("a forged or expired cookie is treated as signed out, never as a stranger's session", async () => {
    const cookie = await sessionCookieFor(OWNER1);
    const [name, value] = cookie.split("=");
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", `${name}=${value}x`),
      ports: ports(),
    });
    expect(view.kind).toBe("sign_in");
  });

  it("a backend failure is a safe sign-in page, never a half-resolved context", async () => {
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(OWNER1)),
      ports: ports({ findMembership: async () => { throw new Error("database down"); } }),
    });
    expect(view.kind).toBe("sign_in");
    if (view.kind !== "sign_in") return;
    expect(view.outcome).toBe("unavailable");
  });

  it("without a signing secret nobody is treated as signed in", async () => {
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(OWNER1)),
      ports: ports({ signingSecret: () => null }),
    });
    expect(view.kind).toBe("sign_in");
  });

  it("carries a host-bound CSRF token for the form on the sign-in surface", async () => {
    const view = await buildLoginView({ request: makeRequest("company1.terraoi.app", null), ports: ports() });
    if (view.kind !== "sign_in") return;
    expect(view.csrfToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // A company2-issued token must not be usable on company1.
    const other = await buildLoginView({ request: makeRequest("company2.terraoi.app", null), ports: ports() });
    if (other.kind !== "sign_in") return;
    expect(other.csrfToken).not.toBe(view.csrfToken);
  });

  it("echoes only a whitelisted outcome, never free text from the query string", async () => {
    const signedIn = await buildLoginView({
      request: makeRequest("company1.terraoi.app", null),
      ports: ports(),
      outcome: "rate_limited",
    });
    expect(signedIn.kind === "sign_in" && signedIn.outcome).toBe("rate_limited");

    const junk = await buildLoginView({
      request: makeRequest("company1.terraoi.app", null),
      ports: ports(),
      outcome: "https://evil.example/Company1 Geotechnics",
    });
    expect(junk.kind === "sign_in" && junk.outcome).toBeNull();
  });

  it("a `next dev` origin only resolves when the adapter names the tenant it simulates (plan §4.1 step 1)", async () => {
    const withoutOverride = await buildLoginView({
      request: new Request("http://localhost:3000/login"),
      ports: ports(),
    });
    expect(withoutOverride).toEqual({ kind: "unknown_address" });

    vi.stubEnv("NODE_ENV", "development");
    const withOverride = await buildLoginView({
      request: new Request("http://localhost:3000/login"),
      ports: ports(),
      hostOptions: { developmentHost: "company1.terraoi.app" },
    });
    expect(withOverride.kind).toBe("sign_in");
  });
});
