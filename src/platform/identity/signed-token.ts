/**
 * A compact HMAC-signed token for the host-bound artifacts of T-102: the session cookie, the CSRF
 * token and the magic-link login state.
 *
 * Plan §4.2 keeps the session on the server side of the BFF: nothing here is a bearer credential
 * for data, it is proof that *this browser* completed a verified sign-in **on this host**. Every
 * artifact carries the host in its signed payload, so a company1 artifact is refused on company2
 * even when a cookie is replayed by hand, and each carries a `typ` claim so one can never be
 * replayed as another.
 *
 * Membership and authorization are never in these claims: they come from current database state on
 * every request (plan §4.2 "do not use a stale unverified JWT claim as the only membership check").
 */

type ClaimValue = string | number;
export type TokenClaims = Record<string, ClaimValue>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;
export const MIN_SECRET_LENGTH = 32;

/** Base64url without padding: safe in a cookie value, a query value or a JSON field. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!TOKEN_SHAPE.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * A deployment binding, never a repository value (AGENTS.md §4.6). Callers fail closed without one.
 * Narrowing to `string` is deliberate: a caller that has passed this check can hand the secret on to
 * `signToken` / `verifyToken` without a cast, and one that has not must choose the safe answer.
 */
export function hasUsableSecret(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

async function hmac(payload: string, secret: string): Promise<Uint8Array> {
  return hmacBytes(secret, payload);
}

/** Exported for the adapters, which need a keyed digest rather than a token. */
export async function hmacBytes(secret: string, message: string): Promise<Uint8Array> {
  if (!hasUsableSecret(secret)) throw new Error("a signing secret binding is required");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(signature);
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** `payload.signature`, both parts in the base64url alphabet so they need no escaping anywhere. */
export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new Error("claims must be an object");
  }
  const keys = Object.keys(claims);
  if (keys.length === 0) throw new Error("claims must not be empty");
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("numeric claims must be integers");
    if (typeof value !== "string" && typeof value !== "number") throw new Error("claims must be scalars");
  }
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = bytesToBase64Url(await hmac(payload, secret));
  return `${payload}.${signature}`;
}

/** The claims of a token this server signed, or null for anything else. Never throws on bad input. */
export async function verifyToken(token: string, secret: string): Promise<TokenClaims | null> {
  // Loud on a missing binding: a caller must decide the user-visible failure itself, which is why
  // readSession / verifyCsrfToken / verifyLoginState check `hasUsableSecret` first and answer
  // "missing" instead of letting this escape to the route.
  if (!hasUsableSecret(secret)) throw new Error("a signing secret binding is required");
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
  const [payload, signature] = [parts[0] as string, parts[1] as string];
  if (payload.length === 0 || signature.length === 0) return null;

  const expected = await hmac(payload, secret);
  const provided = base64UrlToBytes(signature);
  if (provided === null || provided.length !== expected.length || !safeEqualBytes(provided, expected)) return null;

  const raw = base64UrlToBytes(payload);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const claims: TokenClaims = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
    if (typeof value !== "string" && typeof value !== "number") return null;
    claims[key] = value as ClaimValue;
  }
  if (Object.keys(claims).length === 0) return null;
  return claims;
}

/** Constant-time comparison, so a probe cannot binary-search a signature byte by byte. */
export function safeEqualStrings(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  return safeEqualBytes(left, right);
}

function safeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] as number) ^ (b[index] as number);
  return diff === 0;
}
