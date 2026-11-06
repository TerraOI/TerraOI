import { z } from "zod";

import type { TenancyStore } from "@/platform/tenancy/resolve-tenant-context";

import type { IdentityExchange, MagicLinkCallbackPorts } from "./complete-magic-link";
import type { LoginViewPorts } from "./login-view";
import type { MagicLinkRequestPorts } from "./request-magic-link";
import type { SignOutPorts } from "./sign-out";
import { bytesToBase64Url, hmacBytes } from "./signed-token";

/**
 * Deployment wiring for the sign-in endpoints (the `src/platform/site/adapters.ts` pattern: real
 * implementations behind the ports, every binding optional in the type, a missing one failing
 * closed). Only the **anon / publishable** key is used, and only from a server path: a service-role
 * or admin key appears nowhere in this module, and nothing here would work if one were passed —
 * AGENTS.md §4.2 allows such a key only with a comment and an ADR, and #37 is where that decision
 * would come from.
 */

export type IdentityEnv = {
  /** HMAC key for the session, CSRF and login-state tokens. Minted as a T-004 human action. */
  IDENTITY_SESSION_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  /** The same Durable-Object shape the pilot-intake limiter uses. */
  IDENTITY_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
};

export interface IdentityPorts
  extends MagicLinkRequestPorts,
    MagicLinkCallbackPorts,
    LoginViewPorts,
    SignOutPorts {}

/** Narrow on purpose: enough for the two Auth calls and easy to fake in a unit test. */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const SUPABASE_SIGNUP_PATH = "/auth/v1/signup";
const SUPABASE_TOKEN_PATH = "/auth/v1/token?grant_type=pkce";

/**
 * The #37 seam, in code rather than in prose.
 *
 * The tenancy lookups the handlers need (`findHost`, `findMembership`, `policyRevision`) cannot be
 * written until the supervisor settles how a verified identity reaches Postgres — privileged
 * connection plus JWT-claim GUC, a per-user token against PostgREST, or `SECURITY DEFINER` RPCs
 * taking the user id as an argument. The host lookup alone could already run against
 * `public.resolve_tenant_host`, but choosing a connection identity here would pre-empt that decision
 * and put a role/grant surface on `main` that is hard to unwind, so every method refuses.
 */
export function unresolvedTenancyStore(): TenancyStore {
  const refuse = (): never => {
    throw new Error("tenancy store carrier unresolved (issue #37): refusing to guess how identity reaches Postgres");
  };
  return {
    findHost: async () => refuse(),
    findMembership: async () => refuse(),
    policyRevision: async () => refuse(),
  };
}

/**
 * The invite-claim RPC does not exist yet either: it is the `t-102e-identity-invites-sql` branch, and
 * its signature is one of the things #37 decides. Refusing here is what keeps "an invite can be
 * redeemed" from becoming an accidental truth.
 */
async function unresolvedRedeemInvitation(): Promise<"not_found"> {
  throw new Error("invite redemption RPC not landed (t-102e-identity-invites-sql, shape pending on #37)");
}

function sha256Base64Url(verifier: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then((digest) => bytesToBase64Url(new Uint8Array(digest)));
}

export function buildIdentityPorts(env: Partial<IdentityEnv>, options: { fetchImpl?: FetchImpl } = {}): IdentityPorts {
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((fetch as unknown) as FetchImpl);
  const baseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.replace(/\/+$/, "") : "";
  const anonKey = typeof env.SUPABASE_ANON_KEY === "string" ? env.SUPABASE_ANON_KEY : "";

  const authHeaders = (): Record<string, string> => {
    if (baseUrl.length === 0 || anonKey.length === 0) {
      throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY bindings are required");
    }
    // `apikey` + a bearer of the same publishable key is the Auth REST contract. Nothing else: a
    // service-role key would be a §4.2 privileged path with an ADR, and #37 has not granted one.
    return { apikey: anonKey, authorization: `Bearer ${anonKey}`, "content-type": "application/json" };
  };

  return {
    ...unresolvedTenancyStore(),
    redeemInvitation: async () => unresolvedRedeemInvitation(),

    now: () => Math.floor(Date.now() / 1000),
    signingSecret: () => env.IDENTITY_SESSION_KEY ?? null,

    // A keyed digest, so the limiter store never holds an enumerable address and a case variant of
    // one address cannot buy a second budget.
    rateLimitKey: async ({ host, email }) => bytesToBase64Url(await hmacBytes(env.IDENTITY_SESSION_KEY ?? "", `${host}|${email}`)),

    allowRequest: async (key) => {
      const limiter = env.IDENTITY_RATE_LIMITER;
      if (!limiter) throw new Error("IDENTITY_RATE_LIMITER binding missing");
      const { success } = await limiter.limit({ key });
      return success;
    },

    async sendMagicLink({ email, redirectTo, codeVerifier }) {
      const headers = authHeaders();
      const challenge = await sha256Base64Url(codeVerifier);
      // `create_user: "email_only"` keeps the endpoint from answering differently for a known
      // address: an unknown address gets an unconfirmed identity that can sign in and still be told
      // "no access", which is the model plan §4.2 describes. Sign-up spam is the trade, handled by
      // the limiter here and by provider captcha settings in T-004 (noted in the PR).
      const response = await fetchImpl(`${baseUrl}${SUPABASE_SIGNUP_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email,
          options: {
            email_redirect_to: redirectTo,
            code_challenge: challenge,
            code_challenge_method: "s256",
            create_user: "email_only",
          },
        }),
      });
      if (!response.ok) throw new Error(`auth signup refused with status ${response.status}`);
    },

    async exchangeLoginCode({ code, codeVerifier }): Promise<IdentityExchange> {
      const headers = authHeaders();
      const response = await fetchImpl(`${baseUrl}${SUPABASE_TOKEN_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
      });
      // A rejected PKCE exchange is one answer for every reason: expired, used, or never issued.
      if (!response.ok) return { ok: false, reason: "invalid_or_expired" };
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: "invalid_or_expired" };
      }
      const user = (payload as { user?: unknown } | null)?.user as
        | { id?: unknown; email?: unknown; email_confirmed_at?: unknown }
        | undefined;
      if (!user || typeof user.id !== "string" || !z.uuid().safeParse(user.id).success) {
        return { ok: false, reason: "invalid_or_expired" };
      }
      if (typeof user.email !== "string") return { ok: false, reason: "invalid_or_expired" };
      return { ok: true, userId: user.id, email: user.email, emailVerified: typeof user.email_confirmed_at === "string" };
    },
  };
}
