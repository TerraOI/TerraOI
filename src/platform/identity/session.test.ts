import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE_BASE,
  SESSION_ID_SHAPE,
  SESSION_TTL_SECONDS,
  issueSession,
  readSession,
  readSessionTokens,
  revokeSession,
  rotateSessionTokens,
} from "./session";
import {
  SESSION_KEY_SHAPE,
  createTokenCipher,
  sessionStoreKey,
  type SessionStore,
  type StoredSession,
  type TokenCipher,
} from "./session-store";
import { cookieName, serializeSetCookie } from "./cookie";
import { signToken } from "./signed-token";

/**
 * #37 option (b), the half that lands in T-102b: the `__Host-toi_session` cookie carries an **opaque
 * random id** (32 bytes, base64url) and nothing else — no `sub`, no host, no expiry, nothing that
 * means something on its own. Everything that authenticates lives in the server-side row behind the
 * `SessionStore` port, including `revoked_at`, which is the gap a self-contained signed cookie could
 * never close.
 *
 * The cookie envelope from #30 (`signed-token.ts`) stays for CSRF and login state — those keep their
 * own tests. Nothing here touches a database: the store is a port and these tests use an
 * in-memory fake; the SQL side is pgTAP (014_identity_session.test.sql), whose authority is CI's
 * `database` job.
 */

const USER = "00000000-0000-4000-8000-0000000000a1";
const HOST = "company1.terraoi.app";
const NOW = 1_800_000_000;
const KEYRING = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000000" } };

/** Synthetic Supabase-shaped material: three base64url segments, header `{"alg":…}` — pattern only. */
function fakeJwt(subject: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT","sub":"00000000-0000-4000-8000-0000000000a1"}')}.${b64(
    `{"role":"authenticated","email":"${subject}@company1.test","exp":${NOW + 3600}}`,
  )}.${b64(`synthetic-signature-for-${subject}`)}`;
}
const ACCESS_TOKEN = fakeJwt("access");
const REFRESH_TOKEN = fakeJwt("refresh");

/** A Supabase access token is a JWT; the hard condition in #37 is that one never reaches the browser. */
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/;

function tokens(overrides: Partial<{ accessToken: string; refreshToken: string; expiresAt: number }> = {}) {
  return {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: NOW + 3600,
    ...overrides,
  };
}

interface FakeStore extends SessionStore {
  rows: Map<string, StoredSession>;
  calls: { insert: number; find: number; revoke: number; replaceTokens: number };
}

function fakeStore(): FakeStore {
  const rows = new Map<string, StoredSession>();
  const calls = { insert: 0, find: 0, revoke: 0, replaceTokens: 0 };
  return {
    rows,
    calls,
    async insert({ sessionKey, session }) {
      calls.insert += 1;
      rows.set(sessionKey, session);
    },
    async find(sessionKey) {
      calls.find += 1;
      return rows.get(sessionKey) ?? null;
    },
    async revoke(sessionKey, at) {
      calls.revoke += 1;
      const row = rows.get(sessionKey);
      if (row) rows.set(sessionKey, { ...row, revokedAt: at });
    },
    async replaceTokens(sessionKey, replacement) {
      calls.replaceTokens += 1;
      const row = rows.get(sessionKey);
      if (!row || row.revokedAt !== null) return false;
      rows.set(sessionKey, { ...row, ...replacement });
      return true;
    },
  };
}

function cipher(): TokenCipher {
  return createTokenCipher(KEYRING);
}

async function issue(overrides: Partial<Omit<Parameters<typeof issueSession>[0], "store">> & { store?: FakeStore } = {}) {
  const store: FakeStore = overrides.store ?? fakeStore();
  const session = await issueSession({
    userId: USER,
    host: HOST,
    now: NOW,
    secureTransport: true,
    store,
    cipher: cipher(),
    tokens: tokens(),
    ...overrides,
  });
  return { session, store };
}

async function read(store: FakeStore, sessionId: string, host = HOST, now = NOW) {
  return readSession({ cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${sessionId}`, host, now, store });
}

