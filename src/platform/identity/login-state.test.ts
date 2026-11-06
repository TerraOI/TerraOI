import { describe, expect, it } from "vitest";

import { clearedCookie, serializeSetCookie } from "./cookie";
import {
  LOGIN_STATE_COOKIE_BASE,
  LOGIN_STATE_TTL_SECONDS,
  createLoginState,
  verifyLoginState,
} from "./login-state";
import { signToken, type TokenClaims } from "./signed-token";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
const HOST_A = "company1.terraoi.app";
const HOST_B = "company2.terraoi.app";

// The magic-link callback is a GET the browser makes after the mail provider redirects. The nonce
// in the URL proves nothing on its own: it has to match a host-only cookie this browser was given
// when it asked for the link. That is what stops a captured or forwarded link from signing somebody
// else in, and what makes a callback URL for tenant A fail on tenant B's host (plan §4.2 tests).
describe("createLoginState / verifyLoginState", () => {
  it("issues a nonce and a host-only state cookie, and accepts the matching pair", async () => {
    const state = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    expect(state.nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(state.cookie.name).toBe("__Host-toi_login_state");
    expect(serializeSetCookie(state.cookie)).toContain(`Max-Age=${LOGIN_STATE_TTL_SECONDS}`);
    expect(serializeSetCookie(state.cookie)).not.toMatch(/domain=/i);

    const check = await verifyLoginState({
      cookieHeader: `${state.cookie.name}=${state.cookie.value}`,
      presentedState: state.nonce,
      host: HOST_A,
      secret: SECRET,
      now: NOW,
    });
    expect(check).toEqual({ ok: true });
  });

  it("rejects a link whose state parameter does not match this browser's cookie", async () => {
    const mine = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const check = await verifyLoginState({
      cookieHeader: `${mine.cookie.name}=${mine.cookie.value}`,
      presentedState: "an-attacker-supplied-nonce-0000000000",
      host: HOST_A,
      secret: SECRET,
      now: NOW,
    });
    expect(check).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("rejects a link opened in a browser that never asked for it (no state cookie)", async () => {
    const mine = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    for (const cookieHeader of [null, "", "theme=dark"]) {
      const check = await verifyLoginState({
        cookieHeader,
        presentedState: mine.nonce,
        host: HOST_A,
        secret: SECRET,
        now: NOW,
      });
      expect(check).toEqual({ ok: false, reason: "missing" });
    }
  });

  // Acceptance item: "a callback URL for tenant A replayed on tenant B's host fails".
  it("rejects tenant A's state cookie and link on tenant B's host", async () => {
    const mine = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const check = await verifyLoginState({
      cookieHeader: `${mine.cookie.name}=${mine.cookie.value}`,
      presentedState: mine.nonce,
      host: HOST_B,
      secret: SECRET,
      now: NOW,
    });
    expect(check).toEqual({ ok: false, reason: "host_mismatch" });
  });

  it("rejects a state older than the short login window", async () => {
    const mine = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const check = await verifyLoginState({
      cookieHeader: `${mine.cookie.name}=${mine.cookie.value}`,
      presentedState: mine.nonce,
      host: HOST_A,
      secret: SECRET,
      now: NOW + LOGIN_STATE_TTL_SECONDS + 1,
    });
    expect(check).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered state cookie value", async () => {
    const mine = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const check = await verifyLoginState({
      cookieHeader: `${mine.cookie.name}=${mine.cookie.value}x`,
      presentedState: mine.nonce,
      host: HOST_A,
      secret: SECRET,
      now: NOW,
    });
    expect(check).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("will not accept a session or CSRF token in the state cookie", async () => {
    for (const claims of [
      { typ: "session", sid: "s", sub: "00000000-0000-4000-8000-0000000000a1", host: HOST_A, iat: NOW, exp: NOW + 60 },
      { typ: "csrf", host: HOST_A, iat: NOW, exp: NOW + 60 },
    ] as TokenClaims[]) {
      const token = await signToken(claims, SECRET);
      const check = await verifyLoginState({
        cookieHeader: `__Host-toi_login_state=${token}`,
        presentedState: "whatever",
        host: HOST_A,
        secret: SECRET,
        now: NOW,
      });
      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(["malformed", "bad_signature"]).toContain(check.reason);
    }
  });

  it("clears the cookie by name with Max-Age=0, keeping it host-only", async () => {
    const cleared = clearedCookie(LOGIN_STATE_COOKIE_BASE, true);
    expect(serializeSetCookie(cleared)).toBe("__Host-toi_login_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  });

  it("fails closed without a signing secret", async () => {
    await expect(createLoginState({ host: HOST_A, secret: "", now: NOW, secureTransport: true })).rejects.toThrow();
  });

  // PR #18 N1 lesson: the non-`__Host-` form is environment-bound, not caller-selected.
  it("refuses the unprefixed state cookie outside a development runtime", async () => {
    await expect(
      createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: false }),
    ).rejects.toThrow(/development|secure/i);
    expect(() => clearedCookie(LOGIN_STATE_COOKIE_BASE, false)).toThrow(/development/i);
  });
});
