import { describe, expect, it } from "vitest";

import { createLoginState } from "./login-state";
import { issueCsrfToken } from "./csrf";
import { handlePasswordSignIn, MAX_PASSWORD_CHARS, type PasswordSignInPorts } from "./password-signin";
import { SESSION_COOKIE_BASE, readSession } from "./session";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";

/**
 * T-201 acceptance item (positive): the seeded `owner1@company1.test` signs in with a password on
 * `company1.terraoi.app` and gets a session whose cookie is host-only, `Secure`, `HttpOnly`,
 * `SameSite=Lax`.
 *
 * What differs from the magic-link path is only how the credential reaches the provider: the password
 * goes to GoTrue's own credential endpoint (`grant_type=password`), and this repo stores and derives
 * nothing about it — no hashing dependency, no second credential store (AGENTS.md §6, and a new
 * dependency would need a supervisor decision). Everything after the provider answers is the same
 * completion tail as the magic-link callback — provider-verified email → the caller's own membership
 * read → one session row on this host — and that tail is asserted here too, because a second entry
 * point is exactly where a shared rule gets quietly dropped.
 */

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000" } };
const NOW = 1_800_000_000;
const HOST_A = "company1.terraoi.app";
const HOST_B = "company2.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const FIELD2 = "00000000-0000-4000-8000-0000000000a2";
const LEFT = "00000000-0000-4000-8000-0000000000a3";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";
const PASSWORD = "correct horse battery staple";

/** Pattern-shaped Supabase material, exactly as in the magic-link suite: shape, never a credential. */
function fakeJwt(what: string, sub: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT"}')}.${b64(`{"sub":"${sub}","email":"owner1@company1.test"}`)}.${b64(`synthetic-signature-${what}`)}`;
}
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

function exchangeFor(userId: string, email: string, emailVerified = true) {
  return {
    ok: true as const,
    userId,
    email,
    emailVerified,
    accessToken: fakeJwt("access", userId),
    refreshToken: fakeJwt("refresh", userId),
    tokenExpiresAt: NOW + 3600,
  };
}

type Membership = {
  membershipId: string;
  status: "invited" | "active" | "suspended" | "removed";
  roles: string[];
  permittedServiceKeys: string[];
  permittedProjectIds: string[];
};

function member(status: Membership["status"]): Membership {
  return { membershipId: MEMBERSHIP, status, roles: status === "active" ? ["member"] : [], permittedServiceKeys: [], permittedProjectIds: [] };
}

/** The in-memory stand-in for the session row; the SQL half is pgTAP's 014 and slot 012. */
function memoryStore(): SessionStore & { rows: Map<string, StoredSession> } {
  const rows = new Map<string, StoredSession>();
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
    async replaceTokens(sessionKey, replacement) {
      const row = rows.get(sessionKey);
      if (!row || row.revokedAt !== null) return false;
      rows.set(sessionKey, { ...row, ...replacement });
      return true;
    },
  };
}

interface Harness {
  ports: PasswordSignInPorts;
  store: SessionStore & { rows: Map<string, StoredSession> };
  attempts: Array<{ email: string; password: string; host: string }>;
  memberships: string[];
  redeemed: Array<{ organisationId: string; userId: string; email: string }>;
  identity: ReturnType<typeof exchangeFor> | { ok: false; reason: "invalid_or_expired" };
  membershipFor: (organisationId: string, userId: string) => Membership | null;
  boom: boolean;
  allowRequest: boolean;
  sessionStore: () => SessionStore | null;
  tokenCipher: () => ReturnType<typeof createTokenCipher> | null;
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const state: Harness = {
    attempts: [],
    memberships: [],
    redeemed: [],
    identity: exchangeFor(OWNER1, "owner1@company1.test"),
    membershipFor: (organisationId, userId) =>
      organisationId !== C1 ? null : userId === OWNER1 ? member("active") : userId === LEFT ? member("suspended") : null,
    boom: false,
    allowRequest: true,
    ports: {} as PasswordSignInPorts,
    store: memoryStore(),
    sessionStore: () => state.store,
    tokenCipher: () => createTokenCipher(CIPHER),
  };
  Object.assign(state, overrides);
  state.ports = {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => state.sessionStore(),
    tokenCipher: () => state.tokenCipher(),
    findHost: async (host) =>
      host === HOST_A
        ? { organisationId: C1, organisationStatus: "active" }
        : host === HOST_B
          ? { organisationId: C2, organisationStatus: "active" }
          : null,
    rateLimitKey: async ({ host, email }) => `${host}|${email}`,
    allowRequest: async () => state.allowRequest,
    exchangePasswordCredentials: async (input) => {
      if (state.boom) throw new Error("auth provider unavailable");
      state.attempts.push(input);
      return state.identity;
    },
    // No user argument, exactly like `current_membership_v1`: which row comes back follows the token
    // this flow is holding (ADR-0003 §3b).
    findMembership: async (organisationId, accessToken) => {
      if (state.boom) throw new Error("database unavailable");
      const userId = state.identity.ok && state.identity.accessToken === accessToken ? state.identity.userId : "";
      state.memberships.push(`${organisationId}:${userId}`);
      return state.membershipFor(organisationId, userId);
    },
    redeemInvitation: async (input) => {
      state.redeemed.push(input);
      return "not_found";
    },
  };
  return state;
}

