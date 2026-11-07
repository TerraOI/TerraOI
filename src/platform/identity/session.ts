import { z } from "zod";

import { NormalizedHost } from "@/contracts/keys";

import { cookieName, isDevelopmentRuntime, parseCookieHeader, type CookieSpec } from "./cookie";
import { randomToken } from "./signed-token";
import {
  SESSION_ID_SHAPE,
  isUsableTokenPair,
  sessionStoreKey,
  type SessionStore,
  type StoredSession,
  type SupabaseTokens,
  type TokenCipher,
} from "./session-store";

/**
 * The tenant session carrier, per the supervisor's #37 decision (option b), recorded in
 * [ADR-0003](../../../docs/decisions/0003-session-and-identity-carrier.md).
 *
 * `__Host-toi_session` holds an **opaque random id** — 32 bytes, base64url — and nothing else. No
 * `sub`, no host, no expiry, no claim of any kind: the cookie means something only as a lookup key
 * into a server-side row. Everything that authenticates lives behind the `SessionStore` port in
 * `session-store.ts`, keyed by a hash of the id: the user, the host the session was issued on, the
 * created/expires/revoked timestamps, and the user's Supabase token pair encrypted at rest.
 *
 * What that buys, and why the old self-contained record could not:
 *   * **Revocation.** Sign-out sets `revoked_at`, so a stolen cookie stops working immediately
 *     instead of at the 8-hour expiry. This is the one property a signed cookie cannot have.
 *   * **No token in the browser.** The verified user's Supabase tokens stay on the server, which is
 *     #37's hard condition: a browser holding a user token could call `register_source_version_v1`
 *     directly and skip the byte verification the Worker performs. `readSessionTokens` exists for the
 *     server half only and is never reachable from a page or a route response.
 *   * **A leak of the table is not a leak of credentials.** The row key is a one-way digest of the
 *     cookie value, and the tokens are sealed under the `SESSION_TOKEN_KEY` Worker binding.
 *
 * What has NOT changed: the session is still never a membership claim. Every request re-resolves the
 * organization from the routed host and the current `organisation_memberships` row (T-101's resolver),
 * so a removed member loses access on the next request however fresh this cookie is. The signed-token
 * envelope from #30 stays, for CSRF and the login state — see `csrf.ts` and `login-state.ts`.
 */

export const SESSION_COOKIE_BASE = "toi_session";
/** A working day, and no longer: a long-lived cookie only ever widens a theft window (#37: 8 h). */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export { SESSION_ID_BYTES, SESSION_ID_SHAPE } from "./session-store";

/**
 * Closed set of reasons. `unknown_session` (never issued, or already pruned) is reported separately
 * from `missing` so the log says something useful, and both render the same sign-in surface: no
 * response to a caller ever distinguishes "that id does not exist" from "that id is malformed".
 */
export type SessionRejection =
  | "missing"
  | "malformed"
  | "unknown_session"
  | "revoked"
  | "expired"
  | "host_mismatch"
  | "store_failure";

/** The token half adds two failures that only exist once the row is known to be live. */
export type SessionTokenRejection = SessionRejection | "undecryptable" | "refresh_failed";

export type SessionRead =
  | { ok: true; userId: string; sessionId: string; expiresAt: number }
  | { ok: false; reason: SessionRejection };

export type SessionTokensRead =
  | { ok: true; userId: string; sessionId: string; tokens: SupabaseTokens }
  | { ok: false; reason: SessionTokenRejection };

/** A provider half, so the refresh rule is testable without a network: return null to refuse. */
export interface TokenRefreshProvider {
  refresh(input: { refreshToken: string; now: number }): Promise<SupabaseTokens | null>;
}

export interface IssueSessionInput {
  userId: string;
  host: string;
  /** The verified user's Supabase pair, from the PKCE exchange. Stored sealed, never returned. */
  tokens: SupabaseTokens;
  store: SessionStore;
  cipher: TokenCipher;
  /** Seconds since epoch from the caller, so tests control the clock. */
  now: number;
  secureTransport: boolean;
  ttlSeconds?: number;
}

