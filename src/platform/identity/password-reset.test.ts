import { describe, expect, it } from "vitest";

import { completeMagicLink, type MagicLinkCallbackPorts } from "./complete-magic-link";
import { createLoginState, LOGIN_STATE_COOKIE_BASE } from "./login-state";
import { handlePasswordResetRequest, type PasswordResetPorts } from "./password-reset";
import { issueCsrfToken } from "./csrf";
import { signToken } from "./signed-token";
import { SESSION_COOKIE_BASE } from "./session";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";

/**
 * T-201's reset items. The credential half is GoTrue's again (`POST /auth/v1/recover`): this repo
 * neither stores nor verifies a password, so a reset request is a guarded call to the provider plus
 * one thing of our own — the login state we hand the recovery link is marked as a **recovery**, so
 * the callback that completes it knows to revoke the user's other sessions on this host before it
 * issues the new one.
 *
 * Revocation of other sessions is a `toi_identity` write, and the SQL for it is PR-2's migration; the
 * port therefore refuses today, and the completion fails closed rather than signing the user back in
 * while their old sessions stay live.
 *
 * No-address-probing is the same rule as the magic-link form: invited, unknown and rate-limited
 * requests for a recovery email must be indistinguishable, and an expired or already-used link gets
 * one generic answer (T-131 "No account probing").
 */

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000" } };
const NOW = 1_800_000_000;
const HOST_A = "company1.terraoi.app";
const HOST_B = "company2.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

function fakeJwt(what: string, sub: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT"}')}.${b64(`{"sub":"${sub}"}`)}.${b64(`synthetic-signature-${what}`)}`;
}
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

