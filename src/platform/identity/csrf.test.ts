import { describe, expect, it } from "vitest";

import { CSRF_FIELD_NAME, issueCsrfToken, verifyCsrfToken } from "./csrf";
import { signToken, type TokenClaims } from "./signed-token";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
const HOST = "company1.terraoi.app";

// Plan §4.2: "SameSite alone is insufficient protection against sibling subdomains; require exact
// Origin validation and CSRF protection for state-changing endpoints." The token is server-issued,
// signed with a key the browser cannot read, and bound to the host that issued it.
describe("issueCsrfToken / verifyCsrfToken", () => {
  it("accepts a token issued for this host", async () => {
    const token = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
    expect(await verifyCsrfToken({ token, host: HOST, secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it("names the form field the login form must post", () => {
    expect(CSRF_FIELD_NAME).toBe("csrf_token");
  });

  it("rejects a missing or empty token", async () => {
    for (const token of ["", null, undefined]) {
      expect(await verifyCsrfToken({ token: token as string | null, host: HOST, secret: SECRET, now: NOW })).toEqual({
        ok: false,
        reason: "missing",
      });
    }
  });

  it("rejects a token the server never signed", async () => {
    expect(await verifyCsrfToken({ token: "not-a-token", host: HOST, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  // A company1 login page must not be usable to make a state-changing request on company2.
  it("rejects a valid company1 token on company2", async () => {
    const token = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
    expect(await verifyCsrfToken({ token, host: "company2.terraoi.app", secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "host_mismatch",
    });
  });

  it("rejects an expired token", async () => {
    const token = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
    const read = await verifyCsrfToken({ token, host: HOST, secret: SECRET, now: NOW + 3_600 });
    expect(read).toEqual({ ok: false, reason: "expired" });
  });

  it("will not accept a session or login-state token in its place", async () => {
    for (const claims of [
      { typ: "session", sid: "s", sub: "00000000-0000-4000-8000-0000000000a1", host: HOST, iat: NOW, exp: NOW + 60 },
      { typ: "login_state", jti: "n", host: HOST, iat: NOW, exp: NOW + 60 },
    ] as TokenClaims[]) {
      const token = await signToken(claims, SECRET);
      expect(await verifyCsrfToken({ token, host: HOST, secret: SECRET, now: NOW })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("fails closed without a signing secret", async () => {
    await expect(issueCsrfToken({ host: HOST, secret: "", now: NOW })).rejects.toThrow();
    expect(await verifyCsrfToken({ token: "x.y", host: HOST, secret: "", now: NOW })).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