export interface IssuedSession {
  /** The opaque value the browser gets. */
  sessionId: string;
  /** The row key: never sent to the browser, and never equal to the id. */
  sessionKey: string;
  cookie: CookieSpec;
}

type RowLookup =
  | { ok: true; sessionId: string; sessionKey: string; row: StoredSession }
  | { ok: false; reason: SessionRejection };

/**
 * The single place that decides whether a cookie names a live session on this host. Every guard is
 * evaluated against the **row**, because the cookie carries no claims to check.
 */
async function lookupRow(input: {
  cookieHeader: string | null | undefined;
  host: string;
  now: number;
  store: SessionStore;
}): Promise<RowLookup> {
  if (typeof input.store?.find !== "function" || typeof input.store.revoke !== "function") {
    return { ok: false, reason: "store_failure" };
  }
  const cookies = parseCookieHeader(input.cookieHeader);
  // Only a development runtime can ever have received an unprefixed cookie. Outside it, a stray
  // `toi_session` is not a name this server honors, so it is simply not a session (PR #18 N1).
  const developmentName = isDevelopmentRuntime() ? cookieName(SESSION_COOKIE_BASE, false) : null;
  const value =
    cookies[cookieName(SESSION_COOKIE_BASE, true)] ?? (developmentName === null ? undefined : cookies[developmentName]);
  if (value === undefined || value.length === 0) return { ok: false, reason: "missing" };

  // Shape before lookup: a cookie holding a signed envelope, a Supabase JWT or free text never
  // reaches the store as a query value. That is both an injection guard and the reason a
  // pre-#37 session cookie cannot be replayed as an id.
  if (!SESSION_ID_SHAPE.test(value)) return { ok: false, reason: "malformed" };

  const sessionKey = await sessionStoreKey(value).catch(() => null);
  if (sessionKey === null) return { ok: false, reason: "malformed" };

  let row: StoredSession | null;
  try {
    row = await input.store.find(sessionKey);
  } catch {
    // A database failure is a failed authentication, never a successful one, and never a 500: the
    // caller maps this to the same sign-in surface as `unknown_session`.
    return { ok: false, reason: "store_failure" };
  }
  if (row === null) return { ok: false, reason: "unknown_session" };

  // A row that does not parse was not written by this code path. Refuse it rather than trust it.
  if (typeof row.userId !== "string" || !z.uuid().safeParse(row.userId).success) return { ok: false, reason: "malformed" };
  if (typeof row.host !== "string" || !NormalizedHost.safeParse(row.host).success) return { ok: false, reason: "malformed" };
  if (!Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.issuedAt) {
    return { ok: false, reason: "malformed" };
  }
  if (row.revokedAt !== null && !Number.isSafeInteger(row.revokedAt)) return { ok: false, reason: "malformed" };
  if (typeof row.accessCiphertext !== "string" || typeof row.refreshCiphertext !== "string") {
    return { ok: false, reason: "malformed" };
  }

  // The stored issuing host, compared to the host the edge routed us to (plan §4.1 step 1). This is
  // what makes "a session cookie from company1 is not accepted on company2" true for a hand-replayed
  // value, which the `__Host-` prefix alone cannot do.
  if (row.host !== input.host) return { ok: false, reason: "host_mismatch" };
  // Revocation is checked before expiry on purpose: "someone revoked this" is the stronger fact, and
  // it is the fact the self-contained cookie could not carry.
  if (row.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (input.now >= row.expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, sessionId: value, sessionKey, row };
}

export async function issueSession(input: IssueSessionInput): Promise<IssuedSession> {
  if (!z.uuid().safeParse(input.userId).success) {
    throw new Error("a session subject must be an identity id");
  }
  if (!NormalizedHost.safeParse(input.host).success) {
    throw new Error("a session host must be a normalized host");
  }
  // Fail closed rather than fall back to the old self-contained cookie: with no store or no cipher
  // there is nowhere safe to put the user's tokens, so there is no session to issue at all.
  if (typeof input.store?.insert !== "function" || typeof input.store.find !== "function") {
    throw new Error("a session store binding is required (#75: the row must be reachable server-side)");
  }
  if (typeof input.cipher?.seal !== "function" || typeof input.cipher.open !== "function") {
    throw new Error("the SESSION_TOKEN_KEY cipher is required: tokens are never stored in the clear");
  }
  if (!isUsableTokenPair(input.tokens, input.now)) {
    throw new Error("a session needs the verified user's unexpired Supabase token pair");
  }
  const ttl = input.ttlSeconds ?? SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > SESSION_TTL_SECONDS) {
    throw new Error(`session ttl must be a positive number of seconds no greater than ${SESSION_TTL_SECONDS}`);
  }

  const sessionId = randomToken(32);
  const sessionKey = await sessionStoreKey(sessionId);
  // Seal before the insert so a row can never be written with plaintext token material, even for the
  // instant between insert and update.
  const accessCiphertext = await input.cipher.seal(input.tokens.accessToken);
  const refreshCiphertext = await input.cipher.seal(input.tokens.refreshToken);
  await input.store.insert({
    sessionKey,
    session: {
      userId: input.userId,
      host: input.host,
      issuedAt: input.now,
      expiresAt: input.now + ttl,
      revokedAt: null,
      keyVersion: input.cipher.keyVersion,
      accessCiphertext,
      refreshCiphertext,
      tokenExpiresAt: input.tokens.expiresAt,
    },
  });

  return {
    sessionId,
    sessionKey,
    // The cookie value is the opaque id. `cookieName` refuses the unprefixed form outside a
    // development runtime, and `serializeSetCookie` refuses a `__Host-` name that is not
    // `Secure` + `Path=/`; neither rule is weakened by the change of carrier.
    cookie: {
      name: cookieName(SESSION_COOKIE_BASE, input.secureTransport),
      value: sessionId,
      maxAge: ttl,
      secure: input.secureTransport,
      httpOnly: true,
      sameSite: "Lax",
    },
  };
}

