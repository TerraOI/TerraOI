import { checkEntraIdentity, isEntraIdentity, type EntraPolicyPorts } from "./entra-linking";
import { loginRedirect } from "./http-response";
import { completeSignIn, signInCarrierReady, type IdentityExchange, type SignInCompletionPorts } from "./signin-completion";
import { readGuardedFormRequest, type SignInRequestPorts } from "./signin-request";
import type { HostAdapterOptions } from "@/platform/tenancy/host";

/**
 * `POST /auth/password` — the second M1 sign-in method (plan §4.2, TOI-ADR-15).
 *
 * Two things about this handler are deliberate and both are load-bearing:
 *
 * **No password handling happens here.** The credential goes to GoTrue's own credential endpoint
 * (`POST /auth/v1/token?grant_type=password`) and this repo neither stores nor derives a password. A
 * hashing library would mean a second credential store with a second set of rules about what a
 * password is, in a repo where `package.json` is a shared path and every dependency is a supervisor
 * decision (AGENTS.md §6). There is nothing to decide: the provider already checks the credential.
 *
 * **One answer for every failed credential.** A malformed address, an unknown address, a wrong
 * password and an over-long password all end at `invalid_credentials`, and the responses are
 * identical; GoTrue's own reply does not distinguish them either. A sign-in form that answers
 * differently per address is an account-discovery oracle (T-131 "No account probing", and #44 set the
 * same rule for a bad link). A real service fault stays `unavailable`, which #44 also settled.
 *
 * The guard chain and everything after the provider answers are shared (`signin-request.ts`,
 * `signin-completion.ts`): this method differs only in step one.
 */

export interface PasswordSignInPorts extends SignInRequestPorts, SignInCompletionPorts, EntraPolicyPorts {
  /**
   * The provider half (Supabase password grant in the real adapter). `invalid_or_expired` is what
   * GoTrue's "Invalid login credentials" maps to: one reason for two different failures, kept in the
   * log and never in the answer.
   */
  exchangePasswordCredentials(input: { email: string; password: string; host: string }): Promise<IdentityExchange>;
}

/**
 * Longer than this is not a password anybody typed; it is someone probing, and a provider that hashes
 * will spend CPU proportional to the input. Refused locally, with the same answer as a wrong
 * password, so the limit cannot be probed for either.
 */
export const MAX_PASSWORD_CHARS = 256;

export interface PasswordSignInInput {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: PasswordSignInPorts;
}

export async function handlePasswordSignIn(input: PasswordSignInInput): Promise<Response> {
  const { ports } = input;

  const guarded = await readGuardedFormRequest(input);
  if (!guarded.ok) return guarded.response;
  const { host, organisation, form, secureTransport } = guarded;

  // Before the provider is dialed: an unwired deployment cannot store the pair it is about to receive,
  // and there is no safe fallback credential to issue in its place (#37, #75).
  if (!signInCarrierReady(ports)) return loginRedirect(host, "unavailable", []);

  if (guarded.email === null) return loginRedirect(host, "invalid_credentials", []);

  const password = form.get("password");
  if (password === null || password.length === 0 || password.length > MAX_PASSWORD_CHARS) {
    return loginRedirect(host, "invalid_credentials", []);
  }

  let identity: IdentityExchange;
  try {
    identity = await ports.exchangePasswordCredentials({ email: guarded.email, password, host });
  } catch {
    // The provider's failure detail never travels: it can name an account, a rate limit or a
    // configuration problem the caller has no business seeing. The password itself is never logged.
    console.error("password sign-in failed", { host, step: "exchangePasswordCredentials" });
    return loginRedirect(host, "unavailable", []);
  }
  if (!identity.ok) return loginRedirect(host, "invalid_credentials", []);

  // The same issuer gate the callback runs, on the path that has no login state to carry an attempt
  // marker. The password grant shares the adapter's one payload reader with the code exchange, so an
  // identity the provider labels `azure` can arrive here too — and a password form has no business
  // consulting a tenant's Entra policy only when the *mail* path did. Here the payload label is the
  // only signal available, and it is enough: it opens the gate for an Entra-labelled identity and
  // leaves a mail one alone. GoTrue is expected to refuse the password grant for a non-mail identity;
  // this does not assume it does.
  if (isEntraIdentity(identity.provider)) {
    const gate = await checkEntraIdentity({
      identity,
      organisationId: organisation.organisationId,
      // The credential the provider just accepted carries its own token, and the policy read is made
      // with it — granted to `authenticated`, never to `anon` (012 tests 39-41).
      accessToken: identity.accessToken,
      ports,
    });
    if (!gate.ok) {
      // A credential the provider accepted is not a tenant answer: refused here, no session, and the
      // operator line says which policy step stopped it.
      console.error("entra password sign-in refused", { host, step: "entra_policy", reason: gate.reason, keyed_on: "payload" });
      return loginRedirect(host, "unavailable", []);
    }
  }

  return completeSignIn({
    host,
    organisationId: organisation.organisationId,
    identity,
    ports,
    secureTransport,
    attach: [],
    recovery: false,
    logContext: "password sign-in",
  });
}
