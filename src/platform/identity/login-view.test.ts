import { afterEach, describe, expect, it, vi } from "vitest";

import { issueSession } from "./session";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";
import { buildLoginView, type LoginViewPorts } from "./login-view";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
// A synthetic keyring, never a real one: the token half is encrypted at rest under the
// `SESSION_TOKEN_KEY` Worker binding, whose value does not exist in this repo (AGENTS.md §4.6).
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-0000000000" } };

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const LEFT = "00000000-0000-4000-8000-0000000000a3";
const OUTSIDER = "00000000-0000-4000-8000-0000000000b1";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

/** The in-memory stand-in for `toi_identity.sessions`; the SQL half is pgTAP's job (014). */
function memoryStore(rows: Map<string, StoredSession> = new Map()): SessionStore & { rows: Map<string, StoredSession> } {
  return {
    rows,
    async insert({ sessionKey, session }) {
      rows.set(sessionKey, session);
    },
    async find({ sessionKey }) {
      return rows.get(sessionKey) ?? null;
    },
    async revoke(sessionKey, at) {
      const row = rows.get(sessionKey);
      if (row) rows.set(sessionKey, { ...row, revokedAt: at });
    },
    async replaceTokens(sessionKey, replacement, _now) {
      const row = rows.get(sessionKey);
      if (!row || row.revokedAt !== null) return false;
      rows.set(sessionKey, { ...row, ...replacement });
      return true;
    },
  };
}

// The seeded identities and hosts of supabase/seed.sql: the gate is the thing that decides who sees
// the no-access surface, so the fixtures are the ones the staging demo will use.
function ports(overrides: Partial<LoginViewPorts> = {}): LoginViewPorts {
  return {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => null,
    tokenCipher: () => createTokenCipher(CIPHER),
    findHost: async (host) =>
      host === "company1.terraoi.app" || host === "company2.terraoi.app"
        ? { organisationId: host === "company1.terraoi.app" ? C1 : C2, organisationStatus: "active" }
        : null,
    findMembership: async (organisationId, userId, _accessToken) =>
      organisationId === C1 && userId === OWNER1
        ? { membershipId: MEMBERSHIP, status: "active", roles: ["member"], permittedServiceKeys: [], permittedProjectIds: [] }
        : organisationId === C1 && userId === LEFT
          ? { membershipId: MEMBERSHIP, status: "suspended", roles: [], permittedServiceKeys: [], permittedProjectIds: [] }
          : null,
    policyRevision: async (_organisationId, _accessToken) => 1,
    ...overrides,
  };
}

