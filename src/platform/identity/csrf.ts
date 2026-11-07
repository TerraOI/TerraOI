import { NormalizedHost } from "@/contracts/keys";

import { hasUsableSecret, randomToken, signToken, verifyToken } from "./signed-token";

/**
 * CSRF protection for the state-changing sign-in endpoints (plan §4.2: "SameSite alone is
 * insufficient protection against sibling subdomains; require exact `Origin` validation and CSRF
 * protection for state-changing endpoints").
 *
 * The token is issued by the server into the login form and is signed with a key the browser cannot
 * read, so a cross-site page cannot produce one; it is bound to the host that issued it, so a page
 * on one tenant cannot spend it on another. The exact-Origin check in the route handler is the
 * second, independent guard — a POST needs both.
 */

export const CSRF_COOKIE_BASE = "toi_csrf";
export const CSRF_FIELD_NAME = "csrf_token";
export const CSRF_TTL_SECONDS = 30 * 60;
const CSRF_TYPE = "csrf";

export type CsrfRejection = "missing" | "malformed" | "bad_signature" | "expired" | "host_mismatch";

export type CsrfCheck = { ok: true } | { ok: false; reason: CsrfRejection };

export async function issueCsrfToken(input: { host: string; secret: string; now: number }): Promise<string> {
  if (!NormalizedHost.safeParse(input.host).success) throw new Error("csrf host must be a normalized host");
  return signToken(
    { typ: CSRF_TYPE, jti: randomToken(16), host: input.host, iat: input.now, exp: input.now + CSRF_TTL_SECONDS },
    input.secret,
  );
}

export async function verifyCsrfToken(input: {
  token: string | null | undefined;
  host: string;
  secret: string;
  now: number;
}): Promise<CsrfCheck> {
  if (input.token === undefined || input.token === null || input.token.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (!hasUsableSecret(input.secret)) return { ok: false, reason: "missing" };

  const claims = await verifyToken(input.token, input.secret);
  if (claims === null) return { ok: false, reason: "bad_signature" };
  // The `typ` claim is what stops a session or login-state token from being replayed as CSRF proof,
  // or a CSRF token from being read as a session.
  if (claims.typ !== CSRF_TYPE) return { ok: false, reason: "malformed" };

  const host = claims.host;
  const exp = claims.exp;
  if (typeof host !== "string" || typeof exp !== "number") return { ok: false, reason: "malformed" };
  if (host !== input.host) return { ok: false, reason: "host_mismatch" };
  if (input.now >= exp) return { ok: false, reason: "expired" };
  return { ok: true };
}
