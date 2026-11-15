import { z } from "zod";

import type { TenancyStore } from "@/platform/tenancy/resolve-tenant-context";

import type { MagicLinkCallbackPorts } from "./complete-magic-link";
import type { EntraStartPorts } from "./entra-linking";
import type { LoginViewPorts } from "./login-view";
import type { PasswordResetPorts } from "./password-reset";
import type { PasswordSignInPorts } from "./password-signin";
import type { MagicLinkRequestPorts } from "./request-magic-link";
import type { SignOutPorts } from "./sign-out";
import { createSessionStore } from "./session-db";
import type { SessionStore } from "./session-store";
import { createTokenCipher } from "./session-store";
import type { TokenCipher } from "./session-store";
import type { IdentityExchange } from "./signin-completion";
import { createTenancyDataApi } from "./tenancy-data-api";
import { bytesToBase64Url, hasUsableSecret, hmacBytes, sha256Base64Url } from "./signed-token";

/**
 * Deployment wiring for the sign-in endpoints (the `src/platform/site/adapters.ts` pattern: real
 * implementations behind the ports, every binding optional in the type, a missing one failing
 * closed). Only the **anon / publishable** key is used for Auth and host lookup, and only from a
 * server path: a service-role or admin key appears nowhere in this module (#37).
 *
 * Session rows are reached over Hyperdrive `SESSION_DB` as `toi_session_worker` (#75).
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
  /**
   * Hyperdrive binding for `toi_identity` (#75). Login user is `IN ROLE toi_session_worker`.
   * Added under `env.staging` by the owner (T-004 §20.8); absent → sessionStore() returns null.
   */
  SESSION_DB?: { connectionString: string };
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  /** The same Durable-Object shape the pilot-intake limiter uses. */
  IDENTITY_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
};

export interface IdentityPorts
  extends MagicLinkRequestPorts,
    MagicLinkCallbackPorts,
    PasswordSignInPorts,
    PasswordResetPorts,
    EntraStartPorts,
    LoginViewPorts,
    SignOutPorts {}

/** Narrow on purpose: enough for the two Auth calls and easy to fake in a unit test. */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /** Optional: tenancy Data API prefers text; Auth paths only need json. */
  text?: () => Promise<string>;
}>;

const SUPABASE_SIGNUP_PATH = "/auth/v1/signup";
const SUPABASE_TOKEN_PATH = "/auth/v1/token?grant_type=pkce";
/**
 * GoTrue's own credential endpoint. The password grant is the reason this repo needs no password
 * hashing of its own: the credential is checked where it is stored, and a T-201 PR that added a hashing
 * dependency would be adding a second credential authority to argue with (AGENTS.md §6).
 */
const SUPABASE_PASSWORD_PATH = "/auth/v1/token?grant_type=password";
const SUPABASE_RECOVER_PATH = "/auth/v1/recover";

/**
 * Kept for tests that assert the refuse-closed seam. Production wiring uses `createTenancyDataApi`.
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

async function unresolvedRedeemInvitation(): Promise<"not_found"> {
  throw new Error("invite redemption RPC not landed (t-102e-identity-invites-sql, shape pending on #37)");
}

/**
 * Kept for tests. Production returns `null` from `sessionStore()` when `SESSION_DB` is unbound.
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

function sessionTokenCipher(env: Partial<IdentityEnv>): TokenCipher | null {
  const current = env.SESSION_TOKEN_KEY;
  if (!hasUsableSecret(current)) return null;
  const previous = env.SESSION_TOKEN_KEY_PREVIOUS;
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

/**
 * What GoTrue hands back for a completed credential. One reader for both grants, because the password
 * response and the PKCE response have the same shape and a second reader is where a second grant would
 * quietly stop checking something the first one checks: the id being a uuid, the address being present,
 * the pair being present and unexpired.
 */
function readAuthPayload(payload: unknown, now: number): IdentityExchange {
  const user = (payload as { user?: unknown } | null)?.user as
    | { id?: unknown; email?: unknown; email_confirmed_at?: unknown; app_metadata?: unknown; identities?: unknown }
    | undefined;
  if (!user || typeof user.id !== "string" || !z.uuid().safeParse(user.id).success) {
    return { ok: false, reason: "invalid_or_expired" };
  }
  if (typeof user.email !== "string") return { ok: false, reason: "invalid_or_expired" };
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
    tokenExpiresAt: now + expiresIn,
    // Which provider the identity came from, and (for Entra) which tenant issued it. Both are read
    // defensively: an identity that names no provider is treated as the mail one, and an identity with
    // no readable issuer is refused by the Entra gate rather than waved through.
    provider: readStringField(user.app_metadata, "provider"),
    issuerTenantId: issuerTenantIdOf(user),
  };
}