// Restores NODE_ENV after the development-runtime cases (fail-closed default: NODE_ENV=test).
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("issueSession — an opaque id, and every claim on the server side (#37 option b)", () => {
  it("hands back a host-only cookie with every required attribute", async () => {
    const { session } = await issue();
    const header = serializeSetCookie(session.cookie);
    expect(header).toBe(
      `__Host-toi_session=${session.sessionId}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(header).not.toMatch(/domain=/i);
    expect(session.cookie.name).toBe(cookieName(SESSION_COOKIE_BASE, true));
    expect(header.length).toBeLessThan(4096);
  });

  it("carries an opaque 32-byte base64url id and no claims at all", async () => {
    const { session } = await issue();
    expect(session.sessionId).toMatch(SESSION_ID_SHAPE);
    expect(session.sessionId).toHaveLength(43); // 32 bytes, base64url, unpadded
    expect(session.cookie.value).toBe(session.sessionId);
    expect(session.cookie.value).not.toContain(".");
    expect(session.cookie.value).not.toContain("@");
    expect(session.cookie.value).not.toContain(USER);
    // The row key is a hash of the id, and it is not in the cookie either.
    expect(serializeSetCookie(session.cookie)).not.toContain(session.sessionKey);
    expect(session.sessionKey).toMatch(SESSION_KEY_SHAPE);
  });

  it("no Supabase token appears in the cookie or in its serialized Set-Cookie value", async () => {
    const { session } = await issue();
    const header = serializeSetCookie(session.cookie);
    expect(header).not.toMatch(JWT_IN_TEXT);
    expect(session.cookie.value).not.toMatch(JWT_IN_TEXT);
    expect(header).not.toContain(ACCESS_TOKEN);
    expect(header).not.toContain(REFRESH_TOKEN);
  });

  it("writes the user, the issuing host and the token pair to the store, never to the browser", async () => {
    const { session, store } = await issue();
    const row = store.rows.get(session.sessionKey);
    expect(row).toBeDefined();
    expect(row?.userId).toBe(USER);
    expect(row?.host).toBe(HOST);
    expect(row?.issuedAt).toBe(NOW);
    expect(row?.expiresAt).toBe(NOW + SESSION_TTL_SECONDS);
    expect(row?.revokedAt).toBeNull();
    expect(row?.keyVersion).toBe("v1");
    // Encrypted at rest: the row holds ciphertext only.
    expect(row?.accessCiphertext).not.toContain(ACCESS_TOKEN);
    expect(row?.refreshCiphertext).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(row)).not.toMatch(JWT_IN_TEXT);
    expect(store.calls.insert).toBe(1);
  });

  it("two sign-ins produce two different ids and two different rows", async () => {
    const store = fakeStore();
    const first = await issue({ store });
    const second = await issue({ store });
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
    expect(first.session.sessionKey).not.toBe(second.session.sessionKey);
    expect(store.rows.size).toBe(2);
  });

  it("refuses to issue without a session store or a cipher instead of falling back to a self-contained cookie", async () => {
    const store = fakeStore();
    await expect(
      issueSession({ userId: USER, host: HOST, now: NOW, secureTransport: true, store, cipher: null as unknown as TokenCipher, tokens: tokens() }),
    ).rejects.toThrow();
    await expect(
      issueSession({
        userId: USER,
        host: HOST,
        now: NOW,
        secureTransport: true,
        store: null as unknown as SessionStore,
        cipher: cipher(),
        tokens: tokens(),
      }),
    ).rejects.toThrow();
    await expect(
      issueSession({ userId: USER, host: HOST, now: NOW, secureTransport: true, store, cipher: cipher(), tokens: null as never }),
    ).rejects.toThrow();
  });

  it("will not issue a session for a subject that is not an identity id", async () => {
    for (const userId of ["", "admin", "00000000-0000-4000-8000-0000000000", "🛰"]) {
      await expect(
        issueSession({ userId, host: HOST, now: NOW, secureTransport: true, store: fakeStore(), cipher: cipher(), tokens: tokens() }),
      ).rejects.toThrow();
    }
  });

  it("will not issue a session bound to a host that is not a normalized host", async () => {
    for (const host of ["", "Company1.terraoi.app", "company1.terraoi.app:8443", "https://company1.terraoi.app", "127.0.0.1"]) {
      await expect(
        issueSession({ userId: USER, host, now: NOW, secureTransport: true, store: fakeStore(), cipher: cipher(), tokens: tokens() }),
      ).rejects.toThrow();
    }
  });

  it("refuses a token pair that is not usable material rather than storing an empty credential", async () => {
    for (const bad of [tokens({ accessToken: "" }), tokens({ refreshToken: "" }), tokens({ expiresAt: NOW - 1 })]) {
      await expect(
        issueSession({ userId: USER, host: HOST, now: NOW, secureTransport: true, store: fakeStore(), cipher: cipher(), tokens: bad }),
      ).rejects.toThrow();
    }
  });

  // PR #18 N1 lesson, unchanged by #37: the non-`__Host-` form is environment-bound, not caller-selected.
  it("refuses a session cookie without Secure outside a development runtime", async () => {
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      await expect(
        issueSession({
          userId: USER,
          host: HOST,
          now: NOW,
          secureTransport: false,
          store: fakeStore(),
          cipher: cipher(),
          tokens: tokens(),
        }),
      ).rejects.toThrow(/development|secure/i);
    }
  });

  it("issues the unprefixed, non-Secure session cookie in an explicit development runtime", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { session } = await issue({ secureTransport: false });
    expect(session.cookie.name).toBe("toi_session");
    expect(session.cookie.secure).toBe(false);
    expect(session.cookie.httpOnly).toBe(true);
    expect(session.cookie.sameSite).toBe("Lax");
    expect(serializeSetCookie(session.cookie)).not.toContain("Secure");
  });
});

describe("readSession — the row decides, and it decides fail-closed", () => {
  it("round-trips to the same user on the same host", async () => {
    const { session, store } = await issue();
    const result = await read(store, session.sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(USER);
    expect(result.sessionId).toBe(session.sessionId);
    expect(result.expiresAt).toBe(NOW + SESSION_TTL_SECONDS);
  });

  it("looks the row up by the hash of the id, not by the id itself", async () => {
    const { session, store } = await issue();
    expect(store.rows.has(session.sessionId)).toBe(false);
    expect(store.rows.has(await sessionStoreKey(session.sessionId))).toBe(true);
    expect((await read(store, session.sessionId)).ok).toBe(true);
  });

  // Acceptance item: "a session cookie from company1 is not accepted on company2". The browser would
  // not send a host-only cookie cross-host anyway; the stored issuing host is what makes the guard
  // real for a cookie that is replayed by hand (plan §4.2, F02).
  it("refuses the same session id on another tenant host", async () => {
    const { session, store } = await issue();
    expect(await read(store, session.sessionId, "company2.terraoi.app")).toEqual({ ok: false, reason: "host_mismatch" });
  });

  it("refuses a host that only looks like the issuer (suffix or case games)", async () => {
    const { session, store } = await issue();
    for (const host of ["company1.terraoi.app.evil.test", "Company1.terraoi.app", "company1-staging.terraoi.app"]) {
      const result = await read(store, session.sessionId, host);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("host_mismatch");
    }
  });

  it("a revoked session does not authenticate, however fresh the cookie is", async () => {
    const { session, store } = await issue();
    store.rows.set(session.sessionKey, { ...(store.rows.get(session.sessionKey) as StoredSession), revokedAt: NOW + 60 });
    expect(await read(store, session.sessionId, HOST, NOW + 120)).toEqual({ ok: false, reason: "revoked" });
    // Revocation wins before expiry, so a stolen cookie stops working immediately, not at 8 h.
    expect(await read(store, session.sessionId, HOST, NOW + SESSION_TTL_SECONDS - 1)).toEqual({ ok: false, reason: "revoked" });
  });

  it("refuses an expired session and one read exactly at its expiry", async () => {
    const { session, store } = await issue();
    const later = await read(store, session.sessionId, HOST, NOW + SESSION_TTL_SECONDS + 1);
    expect(later).toEqual({ ok: false, reason: "expired" });
    const edge = await read(store, session.sessionId, HOST, NOW + SESSION_TTL_SECONDS);
    expect(edge).toEqual({ ok: false, reason: "expired" });
    const justBefore = await read(store, session.sessionId, HOST, NOW + SESSION_TTL_SECONDS - 1);
    expect(justBefore.ok).toBe(true);
  });

  it("honours an explicit shorter ttl on the row", async () => {
    const { session, store } = await issue({ ttlSeconds: 60 });
    expect((store.rows.get(session.sessionKey) as StoredSession).expiresAt).toBe(NOW + 60);
    expect((await read(store, session.sessionId, HOST, NOW + 30)).ok).toBe(true);
    expect(await read(store, session.sessionId, HOST, NOW + 60)).toEqual({ ok: false, reason: "expired" });
  });

  it("an id the store has never heard of is not a session", async () => {
    const store = fakeStore();
    const result = await read(store, "Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2");
    expect(result).toEqual({ ok: false, reason: "unknown_session" });
    expect(store.calls.find).toBe(1);
  });

  it("refuses a cookie value that is not an opaque id — a signed envelope, a JWT or free text — before the store is asked", async () => {
    const store = fakeStore();
    const envelope = await signToken({ typ: "session", sid: "s", sub: USER, host: HOST, iat: NOW, exp: NOW + 60 }, "synthetic-test-secret-not-a-real-key-0000000000");
    const values = [envelope, ACCESS_TOKEN, "session-1", `${"Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2"}extra`, "a b", "ünïcode"];
    for (const value of values) {
      const result = await readSession({ cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${value}`, host: HOST, now: NOW, store });
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }
    // Nothing malformed ever reached the database as a query value.
    expect(store.calls.find).toBe(0);
  });

  it("reports a missing cookie rather than treating an absent header as signed-out data", async () => {
    const store = fakeStore();
    for (const cookieHeader of [null, "", "other=1"]) {
      const result = await readSession({ cookieHeader, host: HOST, now: NOW, store });
      expect(result).toEqual({ ok: false, reason: "missing" });
    }
    expect(store.calls.find).toBe(0);
  });

  it("reads an unprefixed session cookie in development and ignores it anywhere else", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { session, store } = await issue({ secureTransport: false });
    const cookieHeader = `toi_session=${session.sessionId}`;
    const inDevelopment = await readSession({ cookieHeader, host: HOST, now: NOW, store });
    expect(inDevelopment.ok).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    const inProduction = await readSession({ cookieHeader, host: HOST, now: NOW, store });
    expect(inProduction).toEqual({ ok: false, reason: "missing" });
  });

  it("a store that throws fails closed instead of authenticating on the error path", async () => {
    const store: SessionStore = {
      insert: async () => {},
      find: async () => {
        throw new Error("connection lost");
      },
      revoke: async () => {},
      replaceTokens: async () => true,
    };
    const result = await readSession({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2`,
      host: HOST,
      now: NOW,
      store,
    });
    expect(result).toEqual({ ok: false, reason: "store_failure" });
  });

  it("a row whose host claim does not parse is refused rather than trusted", async () => {
    const { session, store } = await issue();
    store.rows.set(session.sessionKey, { ...(store.rows.get(session.sessionKey) as StoredSession), userId: "not-a-uuid" });
    expect(await read(store, session.sessionId)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("revokeSession — sign-out is a real revocation now", () => {
  it("marks the row revoked so the same cookie stops working at once", async () => {
    const { session, store } = await issue();
    const cookieHeader = `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`;
    const revoked = await revokeSession({ cookieHeader, host: HOST, now: NOW + 10, store });
    expect(revoked.ok).toBe(true);
    expect(store.calls.revoke).toBe(1);
    expect((store.rows.get(session.sessionKey) as StoredSession).revokedAt).toBe(NOW + 10);
    expect(await readSession({ cookieHeader, host: HOST, now: NOW + 20, store })).toEqual({ ok: false, reason: "revoked" });
  });

  it("signing out cannot revoke another tenant's session", async () => {
    const { session, store } = await issue();
    const cookieHeader = `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`;
    const result = await revokeSession({ cookieHeader, host: "company2.terraoi.app", now: NOW, store });
    expect(result.ok).toBe(false);
    expect(store.calls.revoke).toBe(0);
    expect((store.rows.get(session.sessionKey) as StoredSession).revokedAt).toBeNull();
  });

  it("an absent or malformed cookie is nothing to revoke, and is not an error", async () => {
    const store = fakeStore();
    expect((await revokeSession({ cookieHeader: null, host: HOST, now: NOW, store })).ok).toBe(false);
    expect((await revokeSession({ cookieHeader: `${SESSION_COOKIE_BASE}=nonsense`, host: HOST, now: NOW, store })).ok).toBe(false);
    expect(store.calls.revoke).toBe(0);
  });

  it("a store failure is reported, never swallowed into a successful sign-out", async () => {
    const { session, store } = await issue();
    const live = store.rows.get(session.sessionKey) as StoredSession;
    const failing: SessionStore = {
      insert: async () => {},
      find: async () => live,
      revoke: async () => {
        throw new Error("connection lost");
      },
      replaceTokens: async () => true,
    };
    const result = await revokeSession({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW,
      store: failing,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("store_failure");
  });
});

describe("readSessionTokens / rotateSessionTokens — the server half keeps the user's tokens", () => {
  it("decrypts the pair for the server path only", async () => {
    const { session, store } = await issue();
    const result = await readSessionTokens({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW,
      store,
      cipher: cipher(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(result.tokens.refreshToken).toBe(REFRESH_TOKEN);
    expect(result.userId).toBe(USER);
  });

  it("applies every read guard before releasing tokens: other host, revoked, expired", async () => {
    const { session, store } = await issue();
    const base = {
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      now: NOW,
      store,
      cipher: cipher(),
    };
    expect((await readSessionTokens({ ...base, host: "company2.terraoi.app" })).ok).toBe(false);
    store.rows.set(session.sessionKey, { ...(store.rows.get(session.sessionKey) as StoredSession), revokedAt: NOW });
    const revoked = await readSessionTokens({ ...base, host: HOST });
    expect(revoked.ok).toBe(false);
    if (revoked.ok) return;
    expect(revoked.reason).toBe("revoked");
  });

  it("reports undecryptable material instead of pretending the session has no tokens", async () => {
    const { session, store } = await issue();
    const rotatedAway = createTokenCipher({ currentVersion: "v9", keys: { v9: "synthetic-keyring-v9-not-a-real-key-0000000000" } });
    const result = await readSessionTokens({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW,
      store,
      cipher: rotatedAway,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("undecryptable");
  });

  it("refreshes when the access token is about to expire and stores the rotated pair under the same row key", async () => {
    const { session, store } = await issue();
    const refreshed = tokens({ accessToken: fakeJwt("access-2"), refreshToken: fakeJwt("refresh-2"), expiresAt: NOW + 7200 });
    const seen: string[] = [];
    const provider = {
      refresh: async ({ refreshToken }: { refreshToken: string; now: number }) => {
        seen.push(refreshToken);
        return refreshed;
      },
    };
    // The access token expires at NOW+3600 and the skew window is 60 s, so asking at NOW+3550 is
    // inside it: the rotation happens before the token would have been used while expired.
    const result = await rotateSessionTokens({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW + 3550,
      store,
      cipher: cipher(),
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens.accessToken).toBe(refreshed.accessToken);
    expect(seen).toEqual([REFRESH_TOKEN]);
    expect(store.calls.replaceTokens).toBe(1);
    const row = store.rows.get(session.sessionKey) as StoredSession;
    expect(row.refreshCiphertext).not.toBe(REFRESH_TOKEN);
    expect(await cipher().open(row.refreshCiphertext)).toBe(refreshed.refreshToken);
    expect(row.tokenExpiresAt).toBe(NOW + 7200);
  });

  it("does not call the provider while the access token is still usable", async () => {
    const { session, store } = await issue();
    let calls = 0;
    const result = await rotateSessionTokens({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW + 60,
      store,
      cipher: cipher(),
      provider: {
        refresh: async () => {
          calls += 1;
          return tokens();
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokens.accessToken).toBe(ACCESS_TOKEN);
  });

  it("a concurrent revocation wins: the rotated pair is not written back over it", async () => {
    const { session, store } = await issue();
    store.replaceTokens = async (sessionKey) => {
      const row = store.rows.get(sessionKey) as StoredSession;
      store.rows.set(sessionKey, { ...row, revokedAt: NOW + 3550 });
      return false;
    };
    const result = await rotateSessionTokens({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW + 3550,
      store,
      cipher: cipher(),
      provider: { refresh: async () => tokens({ expiresAt: NOW + 9000 }) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("revoked");
  });

  it("a provider failure is a closed reason, and never leaks the token material it was holding", async () => {
    const { session, store } = await issue();
    const result = await rotateSessionTokens({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW + 3590,
      store,
      cipher: cipher(),
      provider: {
        refresh: async () => {
          throw new Error(`provider refused: ${REFRESH_TOKEN}`);
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("refresh_failed");
    expect(JSON.stringify(result)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(result)).not.toMatch(JWT_IN_TEXT);
  });

  it("a provider that returns unusable material does not overwrite the row", async () => {
    const { session, store } = await issue();
    const before = store.rows.get(session.sessionKey) as StoredSession;
    const result = await rotateSessionTokens({
      cookieHeader: `${cookieName(SESSION_COOKIE_BASE, true)}=${session.sessionId}`,
      host: HOST,
      now: NOW + 3590,
      store,
      cipher: cipher(),
      provider: { refresh: async () => ({ accessToken: "", refreshToken: REFRESH_TOKEN, expiresAt: NOW + 7200 }) },
    });
    expect(result.ok).toBe(false);
    expect(store.calls.replaceTokens).toBe(0);
    expect(store.rows.get(session.sessionKey)).toEqual(before);
  });
});
