import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import type { HostRecord } from "@/platform/tenancy/resolve-tenant-context";

import { clearedCookie, isHttpsUrl } from "./cookie";
import { verifyCsrfToken } from "./csrf";
import { LOGIN_PATH, redirectSameHost, readCappedBody, statusOnly } from "./http-response";
import { LOGIN_STATE_COOKIE_BASE } from "./login-state";
import { MAX_BODY_BYTES } from "./request-magic-link";
import { SESSION_COOKIE_BASE, revokeSession } from "./session";
import type { SessionStore } from "./session-store";
import { hasUsableSecret } from "./signed-token";

/**
 * `POST /auth/sign-out`.
 *
 * Since #37 option (b) this is a **real revocation**: the session is a row, so sign-out sets its
 * `revoked_at` and a copied cookie stops authenticating immediately instead of at the 8-hour expiry
 * (the decision named exactly this as the gap a self-contained cookie could not close). The browser's
 * copy of the cookie is cleared too, because that is what the user asked for; if the row write fails
 * the handler says so in the log with a fixed step marker, so an operator is never told a revocation
 * happened that did not.
 *
 * The guards are unchanged from the other state-changing endpoints: exact Origin and a host-bound
 * CSRF token. A cross-site "sign out" is a nuisance attack (logging a user out repeatedly), and it is
 * still refused — and it must be, now that the call can end someone's session server-side.
 */

export interface SignOutPorts {
  now(): number;
  signingSecret(): string | null;
  /** Null where the session row is not reachable yet (#75): the cookie is still cleared, and the log says the server half did not run. */
  sessionStore(): SessionStore | null;
  findHost(host: string): Promise<HostRecord | null>;
}

export async function handleSignOut(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: SignOutPorts;
}): Promise<Response> {
  const { ports } = input;
  if (input.request.method !== "POST") return statusOnly(405);

  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") return statusOnly(404);
  const organisation = await ports.findHost(parsed.host);
  if (organisation === null || organisation.organisationStatus !== "active") return statusOnly(404);

  if (input.request.headers.get("origin") !== `https://${parsed.host}`) return statusOnly(403);

  const secret = ports.signingSecret();
  if (!hasUsableSecret(secret)) {
    return redirectSameHost(parsed.host, `${LOGIN_PATH}?outcome=unavailable`, []);
  }

  const body = await readCappedBody(input.request, MAX_BODY_BYTES);
  if (body === null) return statusOnly(413);
  const csrf = await verifyCsrfToken({
    token: new URLSearchParams(body).get("csrf_token"),
    host: parsed.host,
    secret,
    now: ports.now(),
  });
  if (!csrf.ok) return statusOnly(403);

  const secureTransport = isHttpsUrl(input.request.url);

  // The server half of sign-out, before the browser half: revoke the row. `missing` and
  // `unknown_session` are not failures — there was simply nothing to revoke — but a store failure or a
  // foreign-host session is, and it is logged with a fixed marker rather than returned, because the
  // user-visible result is the same either way and the detail is not the caller's to see.
  const sessionStore = ports.sessionStore();
  if (sessionStore === null) {
    console.error("sign-out could not revoke the session row", { host: parsed.host, step: "session_store", reason: "unwired" });
  } else {
    const revoked = await revokeSession({
      cookieHeader: input.request.headers.get("cookie"),
      host: parsed.host,
      now: ports.now(),
      store: sessionStore,
    });
    if (!revoked.ok && revoked.reason !== "missing" && revoked.reason !== "unknown_session") {
      console.error("sign-out could not revoke the session row", { host: parsed.host, step: "session_store", reason: revoked.reason });
    }
  }

  return redirectSameHost(parsed.host, LOGIN_PATH, [
    clearedCookie(SESSION_COOKIE_BASE, secureTransport),
    clearedCookie(LOGIN_STATE_COOKIE_BASE, secureTransport),
  ]);
}