async function post(input: {
  host?: string;
  email?: string;
  password?: string;
  csrf?: string | null;
  extra?: Record<string, string>;
  origin?: string | null;
  contentType?: string;
  method?: string;
  cookieHeader?: string | null;
  rawBody?: string;
  configure?: (h: Harness) => void;
} = {}) {
  const h = harness();
  if (input.configure) input.configure(h);
  const host = input.host ?? HOST_A;
  const csrf = input.csrf === null ? undefined : (input.csrf ?? (await issueCsrfToken({ host, secret: SECRET, now: NOW })));

  const params = new URLSearchParams(input.extra ?? {});
  if (input.email !== undefined) params.set("email", input.email);
  else params.set("email", "owner1@company1.test");
  params.set("password", input.password ?? PASSWORD);
  if (csrf !== undefined) params.set("csrf_token", csrf);

  const headers = new Headers();
  if (input.origin !== null) headers.set("origin", input.origin ?? `https://${host}`);
  headers.set("content-type", input.contentType ?? "application/x-www-form-urlencoded");
  if (input.cookieHeader) headers.set("cookie", input.cookieHeader);

  const method = input.method ?? "POST";
  const response = await handlePasswordSignIn({
    request: new Request(`https://${host}/auth/password`, {
      method,
      headers,
      // A GET must not carry a body at all (the fetch layer refuses one), so the method-guard case
      // posts nothing: what is under test is that the handler answers 405 before reading anything.
      ...(method === "GET" ? {} : { body: input.rawBody ?? params.toString() }),
    }),
    ports: h.ports,
  });
  return { response, h };
}

const locationOf = (response: Response) => new URL(response.headers.get("location") as string);
const cookiesOf = (response: Response) => response.headers.getSetCookie();
const sessionCookieOf = (response: Response) =>
  cookiesOf(response).find((c) => c.startsWith(SESSION_COOKIE_BASE) || c.startsWith(`__Host-${SESSION_COOKIE_BASE}`)) ?? "";
const outcomeOf = (response: Response) => locationOf(response).searchParams.get("outcome");

