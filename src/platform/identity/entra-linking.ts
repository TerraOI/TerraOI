import { loginRedirect, providerRedirect } from "./http-response";
import { createLoginState } from "./login-state";
import { CALLBACK_PATH, readGuardedFormRequest, type SignInRequestPorts } from "./signin-request";
import { sha256Base64Url } from "./signed-token";
import type { HostAdapterOptions } from "@/platform/tenancy/host";
import type { IdentityExchange } from "./signin-completion";

/**
 * Microsoft Entra ID as a sign-in method, and the linking rules that come with it (plan §4.2, §16,
 * F02, F05, TOI-ADR-15).
 *
 * Supabase's Entra provider (`azure`) completes through the **same** PKCE callback as the magic link,
 * so what this packet adds on top is the policy, and the policy is four sentences:
 *
 *   * a provider-verified email that matches an invited membership **links** to that profile;
 *   * an email the provider did not verify is never auto-linked, whoever the provider says it is;
 *   * a verified identity with no active membership row gets the no-access surface and nothing else —
 *     identity proves *who*, membership decides *whether* (F02);
 *   * a tenant allow-listed to one Entra tenant ID refuses an account from any other issuer.
 *
 * The fourth needs data: a per-tenant record of permitted Entra tenant ids, which PR-2's
 * `20261115060000_identity_methods.sql` creates (`public.tenant_entra_issuers`). **On this branch only**,
 * the read answers the question this module actually asks instead of handing out the list —
 * `public.entra_issuer_allowed_v1(p_organisation_id, p_issuer_tenant_id)` returning `allowed | denied`,
 * which is [#185](https://github.com/TerraOI/TerraOI/issues/185)'s option 4. PR #186's head ships
 * `entra_allowed_issuers_v1(organisationId) -> string[] | null`, and the port here mirrors whichever
 * shape wins; nothing in the policy above depends on the difference. A read that cannot be made at all —
 * no Data API configured, a verdict this module cannot parse — stays **unresolved**, and unresolved
 * refuses. That is not a placeholder standing in for a decision: a tenant with no recorded Entra policy
 * genuinely has no permitted issuer, which is the same answer as a denial, and the two are kept apart
 * because the operator's answer differs (`issuer_not_allowed` is a configuration fact, `policy_unresolved`
 * is a deployment or backend fault).
 *
 * What the SQL does *not* do is scope itself: the gate runs before the membership question and must
 * answer for identities that hold no membership row in this tenant, and `set_tenant_scope` refuses
 * exactly those callers. `entra_issuer_allowed_v1`'s header says why, and 012 assertions 41-45 pin the
 * verdicts.
 *
 * What this file no longer owns is the comparison itself. Under a verdict read the match is SQL's `exists`
 * over `(organisation_id, issuer_tenant_id)`, so the rule below — exact, never case-folded — has to be
 * pinned there (012 assertion 69) while the branch a verdict cannot express (an identity carrying no
 * issuer at all) stays pinned here. That split is the cost of the shape, and it is the cost
 * [#185](https://github.com/TerraOI/TerraOI/issues/185) asks to be paid up front rather than discovered
 * later.
 *
 * The `tid` claim (the issuing Entra tenant) is read defensively from the identity payload because
 * which field of it Supabase surfaces for `azure` is a provider detail this repo has not yet seen on
 * staging; a missing or unreadable issuer is refused, never treated as unrestricted.
 */

/** Supabase names Entra ID `azure`; `microsoft` is accepted so a renamed provider key cannot slip past the gate. */
const ENTRA_PROVIDER_KEYS: readonly string[] = ["azure", "microsoft"];

/** The provider's own authorize endpoint. The path is this server's, never the request's (F05). */
export const ENTRA_AUTHORIZE_PATH = "/auth/v1/authorize";

/** The provider key check, exact and never case-folded in either direction: `Azure` is not Entra. */
export function isEntraIdentity(provider: string | undefined): boolean {
  return typeof provider === "string" && ENTRA_PROVIDER_KEYS.includes(provider);
}

export type EntraRefusal = "unverified_email" | "issuer_unknown" | "issuer_not_allowed" | "policy_unresolved";

