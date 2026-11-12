import { describe, expect, it } from "vitest";

import { BROWSER_TOKEN_SHAPE, containsTokenMaterial, redirectSameHost, statusOnly } from "./http-response";
import { clearedCookie, serializeSetCookie } from "./cookie";
import { createLoginState } from "./login-state";
import { SESSION_COOKIE_BASE, issueSession } from "./session";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000" } };
const NOW = 1_800_000_000;
const HOST = "company1.terraoi.app";
const USER = "00000000-0000-4000-8000-0000000000a1";

/** Pattern-shaped Supabase material — same shape as a real access token, never a real one. */
function fakeJwt(what: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT","role":"authenticated"}')}.${b64(`{"sub":"${USER}"}`)}.${b64(`synthetic-signature-${what}`)}`;
}

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

// #37's hard condition, turned into a property of the response layer instead of a hope: this module is
// the only way the sign-in endpoints answer, so a Supabase token cannot ride out on a cookie or a
// redirect target even if a future caller forgets. The shape test is deliberately pattern-based
// (`eyJ…`.`eyJ…`.`…`) so it matches a real token and cannot match our own artifacts.
describe("http-response — the sign-in responses cannot carry a Supabase token", () => {
  it("recognises the JWT shape a Supabase access or refresh token has", () => {
    expect(BROWSER_TOKEN_SHAPE.test(fakeJwt("access"))).toBe(true);
    expect(containsTokenMaterial(`set-cookie: x=${fakeJwt("refresh")}; Path=/`)).toBe(true);
  });

  it("does not match the artifacts this app does send", async () => {
    const session = await issueSession({
      userId: USER,
      host: HOST,
      now: NOW,
      secureTransport: true,
      store: memoryStore(),
      cipher: createTokenCipher(CIPHER),
      tokens: { accessToken: fakeJwt("access"), refreshToken: fakeJwt("refresh"), expiresAt: NOW + 3600 },
    });
    const loginState = await createLoginState({ host: HOST, secret: SECRET, now: NOW, secureTransport: true });
    for (const value of [session.sessionId, session.sessionKey, loginState.cookie.value, serializeSetCookie(clearedCookie(SESSION_COOKIE_BASE, true))]) {
      expect(containsTokenMaterial(value)).toBe(false);
    }
  });

  it("refuses to emit a Set-Cookie whose value is a Supabase JWT", () => {
    expect(() =>
      redirectSameHost(HOST, "/login?outcome=signed_in", [
        { name: "toi_session", value: fakeJwt("access"), maxAge: 100, secure: true, httpOnly: true, sameSite: "Lax" },
      ]),
    ).toThrow(/token/i);
  });

  it("refuses a refresh token in a cookie just as firmly as an access token", () => {
    expect(() =>
      redirectSameHost(HOST, "/login", [
        { name: "toi_refresh", value: fakeJwt("refresh"), maxAge: 100, secure: true, httpOnly: true, sameSite: "Lax" },
      ]),
    ).toThrow(/token/i);
  });

  it("refuses a redirect target that carries token material in its path or query", () => {
    expect(() => redirectSameHost(HOST, `/login?next=${encodeURIComponent(fakeJwt("access"))}`, [])).toThrow(/token/i);
  });

  it("lets our own opaque session cookie and login-state cookie through", async () => {
    const session = await issueSession({
      userId: USER,
      host: HOST,
      now: NOW,
      secureTransport: true,
      store: memoryStore(),
      cipher: createTokenCipher(CIPHER),
      tokens: { accessToken: fakeJwt("access"), refreshToken: fakeJwt("refresh"), expiresAt: NOW + 3600 },
    });
    const loginState = await createLoginState({ host: HOST, secret: SECRET, now: NOW, secureTransport: true });
    const response = redirectSameHost(HOST, "/", [session.cookie, loginState.cookie]);
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(containsTokenMaterial(response.headers.getSetCookie().join("\n"))).toBe(false);
  });

  it("a bare status response carries no body and no cookie to leak", async () => {
    const response = statusOnly(403);
    expect(await response.text()).toBe("");
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
