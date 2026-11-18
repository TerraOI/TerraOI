import { loginRedirect } from "./http-response";
import { createLoginState } from "./login-state";
import { CALLBACK_PATH, MAX_BODY_BYTES, readGuardedFormRequest, type SignInRequestPorts } from "./signin-request";
import type { HostAdapterOptions } from "@/platform/tenancy/host";

/**
 * `POST /auth/magic-link` (plan §4.2, F02/F05 invite binding).
 *
 * The guard chain — method → host → exact `Origin` → content type and size → CSRF → rate limit — lives
 * in `signin-request.ts`, shared with T-201's password, Entra and recovery endpoints: a chain that has
 * to be restated per endpoint is a chain that gets one endpoint wrong. What is specific to this file is
 * the second half — mint the login state (nonce + PKCE verifier) and hand the provider a mail it can
 * only deliver to this browser.
 *
 * The response is the same for every address: invited, unknown, malformed or rate-limited. A sign-in
 * form that answers differently per address is an account-discovery oracle, and the packet's acceptance
 * item says so explicitly.
 */

export interface MagicLinkRequestPorts extends SignInRequestPorts {
  sendMagicLink(input: { email: string; redirectTo: string; codeVerifier: string }): Promise<void>;
}

// Re-exported from their new home so the existing import paths (`sign-out.ts` reads the size cap here)
// keep resolving; the values themselves are defined once, in the shared chain.
export { CALLBACK_PATH, MAX_BODY_BYTES };

export interface MagicLinkRequestInput {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: MagicLinkRequestPorts;
}

export async function handleMagicLinkRequest(input: MagicLinkRequestInput): Promise<Response> {
  const { ports } = input;

  const guarded = await readGuardedFormRequest({ ...input, limitMethod: "magic-link" });
  if (!guarded.ok) return guarded.response;
  const { host, secret, secureTransport } = guarded;

  if (guarded.email === null) {
    // Same answer as for a real address, and no provider call: the copy already reads "if this
    // address can sign in, we've sent a link", so this is both the safe and the honest outcome.
    return loginRedirect(host, "link_sent", []);
  }

  const loginState = await createLoginState({ host, secret, now: ports.now(), secureTransport });
  const callbackUrl = `https://${host}${CALLBACK_PATH}?state=${encodeURIComponent(loginState.nonce)}`;
  try {
    // The verifier goes to the provider as an S256 challenge, so the code it later hands back can
    // only be exchanged by a server holding this browser's cookie.
    await ports.sendMagicLink({ email: guarded.email, redirectTo: callbackUrl, codeVerifier: loginState.codeVerifier });
  } catch {
    // The provider's failure detail never travels to the browser: it can name an account, a rate
    // limit or a configuration problem the caller has no business seeing.
    console.error("magic-link send failed", { host, step: "sendMagicLink" });
    return loginRedirect(host, "unavailable", [loginState.cookie]);
  }
  return loginRedirect(host, "link_sent", [loginState.cookie]);
}