describe("handlePasswordSignIn (POST /auth/password)", () => {
  it("gives the seeded owner a host-only, Secure, HttpOnly, SameSite=Lax session and sends them to the workspace", async () => {
    const { response, h } = await post();
    expect(response.status).toBe(303);
    expect(locationOf(response).host).toBe(HOST_A);
    expect(locationOf(response).pathname).toBe("/");
    expect(sessionCookieOf(response)).toMatch(
      /^__Host-toi_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(cookiesOf(response).join("\n")).not.toMatch(/domain=/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]).toEqual({ email: "owner1@company1.test", password: PASSWORD, host: HOST_A });
  });

  it("the session is a server-side row on the routed host, with the token pair sealed and never replayable next door", async () => {
    const { response, h } = await post();
    const value = (sessionCookieOf(response).split(";")[0] as string).split("=")[1] as string;
    expect(h.store.rows.size).toBe(1);
    const [sessionKey, row] = [...h.store.rows.entries()][0] as [string, StoredSession];
    expect(sessionKey).not.toBe(value);
    expect(row.userId).toBe(OWNER1);
    expect(row.host).toBe(HOST_A);
    expect(row.revokedAt).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(JWT_IN_TEXT);

    const cookieHeader = `__Host-${SESSION_COOKIE_BASE}=${value}`;
    expect(await readSession({ cookieHeader, host: HOST_A, now: NOW, store: h.store })).toMatchObject({ ok: true, userId: OWNER1 });
    expect(await readSession({ cookieHeader, host: HOST_B, now: NOW, store: h.store })).toMatchObject({ ok: false, reason: "host_mismatch" });
  });

  it("neither the password nor any Supabase JWT-shaped value reaches the browser", async () => {
    const { response } = await post();
    const body = await response.text();
    const everyHeader = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
    const wire = `${everyHeader}\n${body}\n${cookiesOf(response).join("\n")}\n${response.headers.get("location") ?? ""}`;
    expect(wire.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
    expect(wire.toLowerCase()).not.toContain("password");
    expect(wire).not.toMatch(JWT_IN_TEXT);
    for (const cookie of cookiesOf(response)) expect(cookie).not.toMatch(JWT_IN_TEXT);
  });

  it("canonicalizes the typed address before the provider and the limiter see it", async () => {
    const { h } = await post({ email: " Owner1@Company1.test " });
    expect(h.attempts).toHaveLength(1);
    const sent = h.attempts[0]?.email as string;
    expect(sent).toBe("owner1@company1.test");
  });

  it("the invited claim can only be made for the provider-verified address, never the one named in the form", async () => {
    const { response, h } = await post({
      email: "field2@company1.test",
      configure: (s) => {
        // The provider verified an address different from the form's: the invite is bound to the
        // verified one, so only that one may reach the claim (plan §4.2, F05).
        s.identity = exchangeFor(FIELD2, "someone.else@example.test");
        s.membershipFor = (organisationId, userId) =>
          organisationId === C1 && userId === FIELD2 ? member("invited") : null;
      },
    });
    expect(h.redeemed).toHaveLength(1);
    const claim = h.redeemed[0] as { organisationId: string; userId: string; email: string };
    expect(claim.email).toBe("someone.else@example.test");
    expect(claim.email).not.toBe("field2@company1.test");
    expect(claim.organisationId).toBe(C1);
    expect(claim.userId).toBe(FIELD2);
    // The claim did not succeed, so access did not follow it — only a session and the no-access page.
    expect(outcomeOf(response)).toBe("not_a_member");
    expect(sessionCookieOf(response)).toContain("__Host-toi_session=");
  });

  it("an unknown address and a wrong password give one indistinguishable answer and read no tenant data", async () => {
    const first = await post({ configure: (s) => { s.identity = { ok: false, reason: "invalid_or_expired" }; } });
    const second = await post({ email: "nobody@nowhere.example", configure: (s) => { s.identity = { ok: false, reason: "invalid_or_expired" }; } });
    for (const { response, h } of [first, second]) {
      expect(outcomeOf(response)).toBe("invalid_credentials");
      expect(locationOf(response).pathname).toBe("/login");
      expect(sessionCookieOf(response)).toBe("");
      expect(h.memberships).toHaveLength(0);
      expect(h.store.rows.size).toBe(0);
    }
    expect(second.response.headers.get("location")).toBe(first.response.headers.get("location"));
    expect(second.response.headers.getSetCookie()).toEqual(first.response.headers.getSetCookie());
    expect(second.response.status).toBe(first.response.status);
  });

  it("a malformed address never reaches the provider and answers the same way as a wrong password", async () => {
    const bad = await post({ email: "not-an-address" });
    const wrongCredential = await post({ configure: (s) => { s.identity = { ok: false, reason: "invalid_or_expired" }; } });
    expect(bad.h.attempts).toHaveLength(0);
    expect(outcomeOf(bad.response)).toBe(outcomeOf(wrongCredential.response));
    expect(sessionCookieOf(bad.response)).toBe("");
  });

  it("an absurdly long password is refused before the provider is dialed", async () => {
    const { response, h } = await post({ password: "x".repeat(MAX_PASSWORD_CHARS + 1) });
    expect(outcomeOf(response)).toBe("invalid_credentials");
    expect(h.attempts).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
  });

  it("a missing or empty password is refused before the provider is dialed", async () => {
    for (const body of [
      new URLSearchParams({ email: "owner1@company1.test", csrf_token: await issueCsrfToken({ host: HOST_A, secret: SECRET, now: NOW }) }).toString(),
      new URLSearchParams({ email: "owner1@company1.test", password: "", csrf_token: await issueCsrfToken({ host: HOST_A, secret: SECRET, now: NOW }) }).toString(),
    ]) {
      const { response, h } = await post({ rawBody: body });
      expect(outcomeOf(response)).toBe("invalid_credentials");
      expect(h.attempts).toHaveLength(0);
    }
  });

  it("a suspended member gets a session and only the no-access outcome, with no claim attempted", async () => {
    const { response, h } = await post({
      email: "left@company1.test",
      configure: (s) => {
        s.identity = exchangeFor(LEFT, "left@company1.test");
      },
    });
    expect(outcomeOf(response)).toBe("not_a_member");
    expect(locationOf(response).pathname).toBe("/login");
    expect(locationOf(response).host).toBe(HOST_A);
    expect(sessionCookieOf(response)).toContain("__Host-toi_session=");
    expect(h.redeemed).toHaveLength(0);
    expect(h.memberships).toEqual([`${C1}:${LEFT}`]);
  });

  it("the organization is the routed host's alone: planted organization ids in the body change nothing", async () => {
    const { response, h } = await post({
      extra: { organisation_id: C2, p_organisation_id: C2, host: HOST_B, tenant: "company2" },
    });
    expect(h.attempts[0]?.host).toBe(HOST_A);
    expect(h.memberships).toEqual([`${C1}:${OWNER1}`]);
    expect(h.memberships).not.toContain(`${C2}:${OWNER1}`);
    expect(locationOf(response).host).toBe(HOST_A);
    expect(h.redeemed).toHaveLength(0);
  });

  it("refuses a company1 CSRF token posted at company2's host", async () => {
    const csrfForA = await issueCsrfToken({ host: HOST_A, secret: SECRET, now: NOW });
    const { response, h } = await post({ host: HOST_B, csrf: csrfForA });
    expect(response.status).toBe(403);
    expect(h.attempts).toHaveLength(0);
    expect(h.memberships).toHaveLength(0);
    expect(cookiesOf(response)).toHaveLength(0);
  });

  it("the guard chain answers before any credential is read: method, host, origin, content type, size, CSRF, rate limit", async () => {
    expect((await post({ method: "GET" })).response.status).toBe(405);

    const deadHost = await post({ host: "nosuch.terraoi.app" });
    expect(deadHost.response.status).toBe(404);
    expect(cookiesOf(deadHost.response)).toHaveLength(0);

    expect((await post({ origin: "https://evil.example" })).response.status).toBe(403);
    expect((await post({ origin: `https://${HOST_A}.evil.example` })).response.status).toBe(403);
    expect((await post({ origin: null })).response.status).toBe(403);
    expect((await post({ contentType: "application/json" })).response.status).toBe(415);
    expect((await post({ contentType: "text/plain" })).response.status).toBe(415);

    const huge = await handlePasswordSignIn({
      request: new Request(`https://${HOST_A}/auth/password`, {
        method: "POST",
        headers: { origin: `https://${HOST_A}`, "content-type": "application/x-www-form-urlencoded" },
        body: `email=${"a".repeat(9000)}`,
      }),
      ports: harness().ports,
    });
    expect(huge.status).toBe(413);

    const forged = await post({ csrf: "forged-token" });
    expect(forged.response.status).toBe(403);
    expect(forged.h.attempts).toHaveLength(0);

    const missing = await post({ csrf: null });
    expect(missing.response.status).toBe(403);

    const limited = await post({ configure: (s) => { s.allowRequest = false; } });
    expect(outcomeOf(limited.response)).toBe("rate_limited");
    expect(limited.h.attempts).toHaveLength(0);
    expect(limited.h.memberships).toHaveLength(0);
  });

  it("with no session store or no token cipher wired the provider is never dialed: there is no fallback cookie", async () => {
    for (const configure of [
      (s: Harness) => {
        s.sessionStore = () => null;
      },
      (s: Harness) => {
        s.tokenCipher = () => null;
      },
    ]) {
      const { response, h } = await post({ configure });
      expect(outcomeOf(response)).toBe("unavailable");
      expect(h.attempts).toHaveLength(0);
      expect(h.store.rows.size).toBe(0);
      expect(sessionCookieOf(response)).toBe("");
    }
  });

  it("a provider or database outage fails closed: generic outcome, no session, no credential in the answer", async () => {
    const { response, h } = await post({ configure: (s) => { s.boom = true; } });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.attempts).toHaveLength(0);
    expect(sessionCookieOf(response)).toBe("");
    const wire = `${await response.text()}${cookiesOf(response).join("\n")}${response.headers.get("location") ?? ""}`;
    expect(wire).not.toMatch(JWT_IN_TEXT);
    // The harness's own failure strings, so this can fail: the detail that says *which* dependency broke
    // (provider or database) is exactly what must not reach a browser.
    expect(wire).not.toContain("auth provider unavailable");
    expect(wire).not.toContain("database unavailable");
    expect(wire.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
  });

  it("a login-state cookie is not a credential: a password post still needs the CSRF token", async () => {
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const { response, h } = await post({
      csrf: null,
      cookieHeader: `${loginState.cookie.name}=${loginState.cookie.value}`,
    });
    expect(response.status).toBe(403);
    expect(h.attempts).toHaveLength(0);
  });

  it("an unverified provider email grants nothing, so a provider that cannot verify cannot link", async () => {
    const { response, h } = await post({
      configure: (s) => {
        s.identity = exchangeFor(OWNER1, "owner1@company1.test", false);
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.memberships).toHaveLength(0);
    expect(sessionCookieOf(response)).toBe("");
    expect(h.store.rows.size).toBe(0);
  });
});
