import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_BASE, SESSION_TTL_SECONDS, issueSession, readSession } from "./session";
import { cookieName, serializeSetCookie } from "./cookie";
import { signToken, type TokenClaims } from "./signed-token";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const USER = "00000000-0000-4000-8000-0000000000a1";
const NOW = 1_800_000_000;

async function issue(host = "company1.terraoi.app", now = NOW) {
  return issueSession({ userId: USER, host, secret: SECRET, now, secureTransport: true });
}

// Restores NODE_ENV after the development-runtime cases (fail-closed default: NODE_ENV=test).
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("issueSession / readSession (F02 verified server session, plan §4.2)", () => {
  it("hands back a host-only cookie with every required attribute", async () => {
    const session = await issue();
    const header = serializeSetCookie(session.cookie);
    expect(header).toBe(
      `__Host-toi_session=${session.cookie.value}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(header).not.toMatch(/domain=/i);
    expect(session.cookie.name).toBe(cookieName(SESSION_COOKIE_BASE, true));
    expect(header.length).toBeLessThan(4096);
  });

  it("carries no email or address: the cookie proves a session, not an identity claim", async () => {
    const session = await issue();
    expect(session.cookie.value).not.toContain("@");
    const decoded = JSON.parse(Buffer.from(session.token.split(".")[0] as string, "base64url").toString("utf8"));
    expect(JSON.stringify(decoded)).not.toContain("@");
    expect(decoded.sub).toBe(USER);
  });

  it("round-trips to the same user on the same host", async () => {
    const session = await issue();
    const read = await readSession({
      cookieHeader: `${session.cookie.name}=${session.cookie.value}`,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.userId).toBe(USER);
    expect(read.sessionId).toBe(session.sessionId);
  });

  // Acceptance item: "a session cookie from company1 is not accepted on company2". The browser
  // would not send a host-only cookie cross-host anyway; the host claim is what makes the guard
  // real for a cookie that is replayed by hand (plan §4.2 cross-host replay, F02).
  it("refuses the same cookie value on another tenant host", async () => {
    const session = await issue("company1.terraoi.app");
    const read = await readSession({
      cookieHeader: `${session.cookie.name}=${session.cookie.value}`,
      host: "company2.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(read).toEqual({ ok: false, reason: "host_mismatch" });
  });

  it("refuses a host that only looks like the issuer (suffix or case games)", async () => {
    const session = await issue("company1.terraoi.app");
    const cookieHeader = `${session.cookie.name}=${session.cookie.value}`;
    for (const host of ["company1.terraoi.app.evil.test", "Company1.terraoi.app", "company1-staging.terraoi.app"]) {
      const read = await readSession({ cookieHeader, host, secret: SECRET, now: NOW });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.reason).toBe("host_mismatch");
    }
  });

  it("refuses an expired session and one read exactly at its expiry", async () => {
    const session = await issue();
    const cookieHeader = `${session.cookie.name}=${session.cookie.value}`;
    const later = await readSession({ cookieHeader, host: "company1.terraoi.app", secret: SECRET, now: NOW + SESSION_TTL_SECONDS + 1 });
    expect(later).toEqual({ ok: false, reason: "expired" });
    const edge = await readSession({ cookieHeader, host: "company1.terraoi.app", secret: SECRET, now: NOW + SESSION_TTL_SECONDS });
    expect(edge.ok).toBe(false);
  });

  it("refuses a tampered cookie value and a value signed with another key", async () => {
    const session = await issue();
    const tampered = await readSession({
      cookieHeader: `${session.cookie.name}=${session.cookie.value}x`,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(tampered).toEqual({ ok: false, reason: "bad_signature" });

    const foreign = await issueSession({ userId: USER, host: "company1.terraoi.app", secret: `${SECRET}-other`, now: NOW, secureTransport: true });
    const read = await readSession({
      cookieHeader: `${foreign.cookie.name}=${foreign.cookie.value}`,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(read).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports a missing cookie rather than treating an absent header as signed out data", async () => {
    for (const cookieHeader of [null, "", "other=1"]) {
      const read = await readSession({ cookieHeader, host: "company1.terraoi.app", secret: SECRET, now: NOW });
      expect(read).toEqual({ ok: false, reason: "missing" });
    }
  });

  it("refuses a correctly signed token of another type, and one with a non-uuid subject", async () => {
    const foreignType = await signToken({ typ: "csrf", host: "company1.terraoi.app", iat: NOW, exp: NOW + 60 }, SECRET);
    const [payload, signature] = foreignType.split(".");
    const wrongType = await readSession({
      cookieHeader: `__Host-toi_session=${payload}.${signature}`,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(wrongType.ok).toBe(false);
    if (wrongType.ok) return;
    expect(wrongType.reason).toBe("malformed");

    const garbageSubject = await signToken({ typ: "session", sid: "s", sub: "admin", host: "company1.terraoi.app", iat: NOW, exp: NOW + 60 }, SECRET);
    const [gp, gs] = garbageSubject.split(".");
    const read = await readSession({
      cookieHeader: `__Host-toi_session=${gp}.${gs}`,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(read).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a session token with no expiry or no host claim", async () => {
    for (const claims of [
      { typ: "session", sid: "s", sub: USER, host: "company1.terraoi.app" },
      { typ: "session", sid: "s", sub: USER, exp: NOW + 60 },
      { typ: "session", sid: "", sub: USER, host: "company1.terraoi.app", exp: NOW + 60 },
    ] as TokenClaims[]) {
      const token = await signToken(claims, SECRET);
      const [payload, signature] = token.split(".");
      const read = await readSession({
        cookieHeader: `__Host-toi_session=${payload}.${signature}`,
        host: "company1.terraoi.app",
        secret: SECRET,
        now: NOW,
      });
      expect(read.ok).toBe(false);
    }
  });

  it("will not issue a session for a subject that is not an identity id", async () => {
    for (const userId of ["", "admin", "00000000-0000-4000-8000-0000000000", "🛰"]) {
      await expect(issueSession({ userId, host: "company1.terraoi.app", secret: SECRET, now: NOW, secureTransport: true })).rejects.toThrow();
    }
  });

  // PR #18 N1 lesson: the non-`__Host-` form is environment-bound, not caller-selected. A caller
  // passing `secureTransport: false` in production is a bug, and the code says so.
  it("refuses a session cookie without Secure outside a development runtime", async () => {
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      await expect(
        issueSession({ userId: USER, host: "company1.terraoi.app", secret: SECRET, now: NOW, secureTransport: false }),
      ).rejects.toThrow(/development|secure/i);
    }
  });

  it("issues the unprefixed, non-Secure session cookie in an explicit development runtime", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const session = await issueSession({
      userId: USER,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
      secureTransport: false,
    });
    expect(session.cookie.name).toBe("toi_session");
    expect(session.cookie.secure).toBe(false);
    expect(session.cookie.httpOnly).toBe(true);
    expect(session.cookie.sameSite).toBe("Lax");
    expect(serializeSetCookie(session.cookie)).not.toContain("Secure");
  });

  it("reads an unprefixed session cookie in development and ignores it anywhere else", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const dev = await issueSession({
      userId: USER,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
      secureTransport: false,
    });
    const cookieHeader = `toi_session=${dev.cookie.value}`;
    const inDevelopment = await readSession({
      cookieHeader,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(inDevelopment.ok).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    const inProduction = await readSession({
      cookieHeader,
      host: "company1.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(inProduction).toEqual({ ok: false, reason: "missing" });
  });

  it("a missing signing secret fails closed instead of signing with an empty key", async () => {
    await expect(issueSession({ userId: USER, host: "company1.terraoi.app", secret: "", now: NOW, secureTransport: true })).rejects.toThrow();
    const read = await readSession({ cookieHeader: "x=1", host: "company1.terraoi.app", secret: "", now: NOW });
    expect(read).toEqual({ ok: false, reason: "missing" });
  });
});
