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
 * The fourth needs data the merged schema does not have: a per-tenant list of permitted Entra tenant
 * IDs. So the read is a port that answers "unresolved" until PR-2's `identity_methods` migration, and
 * unresolved **refuses**. That is not a placeholder standing in for a decision — a tenant with no
 * recorded Entra policy genuinely has no permitted issuer, which is the same answer as an empty list.
 *
 * The `tid` claim (the issuing Entra tenant) is read defensively from the identity payload because
 * which field of it Supabase surfaces for `azure` is a provider detail this repo has not yet seen on
 * staging; a missing or unreadable issuer is refused, never treated as unrestricted.
 */

/** Supabase names Entra ID `azure`; `microsoft` is accepted so a renamed provider key cannot slip past the gate. */
const ENTRA_PROVIDER_KEYS: readonly string[] = ["azure", "microsoft"];

/** The provider's own authorize endpoint. The path is this server's, never the request's (F05). */
export const ENTRA_AUTHORIZE_PATH = "/auth/v1/authorize";

/** Exact match, never case-folded: Entra tenant ids are uuids, and a near miss is a refusal. */
export function isEntraIdentity(provider: string | undefined): boolean {
  return typeof provider === "string" && ENTRA_PROVIDER_KEYS.includes(provider);
}

export type EntraRefusal = "unverified_email" | "issuer_unknown" | "issuer_not_allowed" | "policy_unresolved";

/**
 * The decision, with no I/O in it — so every branch of it is testable, including the ones the merged
 * schema cannot yet reach.
 */
export function decideEntraLink(input: {
  emailVerified: boolean;
  issuerTenantId: string | null | undefined;
  /** The tenant's permitted Entra tenant ids. Null: the policy is not readable, which is a refusal. */
  allowedIssuers: readonly string[] | null;
}): { ok: true } | { ok: false; reason: EntraRefusal } {
  if (input.allowedIssuers === null) return { ok: false, reason: "policy_unresolved" };
  if (!input.emailVerified) return { ok: false, reason: "unverified_email" };
  const issuer = input.issuerTenantId;
  if (typeof issuer !== "string" || issuer.length === 0) return { ok: false, reason: "issuer_unknown" };
  if (!input.allowedIssuers.some((allowed) => allowed === issuer)) return { ok: false, reason: "issuer_not_allowed" };
  return { ok: true };
}

export interface EntraPolicyPorts {
  /**
   * The organization's permitted Entra tenant ids: `[]` for a tenant that has configured none, and
   * `null` when the policy is not readable at all (the state until PR-2). No implementation is itself
   * treated as unresolved.
   */
  allowedEntraIssuers?(organisationId: string): Promise<readonly string[] | null>;
}

export async function checkEntraIdentity(input: {
  identity: Pick<Extract<IdentityExchange, { ok: true }>, "emailVerified" | "issuerTenantId">;
  organisationId: string;
  ports: EntraPolicyPorts;
}): Promise<{ ok: true } | { ok: false; reason: EntraRefusal }> {
  if (typeof input.ports.allowedEntraIssuers !== "function") {
    return { ok: false, reason: "policy_unresolved" };
  }
  let allowed: readonly string[] | null;
  try {
    allowed = await input.ports.allowedEntraIssuers(input.organisationId);
  } catch {
    // A policy read that fails is not a policy that permits nothing and not a policy that permits
    // everything: it permits nothing we can check, so the identity is refused.
    return { ok: false, reason: "policy_unresolved" };
  }
  return decideEntraLink({
    emailVerified: input.identity.emailVerified,
    issuerTenantId: input.identity.issuerTenantId,
    allowedIssuers: allowed,
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

  const guarded = await readGuardedFormRequest({ ...input, limitMethod: "entra-start" });
  if (!guarded.ok) return guarded.response;
  const { host, secret, secureTransport } = guarded;

  const base = parseConfiguredBase(ports.supabaseBaseUrl());
  if (base === null) {
    // A missing or malformed project binding is a service fault, and the generic outcome is the whole
    // answer: nothing half-built is sent and no cookie is set.
    return loginRedirect(host, "unavailable", []);
  }

  // Before the browser is handed to the IdP: if this deployment cannot read the tenant's issuer policy
  // at all, the attempt would end at a refusal after a full round trip through Microsoft and an email
  // the user was led to expect. Refusing here says so at the point where the answer is still useful
  // (PR-2 `t-201b-invite-reset-sql` lands the SQL; until then this endpoint is deliberately inert).
  if (typeof ports.allowedEntraIssuers !== "function") {
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
