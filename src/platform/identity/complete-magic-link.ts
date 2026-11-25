import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";

import { isDevelopmentRuntime, isHttpsUrl, type CookieSpec } from "./cookie";
import { checkEntraIdentity, isEntraIdentity } from "./entra-linking";
import { loginRedirect, statusOnly } from "./http-response";
import { consumeLoginState, verifyLoginState } from "./login-state";
import { completeSignIn, type IdentityExchange, type SignInCompletionPorts } from "./signin-completion";
import type { HostLookupPorts } from "./signin-request";
import { hasUsableSecret } from "./signed-token";

/**
 * `GET /auth/callback` — the provider hands the browser a URL, and a URL is not a credential.
 *
 * The order is the whole design: the host is resolved from the routed URL, the single-use login state
 * (cookie + `state` parameter, host-bound, 10 minutes) is verified **before the provider is
 * contacted**, and only a verified identity may reach the membership question. So a forwarded link, an
 * expired link, an already-used code and a tenant-A link opened on tenant B's host all stop at a step
 * that touches no tenant data and sets no session.
 *
 * T-201 widened what can arrive here without changing any of that. Supabase's Entra provider completes
 * through this same callback, so an Entra identity is put through the issuer and verified-email gate
 * (`entra-linking.ts`) before it can touch tenant data; and a callback whose login state was marked
 * `recovery` completes as a password reset, which revokes the user's other sessions first. Everything
 * past those two gates is the shared completion tail in `signin-completion.ts` — the tail this file
 * used to hold inline, and whose 25 tests are unmodified.
 */

export type { IdentityExchange };

export interface MagicLinkCallbackPorts extends SignInCompletionPorts, HostLookupPorts {
  /** The HMAC key behind the login state and CSRF tokens; unusable or absent means nobody is signed in. */
  signingSecret(): string | null;
  /**
   * The provider half (Supabase PKCE code exchange in the real adapter). `invalid_or_expired` covers
   * an expired link and a code that has already been used; the reason detail stays here.
   */
  exchangeLoginCode(input: {
    code: string;
    state: string;
    host: string;
    /**
     * The PKCE verifier, read out of the verified login-state cookie (never from the request). The
     * provider will not exchange a code without it, and it is what makes a captured callback URL
     * useless on its own.
     */
    codeVerifier: string;
  }): Promise<IdentityExchange>;
  /**
   * The tenant's permitted Entra tenant ids, read from the organization the **host** resolved (never
   * from the request). Optional because the SQL behind it is T-201 PR-2's migration: no implementation
   * means no permitted issuer, which refuses an Entra sign-in (see `entra-linking.ts`).
   */
  allowedEntraIssuers?(host: string, accessToken: string): Promise<readonly string[] | null>;
}

export interface MagicLinkCallbackInput {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: MagicLinkCallbackPorts;
}

export async function completeMagicLink(input: MagicLinkCallbackInput): Promise<Response> {
  const { ports } = input;

  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") return statusOnly(404);
  const organisation = await ports.findHost(parsed.host);
  if (organisation === null || organisation.organisationStatus !== "active") return statusOnly(404);

  const secureTransport = isHttpsUrl(input.request.url);
  // Clearing the state cookie follows the same environment rule as issuing it (PR #18 N1): outside
  // `next dev` an insecure cookie form does not exist, and an `http://` request URL never reaches a
  // Worker anyway — the 404/redirect paths above already handle a host that cannot be honored.
  const consumedState: CookieSpec[] = secureTransport || isDevelopmentRuntime() ? [consumeLoginState(secureTransport)] : [];
  const secret = ports.signingSecret();
  const url = new URL(input.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!hasUsableSecret(secret)) return loginRedirect(parsed.host, "unavailable", consumedState);

  const sessionStore = ports.sessionStore();
  const tokenCipher = ports.tokenCipher();
  if (sessionStore === null || tokenCipher === null) {
    // No row, no session. This is checked **before** the provider is contacted so an unwired
    // deployment neither burns a single-use code nor leaves a browser half-signed-in: the alternative
    // would be the self-contained cookie #37 rejected. Issue #75 decides how the row is reached; until
    // then the adapter returns null here and sign-in says "unavailable".
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }

  const stateCheck = await verifyLoginState({
    cookieHeader: input.request.headers.get("cookie"),
    presentedState: state,
    host: parsed.host,
    secret,
    now: ports.now(),
  });
  if (!stateCheck.ok || code === null || code.length === 0 || state === null) {
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }

  let identity: IdentityExchange;
  try {
    identity = await ports.exchangeLoginCode({
      code,
      state,
      host: parsed.host,
      codeVerifier: stateCheck.codeVerifier,
    });
  } catch {
    console.error("magic-link callback failed", { host: parsed.host, step: "exchangeLoginCode" });
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }
  if (!identity.ok) return loginRedirect(parsed.host, "unavailable", consumedState);

  // An Entra identity carries an issuer the tenant may or may not have allowed, and a link it asserts
  // to a profile that has to be a verified one. Checked before the membership read, so a refused
  // identity never touches tenant data.
  //
  // Two signals decide, and they are not interchangeable. The **carrier** says this host sent this
  // browser to Entra — that is the fact the issuer policy exists to govern, and it opens the gate even
  // if the payload arrives labelled as mail (Supabase attaches an Entra identity to an account that
  // already exists as a mail one and leaves `app_metadata.provider` as `"email"`). The **payload
  // label** can only keep the gate open, never close it: an identity the provider itself calls `azure`
  // is gated whatever the carrier said. A magic-link attempt has neither, and skips the gate — the
  // email provider has no issuer to allow-list.
  const entraAttempt = stateCheck.provider === "entra";
  if (entraAttempt || isEntraIdentity(identity.provider)) {
    const gate = await checkEntraIdentity({
      identity,
      host: parsed.host,
      ports,
    });
    if (!gate.ok) {
      console.error("entra callback refused", {
        host: parsed.host,
        step: "entra_policy",
        reason: gate.reason,
        // Which signal opened the gate: recorded for the operator, never sent to the browser.
        keyed_on: entraAttempt ? "attempt" : "payload",
      });
      return loginRedirect(parsed.host, "unavailable", consumedState);
    }
  }

  return completeSignIn({
    host: parsed.host,
    organisationId: organisation.organisationId,
    identity,
    ports,
    secureTransport,
    attach: consumedState,
    recovery: stateCheck.flow === "recovery",
    logContext: "magic-link callback",
  });
}