async function sessionCookieFor(store: SessionStore, userId: string, host = "company1.terraoi.app") {
  const session = await issueSession({
    userId,
    host,
    now: NOW,
    secureTransport: true,
    store,
    cipher: createTokenCipher(CIPHER),
    tokens: { accessToken: "synthetic-access-token", refreshToken: "synthetic-refresh-token", expiresAt: NOW + 3600 },
  });
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
    const store = memoryStore();
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(store, OWNER1)),
      ports: ports({ sessionStore: () => store,
    tokenCipher: () => createTokenCipher({ currentVersion: 'v1', keys: { v1: 'test-session-token-key-32b!!!!!!' } }), findHost: async () => ({ organisationId: C1, organisationStatus: "suspended" }) }),
    });
    expect(view).toEqual({ kind: "tenant_not_live" });
  });

  // Acceptance item: a valid identity with no / suspended / invited membership sees the generic
  // no-access page. Identity alone grants nothing (plan §4.2, F02).
  it("a live session for a stranger to this tenant is no_access", async () => {
    const store = memoryStore();
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(store, OUTSIDER)),
      ports: ports({ sessionStore: () => store }),
    });
    expect(view).toEqual({ kind: "no_access", reason: "not_a_member" });
  });

  it("a live session for a suspended member is no_access, whatever the row said when it was issued", async () => {
    const store = memoryStore();
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(store, LEFT)),
      ports: ports({ sessionStore: () => store }),
    });
    expect(view).toEqual({ kind: "no_access", reason: "membership_not_active" });
  });

  it("an invited membership grants no access on its own", async () => {
    const store = memoryStore();
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(store, OUTSIDER)),
      ports: ports({
        sessionStore: () => store,
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
    const store = memoryStore();
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(store, OWNER1)),
      ports: ports({ sessionStore: () => store }),
    });
    expect(view).toEqual({ kind: "signed_in" });
  });

  it("a revoked session is signed out at once, even while the cookie and the membership are valid", async () => {
    const store = memoryStore();
    const cookie = await sessionCookieFor(store, OWNER1);
    const [name, value] = cookie.split("=") as [string, string];
    for (const row of store.rows.values()) row.revokedAt = NOW + 60;
    const view = await buildLoginView({ request: makeRequest("company1.terraoi.app", `${name}=${value}`), ports: ports({ sessionStore: () => store }) });
    expect(view.kind).toBe("sign_in");
  });

  // Acceptance item: the session cookie of company1 is not accepted on company2. It is not a
  // weaker company2 session — it is no session at all, so nothing looks a user up in company2 and
  // the visitor is asked to sign in on the host they actually reached (plan §4.2, F02 cross-host replay).
  it("a company1 session on company2 is no session at all: no membership lookup, no tenant data", async () => {
    const store = memoryStore();
    const lookedUp: string[] = [];
    const view = await buildLoginView({
      request: makeRequest("company2.terraoi.app", await sessionCookieFor(store, OWNER1, "company1.terraoi.app")),
      ports: ports({
        sessionStore: () => store,
    tokenCipher: () => createTokenCipher({ currentVersion: 'v1', keys: { v1: 'test-session-token-key-32b!!!!!!' } }),
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
    const store = memoryStore();
    for (const [host, cookie] of [
      ["nosuch.terraoi.app", null],
      ["company1.terraoi.app", await sessionCookieFor(store, OUTSIDER)],
      ["company1.terraoi.app", await sessionCookieFor(store, LEFT)],
    ] as const) {
      const view = await buildLoginView({ request: makeRequest(host, cookie), ports: ports({ sessionStore: () => store }) });
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("company1");
      expect(serialized).not.toContain("Company1");
      expect(serialized).not.toContain(C1);
      expect(serialized).not.toContain(OUTSIDER);
    }
  });

  it("a tampered or never-issued session id is treated as signed out, never as a stranger's session", async () => {
    const store = memoryStore();
    const cookie = await sessionCookieFor(store, OWNER1);
    const [name, value] = cookie.split("=") as [string, string];
    const tampered = await buildLoginView({
      request: makeRequest("company1.terraoi.app", `${name}=${value}x`),
      ports: ports({ sessionStore: () => store }),
    });
    expect(tampered.kind).toBe("sign_in");

    const neverIssued = await buildLoginView({
      request: makeRequest("company1.terraoi.app", `${name}=Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2`),
      ports: ports({ sessionStore: () => store }),
    });
    expect(neverIssued.kind).toBe("sign_in");
  });

  it("a backend failure is a safe sign-in page, never a half-resolved context", async () => {
    const store = memoryStore();
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(store, OWNER1)),
      ports: ports({ sessionStore: () => store,
    tokenCipher: () => createTokenCipher({ currentVersion: 'v1', keys: { v1: 'test-session-token-key-32b!!!!!!' } }), findMembership: async () => { throw new Error("database down"); } }),
    });
    expect(view.kind).toBe("sign_in");
    if (view.kind !== "sign_in") return;
    expect(view.outcome).toBe("unavailable");
  });

  // #37 option (b) means a session only exists as a row. With no store wired — the state of every
  // deployment until #75 settles how the row is reached — a presented cookie must not be trusted.
  it("with no session store wired, a presented session cookie signs nobody in", async () => {
    const store = memoryStore();
    const cookie = await sessionCookieFor(store, OWNER1);
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", cookie),
      ports: ports({ sessionStore: () => null }),
    });
    expect(view.kind).toBe("sign_in");
  });

  it("a session store that throws is signed out, not signed in", async () => {
    const store = memoryStore();
    const cookie = await sessionCookieFor(store, OWNER1);
    const view = await buildLoginView({
      request: makeRequest("company1.terraoi.app", cookie),
      ports: ports({
        sessionStore: () => ({
          insert: async () => {},
          find: async () => {
            throw new Error("connection lost");
          },
          revoke: async () => {},
          replaceTokens: async () => true,
        }),
      }),
    });
    expect(view.kind).toBe("sign_in");
  });

  // After #37 the session and the CSRF token are two different secrets: the session is a row, so a
  // deployment with no `IDENTITY_SESSION_KEY` still recognizes a live session — and still must not
  // hand out a CSRF token it cannot verify.
  it("without a signing secret a live session is still a session, but the form gets no CSRF token", async () => {
    const store = memoryStore();
    const withCookie = await buildLoginView({
      request: makeRequest("company1.terraoi.app", await sessionCookieFor(store, OWNER1)),
      ports: ports({ sessionStore: () => store, signingSecret: () => null }),
    });
    expect(withCookie).toEqual({ kind: "signed_in" });

    const signedOut = await buildLoginView({
      request: makeRequest("company1.terraoi.app", null),
      ports: ports({ signingSecret: () => null }),
    });
    expect(signedOut.kind).toBe("sign_in");
    if (signedOut.kind !== "sign_in") return;
    expect(signedOut.csrfToken).toBeNull();
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
