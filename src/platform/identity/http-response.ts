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
  const headers = new Headers({ location: `https://${host}${path}`, ...NO_STORE });
  for (const cookie of cookies) {
    headers.append("set-cookie", serializeSetCookie(cookie));
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
