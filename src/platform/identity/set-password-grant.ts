import { NormalizedHost } from "@/contracts/keys";

import { clearedCookie, cookieName, isDevelopmentRuntime, parseCookieHeader, type CookieSpec } from "./cookie";
import { hasUsableSecret, randomToken, signToken, verifyToken } from "./signed-token";

/**
 * Short-lived host-bound grant that a **recovery** completion alone may mint.
 *
 * Round-2 on #181: `/account/set-password` must not accept an ordinary signed-in session. The session
 * row itself carries no purpose claim (ADR-0003 opaque id), so recovery completion attaches this
 * signed cookie; the set-password surface requires it to match the live session's host and user id,
 * then clears it after a successful update.
 */

export const SET_PASSWORD_GRANT_COOKIE_BASE = "toi_set_password";
/** Long enough to type a new password; short enough that a leftover cookie is not a standing reset. */
export const SET_PASSWORD_GRANT_TTL_SECONDS = 15 * 60;
const SET_PASSWORD_GRANT_TYPE = "set_password_grant";

export type SetPasswordGrantRejection =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "host_mismatch"
  | "user_mismatch";

export type SetPasswordGrantCheck = { ok: true } | { ok: false; reason: SetPasswordGrantRejection };

export async function issueSetPasswordGrant(input: {
  host: string;
  userId: string;
  secret: string;
  now: number;
  secureTransport: boolean;
}): Promise<CookieSpec> {
  if (!NormalizedHost.safeParse(input.host).success) {
    throw new Error("set-password grant host must be a normalized host");
  }
  if (!hasUsableSecret(input.secret)) {
    throw new Error("set-password grant requires a usable signing secret");
  }
  return {
    name: cookieName(SET_PASSWORD_GRANT_COOKIE_BASE, input.secureTransport),
    value: await signToken(
      {
        typ: SET_PASSWORD_GRANT_TYPE,
        jti: randomToken(16),
        host: input.host,
        sub: input.userId,
        iat: input.now,
        exp: input.now + SET_PASSWORD_GRANT_TTL_SECONDS,
      },
      input.secret,
    ),
    maxAge: SET_PASSWORD_GRANT_TTL_SECONDS,
    secure: input.secureTransport,
    httpOnly: true,
    sameSite: "Lax",
  };
}

export async function verifySetPasswordGrant(input: {
  cookieHeader: string | null | undefined;
  host: string;
  userId: string;
  secret: string;
  now: number;
}): Promise<SetPasswordGrantCheck> {
  if (!hasUsableSecret(input.secret)) return { ok: false, reason: "missing" };

  const cookies = parseCookieHeader(input.cookieHeader);
  const developmentName = isDevelopmentRuntime() ? cookieName(SET_PASSWORD_GRANT_COOKIE_BASE, false) : null;
  const secureName = cookieName(SET_PASSWORD_GRANT_COOKIE_BASE, true);
  const raw = cookies[secureName] ?? (developmentName !== null ? cookies[developmentName] : undefined);
  if (raw === undefined || raw.length === 0) return { ok: false, reason: "missing" };

  const claims = await verifyToken(raw, input.secret);
  if (claims === null) return { ok: false, reason: "bad_signature" };
  if (claims.typ !== SET_PASSWORD_GRANT_TYPE) return { ok: false, reason: "malformed" };

  const host = claims.host;
  const sub = claims.sub;
  const exp = claims.exp;
  if (typeof host !== "string" || typeof sub !== "string" || typeof exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (host !== input.host) return { ok: false, reason: "host_mismatch" };
  if (sub !== input.userId) return { ok: false, reason: "user_mismatch" };
  if (input.now >= exp) return { ok: false, reason: "expired" };
  return { ok: true };
}

export function clearSetPasswordGrant(secureTransport: boolean): CookieSpec {
  return clearedCookie(SET_PASSWORD_GRANT_COOKIE_BASE, secureTransport);
}
