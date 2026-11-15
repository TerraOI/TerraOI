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

/**
 * Which flow a login state belongs to. Only the non-default value is ever written into a token: an
 * ordinary sign-in state carries no `flow` claim at all, so the absence of the claim means "sign-in"
 * and there is no third state a client could invent.
 *
 * Why the carrier has to say anything: a password-recovery link lands on the same callback as a magic
 * link and the provider's exchange looks identical from here. What the callback must do differently —
 * revoke the user's other sessions before it mints the new one — is a fact about **this** browser's
 * request, and the only thing binding this browser to that request is this signed, host-bound,
 * single-use state (#37's carrier, T-201's reset item).
 */
export type LoginStateFlow = "recovery";

export type LoginStateCheck =
  | { ok: true; codeVerifier: string; flow?: LoginStateFlow }
  | { ok: false; reason: LoginStateRejection };

export async function createLoginState(input: {
  host: string;
  secret: string;
  now: number;
  secureTransport: boolean;
  /**
   * The PKCE `code_verifier` for this login attempt, carried inside the signed state token.
   *
   * Why a cookie is a defensible home for it: the cookie is `HttpOnly`, so no browser script ever
   * reads it; the value is an HMAC-signed envelope, so a client cannot substitute its own verifier;
   * it is bound to the host that issued it and single-use; and its `typ` claim is `login_state`, so
   * a session or CSRF token can never be accepted as a PKCE carrier (or the reverse) — see the
   * cross-type assertions in `login-state.test.ts`. A server-side store instead would need a durable
   * keyed store and a retention story for something that lives ten minutes.
   */
  codeVerifier?: string;
  /**
   * `recovery` for the state a password-reset request hands its recovery link. Absent means an
   * ordinary sign-in, and no other value is accepted — a client cannot ask for a flow.
   */
  flow?: LoginStateFlow;
}): Promise<{ nonce: string; codeVerifier: string; cookie: CookieSpec }> {
  if (!NormalizedHost.safeParse(input.host).success) {
    throw new Error("login state host must be a normalized host");
  }
  const nonce = randomToken();
  // The verifier is generated here rather than passed in, so there is exactly one way to make one
  // and every login state that reaches the provider has it.
  const codeVerifier = input.codeVerifier ?? randomToken(32);
  const cookie: CookieSpec = {
    name: cookieName(LOGIN_STATE_COOKIE_BASE, input.secureTransport),
    value: await signToken(
      {
        typ: LOGIN_STATE_TYPE,
        jti: nonce,
        host: input.host,
        pkce: codeVerifier,
        // Only a non-default flow is written at all, so an ordinary sign-in token is byte-identical to
        // one issued before T-201 and "no claim" cannot be confused with a claim of its own.
        ...(input.flow === "recovery" ? { flow: input.flow } : {}),
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
  return { nonce, codeVerifier, cookie };
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
  const codeVerifier = claims.pkce;
  if (typeof nonce !== "string" || typeof host !== "string" || typeof exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  // A login state without a verifier is not one this server issued: `createLoginState` always
  // carries one, so a token missing it is forged or stale and must not reach the provider.
  if (typeof codeVerifier !== "string" || codeVerifier.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  // A `flow` claim is only ever the one value, and only ever written by `createLoginState` above.
  // Anything else is a forged or stale token: refusing it is what stops a caller from asking the
  // callback to run the recovery half of the flow (or from hiding a recovery as a plain sign-in).
  const flow = claims.flow;
  if (flow !== undefined && flow !== "recovery") return { ok: false, reason: "malformed" };

  if (host !== input.host) return { ok: false, reason: "host_mismatch" };
  if (input.now >= exp) return { ok: false, reason: "expired" };
  if (!safeEqualStrings(nonce, input.presentedState)) return { ok: false, reason: "state_mismatch" };
  return { ok: true, codeVerifier, ...(flow === "recovery" ? { flow: "recovery" as const } : {}) };
}

/** Consuming the state: the cookie goes away, so the same callback URL cannot be used twice. */
export function consumeLoginState(secureTransport: boolean): CookieSpec {
  return clearedCookie(LOGIN_STATE_COOKIE_BASE, secureTransport);
}
