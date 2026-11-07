import { hasUsableSecret } from "./signed-token";

/**
 * The server side of the tenant session (#37 option (b), recorded in
 * [ADR-0003](../../docs/decisions/0003-session-and-identity-carrier.md)).
 *
 * The browser holds an opaque 32-byte id. Everything that authenticates lives in a row keyed by a
 * **hash** of that id, and that row holds the verified user's Supabase access and refresh tokens
 * **encrypted at rest**. Two consequences this file is responsible for:
 *
 * 1. The row key is never the credential. A database leak, a backup, or a `SELECT` in a support
 *    session yields nothing an attacker can replay as a cookie, because the cookie value is the id
 *    and the key is a one-way digest of it.
 * 2. Token material is only ever *decrypted* inside the Worker, for the server-side database call.
 *    #37 makes it a hard condition that these tokens never reach the browser: a browser holding a
 *    user token could call `register_source_version_v1` directly and skip the byte verification the
 *    Worker performs, which is why `readSessionTokens` is a separate, deliberately awkward call and
 *    never part of anything a route hands to a page.
 *
 * No database is touched here: this is the port. `session.ts` consumes it, the deployment adapter
 * implements it, and the SQL half is `supabase/migrations/*_session_store.sql` plus
 * `supabase/tests/database/050_session_store.test.sql` (CI's `database` job runs pgTAP).
 */

/** A keyring version label: short, lowercase, and the first field of a sealed value. */
export const KEY_VERSION_SHAPE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** 32 bytes of entropy, base64url unpadded: 43 characters, the alphabet `cookie.ts` already allows. */
export const SESSION_ID_BYTES = 32;
export const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** A SHA-256 digest in the same encoding: also 43 characters, hence the same shape. */
export const SESSION_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();

/**
 * WebCrypto's types reject `Uint8Array<ArrayBufferLike>` (a shared buffer cannot be handed to a
 * cipher), so every value that goes into or out of `crypto.subtle` is a copy in a plain buffer.
 */
