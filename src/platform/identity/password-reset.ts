import { loginRedirect } from "./http-response";
import { createLoginState } from "./login-state";
import { CALLBACK_PATH, readGuardedFormRequest, type SignInRequestPorts } from "./signin-request";
import type { HostAdapterOptions } from "@/platform/tenancy/host";

/**
 * `POST /auth/password-reset` — asking for a reset link (plan §4.2, F02).
 *
 * Again the credential half is the provider's: GoTrue's `/auth/v1/recover` sends the link and verifies
 * whoever opens it. What this repo owns is the same guard chain as every other sign-in endpoint, and
 * the one thing that lets the callback tell a completed reset from a completed magic link: the login
 * state handed to the recovery link is marked `recovery`, and the callback that finds that mark revokes
 * the user's other sessions on this host before it mints a new one (`signin-completion.ts`).
 *
 * No-address-probing is the same rule as the sign-in form: invited, unknown and malformed addresses get
 * byte-identical answers, so the endpoint is not an account oracle (T-131). Unlike the magic-link form,
 * the state cookie is issued even for an unusable address, because a Set-Cookie that appears for one
 * address and not another is itself a distinguishable answer.
 *
 * The reset **email** is T-204's; the copy shown here is the existing `link_sent` value, which already
 * reads "if this address can sign in, we've sent a link".
 */

export interface PasswordResetPorts extends SignInRequestPorts {
  /** The provider half: a recovery email carrying this host's callback and this attempt's PKCE verifier. */
  sendPasswordRecovery(input: { email: string; redirectTo: string; codeVerifier: string }): Promise<void>;
}

export interface PasswordResetInput {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: PasswordResetPorts;
}

export async function handlePasswordResetRequest(input: PasswordResetInput): Promise<Response> {
  const { ports } = input;

  const guarded = await readGuardedFormRequest(input);
  if (!guarded.ok) return guarded.response;
  const { host, secret, secureTransport } = guarded;

  const loginState = await createLoginState({ host, secret, now: ports.now(), secureTransport, flow: "recovery" });
  const callbackUrl = `https://${host}${CALLBACK_PATH}?state=${encodeURIComponent(loginState.nonce)}`;

  if (guarded.email === null) {
    // The same answer as for a real address, and no provider call. The state cookie still goes out:
    // its presence is not allowed to be the thing that tells a caller which addresses exist.
    return loginRedirect(host, "link_sent", [loginState.cookie]);
  }

  try {
    await ports.sendPasswordRecovery({ email: guarded.email, redirectTo: callbackUrl, codeVerifier: loginState.codeVerifier });
  } catch {
    // The provider's failure detail never travels: it can name an account, a rate limit or a
    // configuration problem the caller has no business seeing.
    console.error("password reset request failed", { host, step: "sendPasswordRecovery" });
    return loginRedirect(host, "unavailable", [loginState.cookie]);
  }
  return loginRedirect(host, "link_sent", [loginState.cookie]);
}
