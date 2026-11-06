import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import type { HostRecord } from "@/platform/tenancy/resolve-tenant-context";

import { canonicalEmail } from "./email";
import { verifyCsrfToken } from "./csrf";
import { statusOnly, redirectSameHost, readCappedBody, LOGIN_PATH } from "./http-response";
import { createLoginState, type CookieSpec } from "./login-state";
import type { SigninOutcome } from "./outcomes";
import { hasUsableSecret } from "./signed-token";

/**
 * `POST /auth/magic-link` (plan §4.2, F02/F05 invite binding).
 *
 * Order matters and each step is a guard, not a preference: method → host (registry first, so an
 * unregistered address gets nothing at all, per the T-101 rule) → exact `Origin` → content type and
 * size → CSRF → rate limit → the provider call. A request that fails any of the first six never
 * reaches the provider or the database.
 *
 * The response is the same for every address: invited, unknown, malformed or rate-limited. A
 * sign-in form that answers differently per address is an account-discovery oracle, and the
 * packet's acceptance item says so explicitly.
 */

export interface MagicLinkRequestPorts {
  now(): number;
  signingSecret(): string | null;
  findHost(host: string): Promise<HostRecord | null>;
  /** The limiter identity: an adapter hashes this, it never stores the address itself. */
  rateLimitKey(input: { host: string; email: string }): Promise<string>;
  allowRequest(key: string): Promise<boolean>;
  sendMagicLink(input: { email: string; redirectTo: string }): Promise<void>;
}

/** A sign-in form carries an address and a token; anything larger is someone probing. */
export const MAX_BODY_BYTES = 4096;
export const CALLBACK_PATH = "/auth/callback";

export interface MagicLinkRequestInput {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: MagicLinkRequestPorts;
}

export async function handleMagicLinkRequest(input: MagicLinkRequestInput): Promise<Response> {
  const { ports } = input;
  if (input.request.method !== "POST") return statusOnly(405);

  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") return statusOnly(404);
  const organisation = await ports.findHost(parsed.host);
  if (organisation === null || organisation.organisationStatus !== "active") return statusOnly(404);

  // Exact Origin: `https://<the host the edge delivered us to>` and nothing else. SameSite would not
  // stop a request from a sibling subdomain, and Origin alone would not stop a forged form.
  if (input.request.headers.get("origin") !== `https://${parsed.host}`) return statusOnly(403);

  const contentType = (input.request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return statusOnly(415);
  const body = await readCappedBody(input.request, MAX_BODY_BYTES);
  if (body === null) return statusOnly(413);

  const secret = ports.signingSecret();
  if (!hasUsableSecret(secret)) return loginRedirect(parsed.host, "unavailable", []);

  const form = new URLSearchParams(body);
  const csrf = await verifyCsrfToken({ token: form.get("csrf_token"), host: parsed.host, secret, now: ports.now() });
  if (!csrf.ok) return statusOnly(403);

  // Canonical form first: the limiter key and the provider both see the canonical address, so
  // `USER@Example.test` cannot buy a second budget or a second identity.
  const email = canonicalEmail(form.get("email"));
  const key = await ports.rateLimitKey({ host: parsed.host, email: email ?? "invalid-address" });
  if (!(await ports.allowRequest(key))) return loginRedirect(parsed.host, "rate_limited", []);

  if (email === null) {
    // Same answer as for a real address, and no provider call: the copy already reads "if this
    // address can sign in, we've sent a link", so this is both the safe and the honest outcome.
    return loginRedirect(parsed.host, "link_sent", []);
  }

  const loginState = await createLoginState({
    host: parsed.host,
    secret,
    now: ports.now(),
    secureTransport: new URL(input.request.url).protocol === "https:",
  });
  const callbackUrl = `https://${parsed.host}${CALLBACK_PATH}?state=${encodeURIComponent(loginState.nonce)}`;
  try {
    await ports.sendMagicLink({ email, redirectTo: callbackUrl });
  } catch {
    // The provider's failure detail never travels to the browser: it can name an account, a rate
    // limit or a configuration problem the caller has no business seeing.
    console.error("magic-link send failed", { host: parsed.host, step: "sendMagicLink" });
    return loginRedirect(parsed.host, "unavailable", [loginState.cookie]);
  }
  return loginRedirect(parsed.host, "link_sent", [loginState.cookie]);
}

function loginRedirect(host: string, outcome: SigninOutcome, cookies: readonly CookieSpec[]): Response {
  return redirectSameHost(host, `${LOGIN_PATH}?outcome=${outcome}`, cookies);
}