function readStringField(container: unknown, key: string): string | undefined {
  if (typeof container !== "object" || container === null) return undefined;
  const value = (container as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The issuing Entra tenant id. Supabase keeps the IdP's claims in `identity_data` on the linked
 * identity and copies a few onto `app_metadata`, and which of the two carries `tid` for the `azure`
 * provider is a provider detail not yet seen on staging — so both places are read, in a fixed order,
 * and an unreadable issuer is a refusal. The staging run that confirms this is owed (T-004 §20.8).
 */
function issuerTenantIdOf(user: { app_metadata?: unknown; identities?: unknown }): string | null {
  const direct = readStringField(user.app_metadata, "tid");
  if (direct !== undefined) return direct;
  const identities = Array.isArray(user.identities) ? user.identities : [];
  for (const identity of identities) {
    const fromIdentity = readStringField((identity as { identity_data?: unknown } | null)?.identity_data, "tid");
    if (fromIdentity !== undefined) return fromIdentity;
  }
  return null;
}

export function buildIdentityPorts(env: Partial<IdentityEnv>, options: { fetchImpl?: FetchImpl } = {}): IdentityPorts {
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((fetch as unknown) as FetchImpl);
  const baseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.replace(/\/+$/, "") : "";
  const anonKey = typeof env.SUPABASE_ANON_KEY === "string" ? env.SUPABASE_ANON_KEY : "";

  const authHeaders = (): Record<string, string> => {
    if (baseUrl.length === 0 || anonKey.length === 0) {
      throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY bindings are required");
    }
    return { apikey: anonKey, authorization: `Bearer ${anonKey}`, "content-type": "application/json" };
  };

  const tenancy =
    baseUrl.length > 0 && anonKey.length > 0
      ? createTenancyDataApi({
          supabaseUrl: baseUrl,
          anonKey,
          fetchImpl: async (url, init) => {
            const response = await fetchImpl(url, {
              method: init.method,
              headers: init.headers,
              body: init.body ?? "",
            });
            return {
              ok: response.ok,
              status: response.status,
              text: async () => (response.text ? response.text() : JSON.stringify(await response.json())),
            };
          },
        })
      : null;

  const sessionStore = createSessionStore({
    binding: env.SESSION_DB ?? null,
  });

  return {
    findHost: async (host) => {
      if (tenancy === null) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY bindings are required");
      return tenancy.findHost(host);
    },
    findMembership: async (organisationId, accessToken) => {
      if (tenancy === null) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY bindings are required");
      return tenancy.findMembership(organisationId, accessToken);
    },
    policyRevision: async (organisationId, accessToken) => {
      if (tenancy === null) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY bindings are required");
      return tenancy.policyRevision(organisationId, accessToken);
    },
    redeemInvitation: async () => unresolvedRedeemInvitation(),
    sessionStore: () => sessionStore,
    tokenCipher: () => sessionTokenCipher(env),

    now: () => Math.floor(Date.now() / 1000),
    signingSecret: () => env.IDENTITY_SESSION_KEY ?? null,

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
      if (!response.ok) return { ok: false, reason: "invalid_or_expired" };
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: "invalid_or_expired" };
      }
      return readAuthPayload(payload, Math.floor(Date.now() / 1000));
    },

    async exchangePasswordCredentials({ email, password }): Promise<IdentityExchange> {
      const headers = authHeaders();
      // The credential is posted to the provider that stores it, over the anon key like every other
      // Auth call here, and it appears in no log line this module writes.
      const response = await fetchImpl(`${baseUrl}${SUPABASE_PASSWORD_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password }),
      });
      // GoTrue answers a wrong password and an unknown address the same way (400 "Invalid login
      // credentials"), which is exactly the indistinguishability the handler wants; anything else that
      // is not a well-formed session is the same closed reason too.
      if (!response.ok) return { ok: false, reason: "invalid_or_expired" };
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: "invalid_or_expired" };
      }
      return readAuthPayload(payload, Math.floor(Date.now() / 1000));
    },

    async sendPasswordRecovery({ email, redirectTo, codeVerifier }) {
      const headers = authHeaders();
      const challenge = await sha256Base64Url(codeVerifier);
      const response = await fetchImpl(`${baseUrl}${SUPABASE_RECOVER_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email,
          options: {
            email_redirect_to: redirectTo,
            code_challenge: challenge,
            code_challenge_method: "s256",
          },
        }),
      });
      if (!response.ok) throw new Error(`auth recover refused with status ${response.status}`);
    },

    supabaseBaseUrl: () => (baseUrl.length > 0 ? baseUrl : null),

    // ---- ports whose SQL has not landed yet (T-201 PR-2, `identity_methods` migration) ----------
    // Refusing is the only honest implementation: the Entra gate treats an unreadable policy as no
    // permitted issuer, and a recovery with no way to revoke the user's other sessions is not
    // completed. Neither falls back to "unrestricted", and neither is a placeholder for a decision —
    // the migration and its pgTAP half are PR-2's deliverable.
    allowedEntraIssuers: async () => {
      throw new Error("entra issuer policy not landed (T-201 PR-2: identity_methods migration)");
    },
    revokeUserSessions: async () => {
      throw new Error("session revocation not landed (T-201 PR-2: identity_methods migration)");
    },
  };
}
