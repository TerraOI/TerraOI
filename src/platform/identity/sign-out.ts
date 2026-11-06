import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import type { HostRecord } from "@/platform/tenancy/resolve-tenant-context";

import { clearedCookie, isHttpsUrl } from "./cookie";
import { verifyCsrfToken } from "./csrf";
import { LOGIN_PATH, redirectSameHost, readCappedBody, statusOnly } from "./http-response";
import { LOGIN_STATE_COOKIE_BASE } from "./login-state";
import { MAX_BODY_BYTES } from "./request-magic-link";
import { SESSION_COOKIE_BASE } from "./session";
import { hasUsableSecret } from "./signed-token";

/**
 * `POST /auth/sign-out`.
 *
 * What it can honestly do: clear this browser's copy of the host's session and login state. The
 * session cookie is a signed, self-contained record, so there is **no server-side revocation** in
 * this design — the honest mitigation is the short TTL plus the fact that every request re-checks
 * current membership, so a stale cookie grants nothing a live membership check would not. If #37
 * lands on a server-side session store, revocation becomes a real operation and this handler gains a
 * call to it.
 *
 * The guards are the same as for the other state-changing endpoints: exact Origin and a host-bound
 * CSRF token. A cross-site "sign out" is a nuisance attack (logging a user out repeatedly), and it is
 * still refused.
 */

export interface SignOutPorts {
  now(): number;
  signingSecret(): string | null;
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
  return redirectSameHost(parsed.host, LOGIN_PATH, [
    clearedCookie(SESSION_COOKIE_BASE, secureTransport),
    clearedCookie(LOGIN_STATE_COOKIE_BASE, secureTransport),
  ]);
}