/**
 * The only safe reading of a session cookie. The host argument comes from the routed URL
 * (`requestHost` in T-101), never from the cookie or a header.
 */
export async function readSession(input: {
  cookieHeader: string | null | undefined;
  host: string;
  now: number;
  store: SessionStore;
}): Promise<SessionRead> {
  const found = await lookupRow(input);
  if (!found.ok) return found;
  return { ok: true, userId: found.row.userId, sessionId: found.sessionId, expiresAt: found.row.expiresAt };
}

/**
 * Sign-out and revocation (#37): `revoked_at` is set so the cookie stops working now, not at expiry.
 * Revocation is scoped to the issuing host — a company1 cookie cannot touch a company2 row — and a
 * missing or malformed cookie is simply "nothing to revoke", which is not an error to report.
 */
export async function revokeSession(input: {
  cookieHeader: string | null | undefined;
  host: string;
  now: number;
  store: SessionStore;
}): Promise<{ ok: boolean; reason?: SessionRejection }> {
  const found = await lookupRow(input);
  if (!found.ok) return { ok: false, reason: found.reason };
  try {
    await input.store.revoke(found.sessionKey, input.now);
  } catch {
    // Never report a successful sign-out when the row is still live: the browser's cookie is cleared
    // either way, and this is what tells the caller the server half did not happen.
    return { ok: false, reason: "store_failure" };
  }
  return { ok: true };
}

/**
 * The server half: the verified user's token pair, decrypted, for the call that carries their
 * identity into Postgres (#37 half 2). Deliberately a separate call from `readSession`, so a reviewer
 * can see every place that touches token material, and so nothing on a response path can pick them up
 * by accident.
 */