function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return new Uint8Array(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * Domain separation: the row key is a digest of a value that says what it is, so an id can never be
 * replayed as a key from some other digest context, and a future change of scheme is visible.
 */
const KEY_CONTEXT = "terraoi:session-key:v1:";

/**
 * The row key: `base64url(sha256(KEY_CONTEXT || sessionId))`.
 *
 * Throws on anything that is not a session id, which is what keeps a malformed cookie value from
 * ever becoming a database query parameter.
 */
export async function sessionStoreKey(sessionId: string): Promise<string> {
  if (typeof sessionId !== "string" || !SESSION_ID_SHAPE.test(sessionId)) {
    throw new Error("session id must be 32 bytes of base64url");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${KEY_CONTEXT}${sessionId}`));
  return bytesToBase64Url(new Uint8Array(digest));
}

/** The provider pair the row holds. Field names follow Supabase's, not a third local name (FAQ-0004). */
export interface SupabaseTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds of the access token's own expiry (Supabase: `expires_in` from the exchange). */
  expiresAt: number;
}

/** One row of the session table, in the shape the migration stores it. */
export interface StoredSession {
  userId: string;
  /** The host the session was issued on; the cross-host guard reads this, never a cookie claim. */
  host: string;
  issuedAt: number;
  expiresAt: number;
  /** Epoch seconds, or null while the session is live. Sign-out and revocation set this (#37). */
  revokedAt: number | null;
  /** Which keyring version encrypted the pair below, so a rotation can still read existing rows. */
  keyVersion: string;
  accessCiphertext: string;
  refreshCiphertext: string;
  tokenExpiresAt: number;
}

/** The rotation write: a new sealed pair, or nothing, if the row went away or was revoked in between. */
export interface SessionTokenReplacement {
  keyVersion: string;
  accessCiphertext: string;
  refreshCiphertext: string;
  tokenExpiresAt: number;
}

/**
 * The store port. `replaceTokens` returns false when the row no longer exists or has been revoked,
 * which is how a concurrent sign-out beats a refresh that is already in flight.
 */
export interface SessionStore {
  insert(input: { sessionKey: string; session: StoredSession }): Promise<void>;
  find(sessionKey: string): Promise<StoredSession | null>;
  revoke(sessionKey: string, at: number): Promise<void>;
  replaceTokens(sessionKey: string, replacement: SessionTokenReplacement): Promise<boolean>;
}

/**
 * Encrypts token material at rest. The Worker binding is named `SESSION_TOKEN_KEY` (minted as a
 * T-004 human action with `wrangler secret put`; no value may ever enter the repo, and
 * `wrangler.jsonc` is not touched by code). Tests inject a synthetic keyring; nothing here logs or
 * returns key material.
 */
export interface TokenCipher {
  /** The version new seals are written with. Old versions stay openable while the keyring holds them. */
  readonly keyVersion: string;
  seal(plaintext: string): Promise<string>;
  /** The plaintext, or null for anything this keyring cannot open — never a throw on bad data. */
  open(sealed: string): Promise<string | null>;
}

/** AES-256-GCM. A fresh random IV per seal, so two rows with the same token never look alike. */
const CIPHER = { name: "AES-GCM", length: 256 } as const;
const IV_BYTES = 12;
/** HKDF info: the derived key is bound to this purpose, so one secret cannot double as an HMAC key. */
const KEY_INFOS = new Map<string, Uint8Array<ArrayBuffer>>();
function keyInfo(version: string): Uint8Array<ArrayBuffer> {
  const cached = KEY_INFOS.get(version);
  if (cached) return cached;
  const info = utf8(`terraoi:session-token-cipher:v1:${version}`);
  KEY_INFOS.set(version, info);
  return info;
}

async function deriveKey(secret: string, version: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(`terraoi:session-token:${version}`), info: keyInfo(version) },
    material,
    CIPHER,
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * A keyring, not a single key: `currentVersion` seals everything new, and `keys` may still hold the
 * previous version so existing rows stay readable during a rotation window. Dropping a version here
 * is what makes its rows undecryptable — that is the retention lever ADR-0003 writes down.
 */
export function createTokenCipher(input: { currentVersion: string; keys: Record<string, string> }): TokenCipher {
  const currentVersion = input.currentVersion;
  if (typeof currentVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(currentVersion)) {
    throw new Error("key version must be a short lowercase token");
  }
  const secret: string | undefined = input.keys[currentVersion];
  // Fail closed, the same rule `signed-token.ts` applies to the signing key: no default, no
  // development fallback, no empty key.
  if (typeof secret !== "string" || !hasUsableSecret(secret)) {
    throw new Error("the SESSION_TOKEN_KEY binding is required (no default key, no development fallback)");
  }
  const cache = new Map<string, Promise<CryptoKey>>();
  const keyFor = (version: string): Promise<CryptoKey> | null => {
    const value: string | undefined = input.keys[version];
    if (typeof value !== "string" || !hasUsableSecret(value)) return null;
    const existing = cache.get(version);
    if (existing) return existing;
    const created = deriveKey(value, version);
    cache.set(version, created);
    return created;
  };

  return {
    keyVersion: currentVersion,
    async seal(plaintext: string): Promise<string> {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new Error("cannot seal empty token material");
      }
      const key = await keyFor(currentVersion);
      if (key === null) throw new Error("current SESSION_TOKEN_KEY binding is not usable");
      const iv = new Uint8Array(IV_BYTES);
      crypto.getRandomValues(iv);
      // The version name is its own label (the keyring holds `v1`, `v2`, …); it is also the GCM
      // additional data, so a row cannot be reinterpreted under another version.
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(currentVersion) }, key, utf8(plaintext));
      return `${currentVersion}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
    },
    async open(sealed: string): Promise<string | null> {
      if (typeof sealed !== "string") return null;
      const parts = sealed.split(".");
      if (parts.length !== 3) return null;
      const [version, ivPart, ciphertextPart] = parts as [string, string, string];
      if (!KEY_VERSION_SHAPE.test(version)) return null;
      const iv = base64UrlToBytes(ivPart);
      const ciphertext = base64UrlToBytes(ciphertextPart);
      if (iv === null || ciphertext === null || iv.length !== IV_BYTES) return null;
      const key = await keyFor(version);
      if (key === null) return null;
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: utf8(version) },
          await key,
          ciphertext,
        );
        return new TextDecoder().decode(plain);
      } catch {
        // A tampered or foreign value is a null, not an exception: the caller must not be able to
        // tell "wrong key" from "corrupted row" from a response difference.
        return null;
      }
    },
  };
}

/** A pair is only worth storing if it is complete and not already expired when it arrives. */
export function isUsableTokenPair(tokens: SupabaseTokens | null | undefined, now: number): boolean {
  if (tokens === null || tokens === undefined) return false;
  if (typeof tokens.accessToken !== "string" || tokens.accessToken.length === 0) return false;
  if (typeof tokens.refreshToken !== "string" || tokens.refreshToken.length === 0) return false;
  return Number.isSafeInteger(tokens.expiresAt) && tokens.expiresAt > now;
}
