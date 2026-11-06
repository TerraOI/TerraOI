import { z } from "zod";

import { NormalizedHost } from "@/contracts/keys";

import { cookieName, isDevelopmentRuntime, parseCookieHeader, type CookieSpec } from "./cookie";
import { hasUsableSecret, randomToken, signToken, verifyToken } from "./signed-token";

/**
 * The host-only session of plan §4.2: proof that this browser completed a verified sign-in on this
 * tenant host. It is not a membership claim and it is not a bearer credential for data — every
 * request still resolves organization and access from the verified host plus current
 * `organisation_memberships` state (T-101's resolver), so a removed member loses access on the next
 * request no matter how fresh this cookie is.
 */

export const SESSION_COOKIE_BASE = "toi_session";
/** A working day, and no longer: a long-lived cookie only ever widens a theft window. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_TYPE = "session";

export type SessionRejection = "missing" | "malformed" | "bad_signature" | "expired" | "host_mismatch";

export type SessionRead =
  | { ok: true; userId: string; sessionId: string }
  | { ok: false; reason: SessionRejection };

export interface IssueSessionInput {
  userId: string;
  host: string;
  secret: string;
  /** Seconds since epoch from the caller, so tests control the clock. */
  now: number;
  secureTransport: boolean;
  ttlSeconds?: number;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  cookie: CookieSpec;
}

export async function issueSession(input: IssueSessionInput): Promise<IssuedSession> {
  if (!z.uuid().safeParse(input.userId).success) {
    throw new Error("a session subject must be an identity id");
  }
  if (!NormalizedHost.safeParse(input.host).success) {
    throw new Error("a session host must be a normalized host");
  }
  const ttl = input.ttlSeconds ?? SESSION_TTL_SECONDS;
  const sessionId = randomToken(16);
  const token = await signToken(
    { typ: SESSION_TYPE, sid: sessionId, sub: input.userId, host: input.host, iat: input.now, exp: input.now + ttl },
    input.secret,
  );
  return {
    token,
    sessionId,
    cookie: {
      name: cookieName(SESSION_COOKIE_BASE, input.secureTransport),
      value: token,
      maxAge: ttl,
      secure: input.secureTransport,
      httpOnly: true,
      sameSite: "Lax",
    },
  };
}

/**
 * The only safe reading of a session cookie. The host argument comes from the routed URL
 * (`requestHost` in T-101), never from the cookie or a header: that comparison is what makes
 * "a session cookie from company1 is not accepted on company2" true even for a hand-replayed value.
 */
export async function readSession(input: {
  cookieHeader: string | null | undefined;
  host: string;
  secret: string;
  now: number;
}): Promise<SessionRead> {
  if (!hasUsableSecret(input.secret)) return { ok: false, reason: "missing" };

  const cookies = parseCookieHeader(input.cookieHeader);
  // Only a development runtime can ever have received an unprefixed cookie. Outside it, a stray
  // `toi_session` is not a name this server honors, so it is simply not a session.
  const developmentName = isDevelopmentRuntime() ? cookieName(SESSION_COOKIE_BASE, false) : null;
  const value =
    cookies[cookieName(SESSION_COOKIE_BASE, true)] ?? (developmentName === null ? undefined : cookies[developmentName]);
  if (value === undefined || value.length === 0) return { ok: false, reason: "missing" };

  const claims = await verifyToken(value, input.secret);
  if (claims === null) return { ok: false, reason: "bad_signature" };
  if (claims.typ !== SESSION_TYPE) return { ok: false, reason: "malformed" };

  const sid = claims.sid;
  const sub = claims.sub;
  const host = claims.host;
  const exp = claims.exp;
  if (typeof sid !== "string" || sid.length === 0) return { ok: false, reason: "malformed" };
  if (typeof sub !== "string" || !z.uuid().safeParse(sub).success) return { ok: false, reason: "malformed" };
  if (typeof host !== "string" || typeof exp !== "number") return { ok: false, reason: "malformed" };
  if (host !== input.host) return { ok: false, reason: "host_mismatch" };
  if (input.now >= exp) return { ok: false, reason: "expired" };

  return { ok: true, userId: sub, sessionId: sid };
}