export async function readSessionTokens(input: {
  cookieHeader: string | null | undefined;
  host: string;
  now: number;
  store: SessionStore;
  cipher: TokenCipher;
}): Promise<SessionTokensRead> {
  if (typeof input.cipher?.open !== "function") return { ok: false, reason: "store_failure" };
  const found = await lookupRow(input);
  if (!found.ok) return found;
  const pair = await openPair(found.row, input.cipher);
  if (pair === null) return { ok: false, reason: "undecryptable" };
  return { ok: true, userId: found.row.userId, sessionId: found.sessionId, tokens: pair };
}

async function openPair(row: StoredSession, cipher: TokenCipher): Promise<SupabaseTokens | null> {
  const accessToken = await cipher.open(row.accessCiphertext);
  const refreshToken = await cipher.open(row.refreshCiphertext);
  if (accessToken === null || refreshToken === null) return null;
  return { accessToken, refreshToken, expiresAt: row.tokenExpiresAt };
}

/**
 * Refresh and rotation (#37 asks the ADR to state this rule): the stored access token is used while
 * it is live, and refreshed inside a skew window before its own expiry. Supabase rotates the refresh
 * token on use, so the new pair replaces the old one in the same row — the row key, the session and
 * the cookie never change, which is what keeps a live browser signed in across a rotation.
 *
 * A write-back that loses to a concurrent revocation is reported as `revoked`, not silently retried:
 * the rotated pair must never be restored under a revoked row.
 */
export async function rotateSessionTokens(input: {
  cookieHeader: string | null | undefined;
  host: string;
  now: number;
  store: SessionStore;
  cipher: TokenCipher;
  provider: TokenRefreshProvider;
  /** Refresh this many seconds before the access token's own expiry. */
  skewSeconds?: number;
}): Promise<SessionTokensRead> {
  if (typeof input.cipher?.open !== "function" || typeof input.cipher.seal !== "function") {
    return { ok: false, reason: "store_failure" };
  }
  if (typeof input.provider?.refresh !== "function") return { ok: false, reason: "refresh_failed" };
  const found = await lookupRow(input);
  if (!found.ok) return found;

  const current = await openPair(found.row, input.cipher);
  if (current === null) return { ok: false, reason: "undecryptable" };

  const skew = input.skewSeconds ?? REFRESH_SKEW_SECONDS;
  if (found.row.tokenExpiresAt > input.now + skew) {
    return { ok: true, userId: found.row.userId, sessionId: found.sessionId, tokens: current };
  }

  let rotated: SupabaseTokens | null;
  try {
    rotated = await input.provider.refresh({ refreshToken: current.refreshToken, now: input.now });
  } catch {
    // The provider's error text can name the failure or carry the response body; none of it may
    // travel, and nothing here returns or logs the material it was holding.
    return { ok: false, reason: "refresh_failed" };
  }
  if (rotated === null || !isUsableTokenPair(rotated, input.now)) return { ok: false, reason: "refresh_failed" };

  const accessCiphertext = await input.cipher.seal(rotated.accessToken);
  const refreshCiphertext = await input.cipher.seal(rotated.refreshToken);
  let replaced: boolean;
  try {
    replaced = await input.store.replaceTokens(found.sessionKey, {
      keyVersion: input.cipher.keyVersion,
      accessCiphertext,
      refreshCiphertext,
      tokenExpiresAt: rotated.expiresAt,
    });
  } catch {
    return { ok: false, reason: "store_failure" };
  }
  if (!replaced) return { ok: false, reason: "revoked" };

  return { ok: true, userId: found.row.userId, sessionId: found.sessionId, tokens: rotated };
}

/** Long enough to avoid a provider call on every request, short enough to never use an expired token. */
export const REFRESH_SKEW_SECONDS = 60;
