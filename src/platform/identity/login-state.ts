import { NormalizedHost } from "@/contracts/keys";

import { clearedCookie, cookieName, isDevelopmentRuntime, parseCookieHeader, type CookieSpec } from "./cookie";
import { hasUsableSecret, randomToken, safeEqualStrings, signToken, verifyToken } from "./signed-token";

/**
 * The single-use, short-lived binding between "this browser asked for a magic link on this host" and
 * the callback the provider sends that browser to.
 *
 * A magic-link URL proves nothing by itself: whoever holds it can open it. The nonce must also match
 * a host-only cookie set when the link was requested, which is what makes these acceptance cases
 * fail: a link forwarded to another browser, and a callback URL for tenant A replayed on tenant B's
 * host (plan §4.2 tests, F02 "cross-host replay and forged session").
 */

export const LOGIN_STATE_COOKIE_BASE = "toi_login_state";
/** Long enough to open an email on another device? No: the link is opened where it was asked for. */
export const LOGIN_STATE_TTL_SECONDS = 10 * 60;
const LOGIN_STATE_TYPE = "login_state";

export type LoginStateRejection =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "host_mismatch"
  | "state_mismatch";

export type LoginStateCheck = { ok: true } | { ok: false; reason: LoginStateRejection };

export async function createLoginState(input: {
  host: string;
  secret: string;
  now: number;
  secureTransport: boolean;
}): Promise<{ nonce: string; cookie: CookieSpec }> {
  if (!NormalizedHost.safeParse(input.host).success) {
    throw new Error("login state host must be a normalized host");
  }
  const nonce = randomToken();
  const cookie: CookieSpec = {
    name: cookieName(LOGIN_STATE_COOKIE_BASE, input.secureTransport),
    value: await signToken(
      {
        typ: LOGIN_STATE_TYPE,
        jti: nonce,
        host: input.host,
        iat: input.now,
        exp: input.now + LOGIN_STATE_TTL_SECONDS,
      },
      input.secret,
    ),
    maxAge: LOGIN_STATE_TTL_SECONDS,
    secure: input.secureTransport,
    httpOnly: true,
    sameSite: "Lax",
  };
  return { nonce, cookie };
}

export async function verifyLoginState(input: {
  cookieHeader: string | null | undefined;
  /** The `state` the provider carried back in the callback URL. */
  presentedState: string | null | undefined;
  host: string;
  secret: string;
  now: number;
}): Promise<LoginStateCheck> {
  if (input.presentedState === undefined || input.presentedState === null || input.presentedState.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (!hasUsableSecret(input.secret)) return { ok: false, reason: "missing" };

  const cookies = parseCookieHeader(input.cookieHeader);
  const developmentName = isDevelopmentRuntime() ? cookieName(LOGIN_STATE_COOKIE_BASE, false) : null;
  const value =
    cookies[cookieName(LOGIN_STATE_COOKIE_BASE, true)] ??
    (developmentName === null ? undefined : cookies[developmentName]);
  if (value === undefined || value.length === 0) return { ok: false, reason: "missing" };

  const claims = await verifyToken(value, input.secret);
  if (claims === null) return { ok: false, reason: "bad_signature" };
  if (claims.typ !== LOGIN_STATE_TYPE) return { ok: false, reason: "malformed" };

  const nonce = claims.jti;
  const host = claims.host;
  const exp = claims.exp;
  if (typeof nonce !== "string" || typeof host !== "string" || typeof exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (host !== input.host) return { ok: false, reason: "host_mismatch" };
  if (input.now >= exp) return { ok: false, reason: "expired" };
  if (!safeEqualStrings(nonce, input.presentedState)) return { ok: false, reason: "state_mismatch" };
  return { ok: true };
}

/** Consuming the state: the cookie goes away, so the same callback URL cannot be used twice. */
export function consumeLoginState(secureTransport: boolean): CookieSpec {
  return clearedCookie(LOGIN_STATE_COOKIE_BASE, secureTransport);
}
