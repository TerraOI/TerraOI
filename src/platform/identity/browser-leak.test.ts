import { describe, expect, it } from "vitest";

import { completeMagicLink } from "./complete-magic-link";
import { handleMagicLinkRequest } from "./request-magic-link";
import { handleSignOut } from "./sign-out";
import { buildLoginView } from "./login-view";
import { buildIdentityPorts, type FetchImpl } from "./adapters";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";
import { issueCsrfToken } from "./csrf";
import { createLoginState } from "./login-state";

/**
 * #37's hard condition, tested end to end over the routes T-102 owns:
 *
 *   "Supabase tokens are **never sent to the browser** (no client-side supabase-js session, no token
 *    in a cookie or in the page data). … A test should pin it, for example: no Set-Cookie and no
 *    rendered HTML contains a Supabase JWT."
 *
 * Why it matters in this design: `register_source_version_v1` trusts the hash and size the Worker
 * passes after verifying the bytes. A browser that held a user token could call it directly and skip
 * that check. So "the token stays on the server" is not a style preference, it is what makes Lane 2's
 * capture RPCs safe — and it is pinned here with provider-shaped material, not placeholders.
 *
 * The fixtures are JWT-shaped (`eyJ…`.`eyJ…`.`…`) on purpose: a test that used "tok123" would pass
 * while a real token leaked.
 */

const HOST = "company1.terraoi.app";
const NOW = 1_800_000_000;
const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const TOKEN_KEY = "synthetic-session-token-key-not-a-real-key-0000000";
const CIPHER = { currentVersion: "v1", keys: { v1: TOKEN_KEY } };
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const C1 = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

function fakeJwt(what: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT","role":"authenticated"}')}.${b64(
    `{"sub":"${OWNER1}","email":"owner1@company1.test","exp":${NOW + 3600}}`,
  )}.${b64(`synthetic-signature-${what}`)}`;
}
const ACCESS_TOKEN = fakeJwt("access");
const REFRESH_TOKEN = fakeJwt("refresh");
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

function memoryStore(): SessionStore & { rows: Map<string, StoredSession> } {
  const rows = new Map<string, StoredSession>();
  return {
    rows,
    async insert({ sessionKey, session }) {
      rows.set(sessionKey, session);
    },
    async find(sessionKey) {
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

/**
 * The provider, recorded: the PKCE exchange hands back exactly the pair a real Supabase project would.
 * A unit test that stubbed the exchange to return nothing would not have caught a token on the wire.
 */
function provider() {
  const sent: string[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    sent.push(`${url} ${init.body}`);
    if (url.endsWith("/auth/v1/signup")) return { ok: true, status: 200, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: ACCESS_TOKEN,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
        user: { id: OWNER1, email: "owner1@company1.test", email_confirmed_at: "2026-11-05T00:00:00Z" },
      }),
    };
  };
  return { sent, fetchImpl };
}

function portsFor(store: SessionStore, providerHalf: { sent: string[]; fetchImpl: FetchImpl }) {
  const base = buildIdentityPorts(
    {
      IDENTITY_SESSION_KEY: SECRET,
      SESSION_TOKEN_KEY: TOKEN_KEY,
      SUPABASE_URL: "https://synthetic.supabase.co",
      SUPABASE_ANON_KEY: "synthetic-anon-key",
      IDENTITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    { fetchImpl: providerHalf.fetchImpl },
  );
  // The store is the #75 blank in production; this test wires the in-memory one so the leak property
  // can be checked on a *successful* sign-in, which is the only interesting case.
  return {
    ...base,
    sessionStore: () => store,
    tokenCipher: () => createTokenCipher(CIPHER),
    findHost: async (host: string) => (host === HOST ? { organisationId: C1, organisationStatus: "active" as const } : null),
    findMembership: async (organisationId: string, userId: string) =>
      organisationId === C1 && userId === OWNER1
        ? { membershipId: MEMBERSHIP, status: "active" as const, roles: ["member"], permittedServiceKeys: [], permittedProjectIds: [] }
        : null,
    policyRevision: async () => 1,
  };
}

function everyByteTheBrowserReceives(response: Response, body: string): string {
  const headers = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`);
  return [String(response.status), ...headers, body].join("\n");
}

async function leakScan(label: string, response: Response): Promise<string> {
  const body = await response.text();
  const wire = everyByteTheBrowserReceives(response, body);
  expect(wire, label).not.toMatch(JWT_IN_TEXT);
  expect(wire, label).not.toContain(ACCESS_TOKEN);
  expect(wire, label).not.toContain(REFRESH_TOKEN);
  // Not even encoded or split: a partial token is still a token.
  expect(wire, label).not.toContain(ACCESS_TOKEN.slice(0, 24));
  return wire;
}