/**
 * The SQL's answer about one (organization, issuer) pair. `denied` covers both "this tenant permits
 * somebody else" and "this tenant has configured nothing"; there is no third verdict. That is the whole
 * economy of the shape — and the reason `checkEntraIdentity` below has to decide issuer-absence itself.
 */
export type EntraIssuerVerdict = "allowed" | "denied";

/**
 * The decision, with no I/O in it — so every branch of it is testable, including the ones the merged
 * schema cannot yet reach.
 */
export function decideEntraLink(input: {
  emailVerified: boolean;
  issuerTenantId: string | null | undefined;
  /** The tenant's verdict on this issuer. Null: no verdict readable, which is a refusal. */
  issuerVerdict: EntraIssuerVerdict | null;
}): { ok: true } | { ok: false; reason: EntraRefusal } {
  if (input.issuerVerdict === null) return { ok: false, reason: "policy_unresolved" };
  if (!input.emailVerified) return { ok: false, reason: "unverified_email" };
  const issuer = input.issuerTenantId;
  if (typeof issuer !== "string" || issuer.length === 0) return { ok: false, reason: "issuer_unknown" };
  // Exact match, never case-folded: Entra tenant ids are uuids, and a near miss is a refusal. On this
  // branch the match itself is SQL's — an `exists` over `(organisation_id, issuer_tenant_id)` with no
  // `lower()` and no `ilike` — and 012 assertion 69 is the pin that keeps it that way. What is left here
  // is only the mapping from its verdict to this policy's reason.
  if (input.issuerVerdict !== "allowed") return { ok: false, reason: "issuer_not_allowed" };
  return { ok: true };
}

export interface EntraPolicyPorts {
  /**
   * The verdict for **one** (organization, issuer) pair: `denied` for a tenant that has configured none
   * as well as for a tenant that configured somebody else, and `null` when no verdict is readable at all
   * — which includes a deployment whose Data API is not configured. No implementation is itself treated
   * as unresolved.
   *
   * `accessToken` is the signed-in identity's own token, because `entra_issuer_allowed_v1` is granted to
   * `authenticated` and not to `anon` (012 assertions 39-41): the gate runs on an identity a provider has
   * just verified, and the anonymous pre-sign-in surface stays the one host resolver the merged schema
   * already exposes.
   *
   * The issuer is an argument rather than a returned set, and that is the substance of
   * [#185](https://github.com/TerraOI/TerraOI/issues/185)'s option 4: nothing on this path can learn
   * which issuers a tenant permits unless it already holds a candidate to ask about. The trade is that a
   * verdict cannot say "you gave me nothing to check", so `checkEntraIdentity` decides that case before
   * dialing — and the Vitest case pinning that it does not dial is #185's acceptance item 2.
   */
  entraIssuerAllowed?(organisationId: string, issuerTenantId: string, accessToken: string): Promise<EntraIssuerVerdict | null>;
}

export async function checkEntraIdentity(input: {
  identity: Pick<Extract<IdentityExchange, { ok: true }>, "emailVerified" | "issuerTenantId">;
  organisationId: string;
  /** Whose token the policy read is made with — the same identity the gate is about to decide on. */
  accessToken: string;
  ports: EntraPolicyPorts;
}): Promise<{ ok: true } | { ok: false; reason: EntraRefusal }> {
  if (typeof input.ports.entraIssuerAllowed !== "function") {
    return { ok: false, reason: "policy_unresolved" };
  }
  const issuer = input.identity.issuerTenantId;
  // Issuer-absence is decided here, before the read, because a verdict read cannot express it: an empty
  // candidate against an organization that exists answers `denied`, which would report "who is this?" as
  // "the tenant refuses them" — the exact confusion the operator log line keeps the two apart. This is
  // the branch #185's acceptance item 2 says stays Vitest's, and the test pins that no call is made.
  // (One ordering consequence of the shape, noted rather than hidden: an identity that is *both*
  // unverified and issuer-less is now reported as `issuer_unknown` rather than `unverified_email`. Both
  // refuse, and `decideEntraLink` still answers `unverified_email` first whenever a verdict was read.)
  if (typeof issuer !== "string" || issuer.length === 0) return { ok: false, reason: "issuer_unknown" };
  let verdict: EntraIssuerVerdict | null;
  try {
    verdict = await input.ports.entraIssuerAllowed(input.organisationId, issuer, input.accessToken);
  } catch {
    // A policy read that fails is not a policy that permits nothing and not a policy that permits
    // everything: it permits nothing we can check, so the identity is refused.
    return { ok: false, reason: "policy_unresolved" };
  }
  return decideEntraLink({
    emailVerified: input.identity.emailVerified,
    issuerTenantId: issuer,
    issuerVerdict: verdict,
  });
}

