import { describe, expect, it, vi } from "vitest";

import { handleSignOut } from "./sign-out";
import { issueSession, readSession } from "./session";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";
import { issueCsrfToken } from "./csrf";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000" } };
const NOW = 1_800_000_000;
const HOST = "company1.terraoi.app";
const OTHER = "company2.terraoi.app";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const C1 = "11111111-1111-4111-8111-111111111111";

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
    async replaceTokens(sessionKey, replacement, _now) {
      const row = rows.get(sessionKey);
      if (!row || row.revokedAt !== null) return false;
      rows.set(sessionKey, { ...row, ...replacement });
      return true;
    },
  };
}

function ports(store: SessionStore | null = memoryStore()) {
  return {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => store,
    findHost: async (host: string) => (host === HOST ? { organisationId: C1, organisationStatus: "active" as const } : null),
  };
}

async function post(host: string, options: { origin?: string | null; csrf?: string | null; cookie?: string | null } = {}) {
  const fields = new URLSearchParams();
  if (options.csrf !== null) fields.set("csrf_token", options.csrf ?? (await issueCsrfToken({ host, secret: SECRET, now: NOW })));
  return new Request(`https://${host}/auth/sign-out`, {
    method: "POST",
    headers: {
      ...(options.origin === null ? {} : { origin: options.origin ?? `https://${host}` }),
      "content-type": "application/x-www-form-urlencoded",
      ...(options.cookie === null || options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: fields.toString(),
  });
}

/** Sign in the way the callback does, and return the cookie header the browser would hold. */
async function signedIn(store: SessionStore, host = HOST) {
  const session = await issueSession({
    userId: OWNER1,
    host,
    now: NOW,
    secureTransport: true,
    store,
    cipher: createTokenCipher(CIPHER),
    tokens: { accessToken: "synthetic-access-token", refreshToken: "synthetic-refresh-token", expiresAt: NOW + 3600 },
  });
  return { session, cookieHeader: `${session.cookie.name}=${session.cookie.value}` };
}

// #37 option (b) changed what sign-out can honestly claim: the session is a row now, so sign-out
// revokes it. It is still exact about the guards — a request that is not this origin, with a token
// this host did not sign, does not get to end anyone's session.
describe("handleSignOut (POST /auth/sign-out)", () => {
  it("clears the session cookie, host-only, and returns to the login surface", async () => {
    const store = memoryStore();
    const { cookieHeader } = await signedIn(store);
    const response = await handleSignOut({ request: await post(HOST, { cookie: cookieHeader }), ports: ports(store) });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") as string);
    expect(location.host).toBe(HOST);
    expect(location.pathname).toBe("/login");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const cleared = response.headers.getSetCookie();
    expect(cleared).toContain("__Host-toi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    expect(cleared.join("\n")).not.toMatch(/domain=/i);
    expect(cleared.join("\n")).not.toContain("Max-Age=28800");
  });

  it("revokes the row, so a copy of the cookie that outlives the browser authenticates nowhere", async () => {
    const store = memoryStore();
    const { session, cookieHeader } = await signedIn(store);
    expect((await readSession({ cookieHeader, host: HOST, now: NOW + 60, store })).ok).toBe(true);

    await handleSignOut({ request: await post(HOST, { cookie: cookieHeader }), ports: ports(store) });

    expect([...store.rows.values()][0]?.revokedAt).toBe(NOW);
    expect(await readSession({ cookieHeader, host: HOST, now: NOW + 60, store })).toEqual({ ok: false, reason: "revoked" });
    expect(session.sessionId).toHaveLength(43);
  });

  it("a sign-out on company2 cannot revoke a company1 session", async () => {
    const store = memoryStore();
    const { cookieHeader } = await signedIn(store, HOST);
    // The host guard is the stored issuing host, so the cookie is not even looked up on the other host.
    await handleSignOut({ request: await post(OTHER, { cookie: cookieHeader, csrf: await issueCsrfToken({ host: OTHER, secret: SECRET, now: NOW }) }), ports: { ...ports(store), findHost: async () => ({ organisationId: C1, organisationStatus: "active" as const }) } });
    expect([...store.rows.values()][0]?.revokedAt).toBeNull();
    expect((await readSession({ cookieHeader, host: HOST, now: NOW + 60, store })).ok).toBe(true);
  });

  it("a store failure is logged as a failed server half, never swallowed into a clean sign-out", async () => {
    const live = memoryStore();
    const { cookieHeader } = await signedIn(live);
    const broken: SessionStore = {
      insert: async () => {},
      find: async () => [...live.rows.values()][0] as StoredSession,
      revoke: async () => {
        throw new Error("connection lost");
      },
      replaceTokens: async () => true,
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleSignOut({ request: await post(HOST, { cookie: cookieHeader }), ports: ports(broken) });
    // The browser's copy is cleared either way — that is what the user asked for — but the log says
    // the row is still live, so an operator is not told a revocation happened that did not.
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toContain("__Host-toi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    const logged = errors.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).toContain("session_store");
    expect([...live.rows.values()][0]?.revokedAt).toBeNull();
    errors.mockRestore();
  });

  it("with no session store wired, it still clears the cookie and says so in the log (#75)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleSignOut({ request: await post(HOST, { cookie: null }), ports: ports(null) });
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toContain("__Host-toi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    expect(errors.mock.calls.map((call) => JSON.stringify(call)).join("\n")).toContain("session_store");
    errors.mockRestore();
  });

  it("still clears when the request carried no session at all", async () => {
    const response = await handleSignOut({ request: await post(HOST, { cookie: null }), ports: ports() });
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toContain("__Host-toi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  });

  it("refuses a request that is not exactly same-origin", async () => {
    for (const origin of [null, "https://company2.terraoi.app", "http://company1.terraoi.app"]) {
      const store = memoryStore();
      const { cookieHeader } = await signedIn(store);
      const response = await handleSignOut({ request: await post(HOST, { origin, cookie: cookieHeader }), ports: ports(store) });
      expect(response.status, String(origin)).toBe(403);
      expect(response.headers.getSetCookie()).toHaveLength(0);
      expect([...store.rows.values()][0]?.revokedAt).toBeNull();
    }
  });

  it("refuses without a valid host-bound CSRF token", async () => {
    const foreign = await issueCsrfToken({ host: OTHER, secret: SECRET, now: NOW });
    for (const csrf of [null, "forged", foreign]) {
      const store = memoryStore();
      const { cookieHeader } = await signedIn(store);
      const response = await handleSignOut({ request: await post(HOST, { csrf, cookie: cookieHeader }), ports: ports(store) });
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toHaveLength(0);
      expect([...store.rows.values()][0]?.revokedAt).toBeNull();
    }
  });

  it("refuses the wrong method and a host that is not a live tenant", async () => {
    const get = await handleSignOut({ request: new Request(`https://${HOST}/auth/sign-out`), ports: ports() });
    expect(get.status).toBe(405);

    const unknown = await handleSignOut({ request: await post("nosuch.terraoi.app"), ports: ports() });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.getSetCookie()).toHaveLength(0);
  });

  it("without a signing secret it reports unavailable and clears nothing", async () => {
    const store = memoryStore();
    const { cookieHeader } = await signedIn(store);
    const response = await handleSignOut({
      request: await post(HOST, { cookie: cookieHeader }),
      ports: { ...ports(store), signingSecret: () => null },
    });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") as string).searchParams.get("outcome")).toBe("unavailable");
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect([...store.rows.values()][0]?.revokedAt).toBeNull();
  });
});