describe("no Supabase token reaches the browser on the sign-in routes (#37 hard condition)", () => {
  it("POST /auth/magic-link sets only a login-state cookie, and no token material anywhere", async () => {
    const store = memoryStore();
    const providerHalf = provider();
    const csrf = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
    const response = await handleMagicLinkRequest({
      request: new Request(`https://${HOST}/auth/magic-link`, {
        method: "POST",
        headers: { origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "owner1@company1.test", csrf_token: csrf }).toString(),
      }),
      ports: portsFor(store, providerHalf),
    });
    const wire = await leakScan("POST /auth/magic-link", response);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith("__Host-toi_login_state="))).toBe(true);
    expect(cookies.join("\n")).not.toMatch(JWT_IN_TEXT);
  });

  it("GET /auth/callback: the pair arrives from the provider and only an opaque id leaves", async () => {
    const store = memoryStore();
    const providerHalf = provider();
    const loginState = await createLoginState({ host: HOST, secret: SECRET, now: NOW, secureTransport: true });
    const response = await completeMagicLink({
      request: new Request(`https://${HOST}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
      }),
      ports: portsFor(store, providerHalf),
    });
    const wire = await leakScan("GET /auth/callback", response);

    const sessionCookies = response.headers.getSetCookie().filter((cookie) => cookie.startsWith("__Host-toi_session="));
    expect(sessionCookies).toHaveLength(1);
    const value = (sessionCookies[0] as string).split(";")[0]?.split("=")[1] as string;
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The token pair is real on the server side (otherwise the session would be useless) and absent
    // from everything the browser receives.
    expect(store.rows.size).toBe(1);
    const row = [...store.rows.values()][0] as StoredSession;
    expect(await createTokenCipher(CIPHER).open(row.accessCiphertext)).toBe(ACCESS_TOKEN);
    expect(wire).not.toContain(row.accessCiphertext);
    expect(wire).not.toContain(row.refreshCiphertext);
  });

  it("POST /auth/sign-out leaks nothing either", async () => {
    const store = memoryStore();
    const providerHalf = provider();
    const loginState = await createLoginState({ host: HOST, secret: SECRET, now: NOW, secureTransport: true });
    const signIn = await completeMagicLink({
      request: new Request(`https://${HOST}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
      }),
      ports: portsFor(store, providerHalf),
    });
    await signIn.text();
    const sessionCookie = signIn.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-toi_session=")) as string;
    const cookieHeader = sessionCookie.split(";")[0] as string;

    const csrf = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
    const response = await handleSignOut({
      request: new Request(`https://${HOST}/auth/sign-out`, {
        method: "POST",
        headers: { origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader },
        body: new URLSearchParams({ csrf_token: csrf }).toString(),
      }),
      ports: portsFor(store, providerHalf),
    });
    await leakScan("POST /auth/sign-out", response);
    // Revoked server-side, at the deployment clock (this adapter's `now()` is wall time).
    const revokedAt = [...store.rows.values()][0]?.revokedAt;
    expect(revokedAt).not.toBeNull();
    expect(revokedAt as number).toBeGreaterThan(1_700_000_000);
  });

  // The login surface is the HTML a tenant origin renders for /login. The page itself is held by #55,
  // so the assertion runs on what that page is given to render: the view object is exactly what a
  // Server Component would serialize into the document.
  it("the login view a tenant page would render carries no token and no session material", async () => {
    const store = memoryStore();
    const providerHalf = provider();
    const loginState = await createLoginState({ host: HOST, secret: SECRET, now: NOW, secureTransport: true });
    const signIn = await completeMagicLink({
      request: new Request(`https://${HOST}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
      }),
      ports: portsFor(store, providerHalf),
    });
    await signIn.text();
    const sessionCookie = signIn.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-toi_session=")) as string;

    const view = await buildLoginView({
      request: new Request(`https://${HOST}/login`, { headers: new Headers({ cookie: sessionCookie.split(";")[0] as string }) }),
      ports: portsFor(store, providerHalf),
    });
    const rendered = JSON.stringify(view);
    expect(rendered).not.toMatch(JWT_IN_TEXT);
    expect(rendered).not.toContain(ACCESS_TOKEN);
    expect(rendered).not.toContain(REFRESH_TOKEN);
    const row = [...store.rows.values()][0] as StoredSession;
    expect(rendered).not.toContain(row.accessCiphertext);
    expect(view.kind).toBe("signed_in");
  });
});