// ---------------------------------------------------------------- the start half: POST /auth/entra

export interface EntraStartPorts extends SignInRequestPorts, EntraPolicyPorts {
  /** The configured project URL. Never derived from the request, and never a wildcard (F05). */
  supabaseBaseUrl(): string | null;
}

export interface EntraSignInStartInput {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: EntraStartPorts;
}

/**
 * `POST /auth/entra`: the login page's "Sign in with Microsoft" control posts here rather than linking
 * straight at the provider, because the state and PKCE verifier that make the callback meaningful have
 * to be issued by this host, under this host's cookie, with a CSRF token behind them — the same shape
 * the magic-link request uses, for the same reason (#44: sign-in posts must establish the tenant from
 * `request.url`).
 *
 * What the browser is then sent to is built entirely here: the configured project's authorize endpoint,
 * the provider key this server chose, and a `redirect_to` that is exactly this host's callback with
 * this attempt's state. A `redirect_to`, `provider` or `tenant` in the request changes nothing, which
 * is what keeps a callback URL from becoming an open redirect or a way to pick your own issuer.
 */
export async function handleEntraSignInRequest(input: EntraSignInStartInput): Promise<Response> {
  const { ports } = input;

  const guarded = await readGuardedFormRequest(input);
  if (!guarded.ok) return guarded.response;
  const { host, secret, secureTransport } = guarded;

  const base = parseConfiguredBase(ports.supabaseBaseUrl());
  if (base === null) {
    // A missing or malformed project binding is a service fault, and the generic outcome is the whole
    // answer: nothing half-built is sent and no cookie is set.
    return loginRedirect(host, "unavailable", []);
  }

  // Before the browser is handed to the IdP: if this deployment cannot read the tenant's issuer policy
  // at all, the attempt would end at a refusal after a full round trip through Microsoft. Refusing here
  // says so at the point where the answer is still useful. The SQL behind the port has landed with PR-2,
  // so the state this catches is a deployment without `SUPABASE_URL`/`SUPABASE_ANON_KEY` — and the port
  // stays optional rather than becoming a stub, for the reason PR-1 recorded: a port that exists and
  // throws lets the front half of the endpoint do real work first.
  // (`entraIssuerAllowed` is checked for existence only: at this point there is no identity and so no
  // issuer to ask about — the start half refuses because the callback half would have nothing to read.)
  if (typeof ports.entraIssuerAllowed !== "function") {
    console.error("entra sign-in refused", { host, step: "entra_policy", reason: "unwired" });
    return loginRedirect(host, "unavailable", []);
  }

  // The state carries which provider **this host** chose, so the callback's issuer gate is keyed on a
  // fact this server established and not only on the label the provider puts on its own payload.
  const loginState = await createLoginState({ host, secret, now: ports.now(), secureTransport, provider: "entra" });
  const callbackUrl = `https://${host}${CALLBACK_PATH}?state=${encodeURIComponent(loginState.nonce)}`;
  const challenge = await sha256Base64Url(loginState.codeVerifier);

  const url = new URL(`${base}${ENTRA_AUTHORIZE_PATH}`);
  url.searchParams.set("provider", "azure");
  url.searchParams.set("redirect_to", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "s256");

  return providerRedirect(url.toString(), [loginState.cookie]);
}

/** An https origin with no path, query or credentials — anything else is not a binding we will redirect into. */
function parseConfiguredBase(raw: string | null): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.pathname.replace(/\/+$/, "").length > 0) return null;
    if (url.search.length > 0 || url.hash.length > 0 || url.username.length > 0 || url.password.length > 0) return null;
    return url.origin;
  } catch {
    return null;
  }
}