function memoryStore(): SessionStore & { rows: Map<string, StoredSession>; revocations: string[] } {
  const rows = new Map<string, StoredSession>();
  const revocations: string[] = [];
  return {
    rows,
    revocations,
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

// ------------------------------------------------------- the request half: POST /auth/password-reset

interface RequestHarness {
  ports: PasswordResetPorts;
  recoveries: Array<{ email: string; redirectTo: string }>;
  allowRequest: boolean;
  boom: boolean;
}

function requestHarness(overrides: Partial<RequestHarness> = {}): RequestHarness {
  const state: RequestHarness = { ports: {} as PasswordResetPorts, recoveries: [], allowRequest: true, boom: false, ...overrides };
  state.ports = {
    now: () => NOW,
    signingSecret: () => SECRET,
    findHost: async (host) =>
      host === HOST_A ? { organisationId: C1, organisationStatus: "active" } : host === HOST_B ? { organisationId: "22222222-2222-4222-8222-222222222222", organisationStatus: "active" } : null,
    rateLimitKey: async ({ host, email }) => `${host}|${email}`,
    allowRequest: async () => state.allowRequest,
    sendPasswordRecovery: async (input) => {
      if (state.boom) throw new Error("provider unavailable");
      state.recoveries.push(input);
    },
  };
  return state;
}

async function resetRequest(input: {
  host?: string;
  email?: string;
  csrf?: string | null;
  origin?: string | null;
  configure?: (h: RequestHarness) => void;
} = {}) {
  const h = requestHarness();
  if (input.configure) input.configure(h);
  const host = input.host ?? HOST_A;
  const csrf = input.csrf === null ? undefined : (input.csrf ?? (await issueCsrfToken({ host, secret: SECRET, now: NOW })));
  const params = new URLSearchParams();
  if (input.email !== undefined) params.set("email", input.email);
  if (csrf !== undefined) params.set("csrf_token", csrf);

  const headers = new Headers();
  if (input.origin !== null) headers.set("origin", input.origin ?? `https://${host}`);
  headers.set("content-type", "application/x-www-form-urlencoded");
  const response = await handlePasswordResetRequest({
    request: new Request(`https://${host}/auth/password-reset`, { method: "POST", headers, body: params.toString() }),
    ports: h.ports,
  });
  return { response, h };
}

const locationOf = (response: Response) => new URL(response.headers.get("location") as string);
const cookiesOf = (response: Response) => response.headers.getSetCookie();
const outcomeOf = (response: Response) => locationOf(response).searchParams.get("outcome");
const stateCookieOf = (response: Response) =>
  cookiesOf(response).find((c) => c.startsWith(`__Host-${LOGIN_STATE_COOKIE_BASE}=`)) ?? "";
const sessionCookieOf = (response: Response) =>
  cookiesOf(response).find((c) => c.startsWith(SESSION_COOKIE_BASE) || c.startsWith(`__Host-${SESSION_COOKIE_BASE}`)) ?? "";
/** Cookie attributes only: the value is random per request, so it can never be part of a comparison. */
const cookieShape = (response: Response) =>
  cookiesOf(response).map((c) => c.split("=")[0] + ";" + c.split(";").slice(1).map((p) => p.trim()).sort().join(";"));

describe("handlePasswordResetRequest (POST /auth/password-reset)", () => {
  it("asks the provider for a recovery link bound to this host's callback, and says only that a link was sent", async () => {
    const { response, h } = await resetRequest({ email: "owner1@company1.test" });
    expect(response.status).toBe(303);
    expect(outcomeOf(response)).toBe("link_sent");
    expect(locationOf(response).host).toBe(HOST_A);
    expect(h.recoveries).toHaveLength(1);
    const redirectTo = new URL(h.recoveries[0]?.redirectTo as string);
    expect(redirectTo.origin).toBe(`https://${HOST_A}`);
    expect(redirectTo.pathname).toBe("/auth/callback");
    expect(redirectTo.searchParams.get("state")).not.toBeNull();
    expect(stateCookieOf(response)).toMatch(/HttpOnly.*Secure.*SameSite=Lax/);
    expect(stateCookieOf(response)).not.toMatch(/domain=/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("a known address and an unknown one are indistinguishable, so the form is not an account oracle", async () => {
    const known = await resetRequest({ email: "owner1@company1.test" });
    const unknown = await resetRequest({ email: "no-such-person@example.test" });
    const malformed = await resetRequest({ email: "not-an-address" });
    expect(known.response.status).toBe(unknown.response.status);
    expect(known.response.headers.get("location")).toBe(unknown.response.headers.get("location"));
    expect(cookieShape(known.response)).toEqual(cookieShape(unknown.response));
    expect(unknown.response.headers.get("location")).toBe(malformed.response.headers.get("location"));
    expect(cookieShape(malformed.response)).toEqual(cookieShape(known.response));
  });

  it("canonicalizes the address before the provider and the limiter see it", async () => {
    const { h } = await resetRequest({ email: " Owner1@Company1.test " });
    expect(h.recoveries[0]?.email).toBe("owner1@company1.test");
  });

  it("keeps the same guard chain: origin, CSRF, content type, host, rate limit", async () => {
    expect((await resetRequest({ origin: "https://evil.example" })).response.status).toBe(403);
    expect((await resetRequest({ csrf: null })).response.status).toBe(403);
    expect((await resetRequest({ host: "nosuch.terraoi.app" })).response.status).toBe(404);
    const limited = await resetRequest({ email: "owner1@company1.test", configure: (s) => { s.allowRequest = false; } });
    expect(outcomeOf(limited.response)).toBe("rate_limited");
    expect(limited.h.recoveries).toHaveLength(0);
    // Rate limiting is not address-specific and says nothing about whether the account exists.
    const limitedUnknown = await resetRequest({ email: "nobody@example.test", configure: (s) => { s.allowRequest = false; } });
    expect(outcomeOf(limitedUnknown.response)).toBe("rate_limited");
  });

  it("a provider outage stays generic and keeps the state cookie it issued", async () => {
    const { response, h } = await resetRequest({ email: "owner1@company1.test", configure: (s) => { s.boom = true; } });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.recoveries).toHaveLength(0);
    const wire = `${await response.text()}${cookiesOf(response).join("\n")}`;
    expect(wire).not.toMatch(JWT_IN_TEXT);
  });
});

// ------------------------------------------------------- the completion half: the recovery callback

interface CallbackHarness {
  ports: MagicLinkCallbackPorts;
  store: SessionStore & { rows: Map<string, StoredSession>; revocations: string[] };
  exchanges: string[];
  redeemed: unknown[];
  revokeUserSessions: ((input: { userId: string; host: string; now: number }) => Promise<boolean>) | undefined;
  identity: "valid" | "invalid";
  order: string[];
}

function callbackHarness(overrides: Partial<CallbackHarness> = {}): CallbackHarness {
  const state: CallbackHarness = {
    ports: {} as MagicLinkCallbackPorts,
    store: memoryStore(),
    exchanges: [],
    redeemed: [],
    revokeUserSessions: async (input) => {
      state.order.push(`revoke:${input.userId}@${input.host}`);
      state.store.revocations.push(`${input.userId}@${input.host}`);
      return true;
    },
    identity: "valid",
    order: [],
    ...overrides,
  };
  state.ports = {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => state.store,
    tokenCipher: () => createTokenCipher(CIPHER),
    // Both tenants resolve, so a company1 state opened on company2 reaches the host check in the
    // login state rather than the "this host is not a tenant" 404 — the case the packet names.
    findHost: async (host) =>
      host === HOST_A
        ? { organisationId: C1, organisationStatus: "active" }
        : host === HOST_B
          ? { organisationId: "22222222-2222-4222-8222-222222222222", organisationStatus: "active" }
          : null,
    exchangeLoginCode: async () => {
      state.exchanges.push("exchange");
      if (state.identity === "invalid") return { ok: false, reason: "invalid_or_expired" };
      return {
        ok: true,
        userId: OWNER1,
        email: "owner1@company1.test",
        emailVerified: true,
        accessToken: fakeJwt("access", OWNER1),
        refreshToken: fakeJwt("refresh", OWNER1),
        tokenExpiresAt: NOW + 3600,
      };
    },
    findMembership: async (organisationId) =>
      organisationId === C1
        ? { membershipId: MEMBERSHIP, status: "active", roles: ["member"], permittedServiceKeys: [], permittedProjectIds: [] }
        : null,
    redeemInvitation: async (input) => {
      state.redeemed.push(input);
      return "not_found";
    },
    // Read through a getter, so a case that replaces `revokeUserSessions` (or removes it, the state
    // until PR-2 lands the SQL) is seen by the handler rather than captured at harness build time.
    get revokeUserSessions() {
      return state.revokeUserSessions;
    },
  };
  return state;
}

async function complete(input: {
  host?: string;
  stateHost?: string;
  flow?: "recovery" | undefined;
  configure?: (h: CallbackHarness) => void;
} = {}) {
  const h = callbackHarness();
  if (input.configure) input.configure(h);
  const stateHost = input.stateHost ?? input.host ?? HOST_A;
  const loginState = await createLoginState({ host: stateHost, secret: SECRET, now: NOW, secureTransport: true, flow: input.flow });
  const requestHost = input.host ?? HOST_A;
  const response = await completeMagicLink({
    request: new Request(`https://${requestHost}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
      headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
    }),
    ports: h.ports,
  });
  return { response, h, loginState };
}

describe("completing a password reset through the callback", () => {
  it("revokes the user's other sessions on this host before it issues the new one", async () => {
    const { response, h } = await complete({ flow: "recovery" });
    expect(h.store.revocations).toEqual([`${OWNER1}@${HOST_A}`]);
    expect(h.order[0]).toBe(`revoke:${OWNER1}@${HOST_A}`);
    expect(h.store.rows.size).toBe(1);
    expect(outcomeOf(response)).toBeNull();
    expect(locationOf(response).pathname).toBe("/");
    expect(sessionCookieOf(response)).toContain("__Host-toi_session=");
  });

  it("an ordinary sign-in does not revoke anything: only a marked recovery does", async () => {
    const { response, h } = await complete();
    expect(h.store.revocations).toHaveLength(0);
    expect(locationOf(response).pathname).toBe("/");
    expect(h.store.rows.size).toBe(1);
  });

  it("with the revocation not landed (the state until PR-2's SQL) a reset completion grants no session", async () => {
    const { response, h } = await complete({ flow: "recovery", configure: (s) => { s.revokeUserSessions = undefined; } });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.store.rows.size).toBe(0);
    expect(sessionCookieOf(response)).toBe("");
  });

  it("a revocation that fails grants no session either: a reset that did not revoke is not reported as one", async () => {
    const { response, h } = await complete({
      flow: "recovery",
      configure: (s) => {
        s.revokeUserSessions = async () => false;
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.store.rows.size).toBe(0);
    expect(sessionCookieOf(response)).toBe("");
  });

  it("a reset link opened on the wrong host yields no session", async () => {
    const { response, h } = await complete({ host: HOST_B, stateHost: HOST_A, flow: "recovery" });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(locationOf(response).host).toBe(HOST_B);
    expect(h.exchanges).toHaveLength(0);
    expect(h.store.revocations).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(sessionCookieOf(response)).toBe("");
    expect(cookiesOf(response).find((c) => c.includes(SESSION_COOKIE_BASE))).toBeUndefined();
  });

  it("a recovery link opened in a browser that never asked for one yields no session", async () => {
    const h = callbackHarness();
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true, flow: "recovery" });
    const response = await completeMagicLink({
      request: new Request(`https://${HOST_A}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: "theme=dark" }),
      }),
      ports: h.ports,
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.exchanges).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(h.store.revocations).toHaveLength(0);
  });

  it("an expired or already-used recovery link answers identically, with no session and no revocation", async () => {
    const used = await complete({ flow: "recovery", configure: (s) => { s.identity = "invalid"; } });
    const fresh = callbackHarness();
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW + 601, secureTransport: true, flow: "recovery" });
    const expired = await completeMagicLink({
      request: new Request(`https://${HOST_A}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
      }),
      ports: { ...fresh.ports, now: () => NOW + 1201 },
    });
    for (const response of [used.response, expired]) {
      expect(outcomeOf(response)).toBe("unavailable");
      expect(sessionCookieOf(response)).toBe("");
    }
    expect(used.response.headers.get("location")).toBe(expired.headers.get("location"));
    expect(used.h.store.rows.size).toBe(0);
    expect(used.h.store.revocations).toHaveLength(0);
  });

  it("a forged or unknown `flow` claim is not a recovery: the state is refused outright", async () => {
    for (const flow of ["reset", "recovery ", "", 1]) {
      const token = await signToken({ typ: "login_state", jti: "synthetic-nonce", host: HOST_A, pkce: "synthetic-verifier-000000000000000000000000000", flow, iat: NOW, exp: NOW + 600 }, SECRET);
      const h = callbackHarness();
      const response = await completeMagicLink({
        request: new Request(`https://${HOST_A}/auth/callback?code=synthetic-code&state=synthetic-nonce`, {
          headers: new Headers({ cookie: `${"__Host-"}${LOGIN_STATE_COOKIE_BASE}=${token}` }),
        }),
        ports: h.ports,
      });
      expect(outcomeOf(response)).toBe("unavailable");
      expect(h.exchanges).toHaveLength(0);
      expect(h.store.rows.size).toBe(0);
      expect(h.store.revocations).toHaveLength(0);
    }
  });
});
