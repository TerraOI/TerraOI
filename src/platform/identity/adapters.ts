import { z } from "zod";

import type { TenancyStore } from "@/platform/tenancy/resolve-tenant-context";

import type { IdentityExchange, MagicLinkCallbackPorts } from "./complete-magic-link";
import type { LoginViewPorts } from "./login-view";
import type { MagicLinkRequestPorts } from "./request-magic-link";
import type { SignOutPorts } from "./sign-out";
import type { SessionStore } from "./session-store";
import { createTokenCipher } from "./session-store";
import type { TokenCipher } from "./session-store";
import { bytesToBase64Url, hasUsableSecret, hmacBytes } from "./signed-token";

/**
 * Deployment wiring for the sign-in endpoints (the `src/platform/site/adapters.ts` pattern: real
 * implementations behind the ports, every binding optional in the type, a missing one failing
 * closed). Only the **anon / publishable** key is used, and only from a server path: a service-role
 * or admin key appears nowhere in this module, and nothing here would work if one were passed —
 * AGENTS.md §4.2 allows such a key only with a comment and an ADR, and #37 explicitly refused one
 * for this path ("No service-role key in the Worker for this path").
 */

export type IdentityEnv = {
  /** HMAC key for the CSRF and login-state envelopes (#30's signed token). T-004 human action. */
  IDENTITY_SESSION_KEY?: string;
  /**
   * The AES-GCM key that seals the user's Supabase tokens at rest in `toi_identity.sessions`
   * (#37: "encrypted at rest with a Worker secret"). A **second** secret on purpose: one key that
   * both signs cookies and encrypts credentials means a bug in either is a total compromise.
   * Minted with `wrangler secret put SESSION_TOKEN_KEY`; its value never enters the repo.
   */
  SESSION_TOKEN_KEY?: string;
  /**
   * The previous `SESSION_TOKEN_KEY`, kept only for the rotation window: rows sealed under the old key
   * stay readable while it is bound, and dropping this binding makes them undecryptable (ADR-0003).
   * Binding it advances the keyring version from `v1` to `v2`.
   */
  SESSION_TOKEN_KEY_PREVIOUS?: string;
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

/**
 * The second #37 seam, and the one #75 opened: the session **row**.
 *
 * #37 put the row in a schema the Data API does not expose ("reachable only by the session code
 * path"), and refused a service-role key for this path — so no PostgREST call, with any key, can
 * reach it, and this repo does not get to invent the alternative. The connection, the login role and
 * its grants are the three options on #75, and the role creation, the connection config, its binding
 * and the encryption secret are §20.8 human steps whoever wins.
 *
 * So this refuses, in the same shape as `unresolvedTenancyStore()`. The consequence is visible and
 * deliberate: with no store, `issueSession` throws and the callback answers "unavailable" with no
 * cookie — a deployment can never quietly fall back to the self-contained cookie #37 rejected.
 */
export function unresolvedSessionStore(): SessionStore {
  const refuse = (): never => {
    throw new Error("session store carrier unresolved (#75): refusing to guess how the session row is reached");
  };
  return {
    insert: async () => refuse(),
    find: async () => refuse(),
    revoke: async () => refuse(),
    replaceTokens: async () => refuse(),
  };
}

/**
 * The at-rest keyring for the token pair. No binding, no cipher — and `issueSession` then refuses to
 * mint a session rather than storing a credential in the clear.
 */
function sessionTokenCipher(env: Partial<IdentityEnv>): TokenCipher | null {
  const current = env.SESSION_TOKEN_KEY;
  if (!hasUsableSecret(current)) return null;
  const previous = env.SESSION_TOKEN_KEY_PREVIOUS;
  // The version label advances when a previous key is bound: rows written under `v1` stay readable
  // during the rotation, and unbinding the old key retires them.
  const keys: Record<string, string> = { v1: current };
  let currentVersion = "v1";
  if (hasUsableSecret(previous)) {
    keys.v1 = previous;
    keys.v2 = current;
    currentVersion = "v2";
  }
  try {
    return createTokenCipher({ currentVersion, keys });
  } catch {
    return null;
  }
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
    sessionStore: () => unresolvedSessionStore(),
    tokenCipher: () => sessionTokenCipher(env),

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
      // #37 option (b): the pair is part of the result, and it stops here. It is what the session row
      // stores (sealed) and what later server calls use; it is never handed to a response, a cookie or
      // a page. An exchange that returns an identity without a complete pair is not a signed-in
      // session, so it collapses into the same safe reason as every other failure.
      const accessToken = (payload as { access_token?: unknown } | null)?.access_token;
      const refreshToken = (payload as { refresh_token?: unknown } | null)?.refresh_token;
      const expiresIn = (payload as { expires_in?: unknown } | null)?.expires_in;
      if (typeof accessToken !== "string" || accessToken.length === 0) return { ok: false, reason: "invalid_or_expired" };
      if (typeof refreshToken !== "string" || refreshToken.length === 0) return { ok: false, reason: "invalid_or_expired" };
      if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
        return { ok: false, reason: "invalid_or_expired" };
      }
      return {
        ok: true,
        userId: user.id,
        email: user.email,
        emailVerified: typeof user.email_confirmed_at === "string",
        accessToken,
        refreshToken,
        tokenExpiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      };
    },
  };
}
