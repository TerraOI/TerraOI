import type { CookieSpec } from "./cookie";
import { serializeSetCookie } from "./cookie";

/**
 * The response shape for the sign-in endpoints. Both are reached by a browser form post or a
 * provider redirect, so a result is a 303 to a page carrying one whitelisted outcome, never a body
 * of its own; the security rejections are bare statuses, because an explanation is only useful to
 * the attacker. Everything is `no-store` (plan §4.4: authenticated pages and auth flows default to
 * private/no-store), and every response goes through here so that cannot be forgotten per route.
 */

export const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * #37's hard condition, enforced here rather than hoped for: a Supabase access or refresh token is a
 * JWT — `eyJ…`.`eyJ…`.`…` — and it must never reach the browser. A browser holding one could call
 * `register_source_version_v1` directly and skip the byte verification the Worker performs.
 *
 * This module is the only way the sign-in endpoints answer, so it refuses to emit one: the shape is
 * anchored on two `eyJ` segments (a JSON header and a JSON payload), which no artifact this app sends
 * can match — our session id has no dot at all, and the CSRF / login-state envelopes have exactly one.
 * The pattern is deliberately shape-based, not a literal, so it still catches a real token tomorrow.
 */
export const BROWSER_TOKEN_SHAPE = /^eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;
const TOKEN_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

export function containsTokenMaterial(text: string): boolean {
  return typeof text === "string" && TOKEN_IN_TEXT.test(text);
}

/** Every sign-in result lands back on the tenant's own login surface. */
export const LOGIN_PATH = "/login";

export function statusOnly(status: number): Response {
  return new Response(null, { status, headers: NO_STORE });
}

/**
 * 303 back to the tenant's own login surface. `path` is always one this server chose; nothing about
 * the request body or query can influence the target, which is what keeps the callback URL from
 * becoming an open redirect (plan §4.2 "do not use broad wildcard auth redirects").
 */
export function redirectSameHost(host: string, path: string, cookies: readonly CookieSpec[]): Response {
  if (containsTokenMaterial(path)) {
    // A redirect target this server chose cannot legitimately contain a JWT. Reaching this line means
    // someone routed token material into a URL, so the response is refused, not sent.
    throw new Error("a redirect target must not carry token material");
  }
  const headers = new Headers({ location: `https://${host}${path}`, ...NO_STORE });
  for (const cookie of cookies) {
    const serialized = serializeSetCookie(cookie);
    if (containsTokenMaterial(serialized)) {
      throw new Error("a Set-Cookie value must never be a Supabase access or refresh token (#37)");
    }
    headers.append("set-cookie", serialized);
  }
  return new Response(null, { status: 303, headers });
}

/** Reads at most `limit` bytes, returning null as soon as the body is larger than that. */
export async function readCappedBody(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
