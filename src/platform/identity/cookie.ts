/**
 * Set-Cookie construction for the tenant surfaces (plan §4.2, AGENTS.md §4.1).
 *
 * `CookieSpec` has **no `domain` field**: a host-only cookie is the invariant, not a setting, so a
 * caller cannot ask for `Domain=.terraoi.app` and silently give every sibling tenant each other's
 * sessions. The `__Host-` prefix is used wherever the browser can honor it, and the serializer
 * refuses to emit a prefixed name that would be silently downgraded.
 */

export type CookieSpec = {
  name: string;
  /** Opaque token only. Never an email, an id that means something on its own, or free text. */
  value: string;
  /** Seconds. 0 clears the cookie; a negative or fractional value is refused. */
  maxAge: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax" | "Strict" | "None";
  /** Only ever `/`; a path-scoped cookie cannot carry the `__Host-` prefix. */
  path?: string;
};

const NAME_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const VALUE_SHAPE = /^[A-Za-z0-9_.-]{0,1024}$/;
const HOST_PREFIX = "__Host-";

export function serializeSetCookie(spec: CookieSpec): string {
  if (typeof spec.name !== "string" || !NAME_SHAPE.test(spec.name)) {
    throw new Error("cookie name must be a short token character sequence");
  }
  if (typeof spec.value !== "string" || !VALUE_SHAPE.test(spec.value)) {
    throw new Error("cookie value must be an opaque token (no separators, spaces or non-ASCII)");
  }
  if (spec.value.length === 0 && spec.maxAge !== 0) {
    throw new Error("only a cleared cookie may carry an empty value");
  }
  if (!Number.isInteger(spec.maxAge) || spec.maxAge < 0) {
    throw new Error("cookie Max-Age must be a non-negative integer number of seconds");
  }
  if (spec.sameSite === "None") {
    throw new Error("SameSite=None is not used for tenant cookies and would require Secure");
  }
  const path = spec.path ?? "/";
  if (spec.name.startsWith(HOST_PREFIX)) {
    if (!spec.secure) throw new Error(`a ${HOST_PREFIX} cookie requires Secure`);
    if (path !== "/") throw new Error(`a ${HOST_PREFIX} cookie requires Path=/`);
  }
  if (path !== "/" && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(path)) {
    throw new Error("cookie Path must be a single absolute path");
  }

  const parts = [`${spec.name}=${spec.value}`, `Path=${path}`, `Max-Age=${spec.maxAge}`];
  if (spec.httpOnly) parts.push("HttpOnly");
  if (spec.secure) parts.push("Secure");
  parts.push(`SameSite=${spec.sameSite}`);
  // No Domain= attribute, ever: the cookie belongs to exactly the host the browser was routed to.
  return parts.join("; ");
}

/** Reads a browser `Cookie:` header. A repeated name keeps its first value, so one cannot shadow another. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (typeof header !== "string" || header.length === 0) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!NAME_SHAPE.test(name)) continue;
    if (!(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

/**
 * The `__Host-` prefix requires a secure transport and cannot be used on a plain-HTTP development
 * origin, so the adapter says whether this request arrived over https. Nothing may *choose* to drop
 * the prefix on an https request: `cookieName(base, isHttpsUrl(request.url))` is the only call form.
 */
export function cookieName(base: string, secureTransport: boolean): string {
  return secureTransport ? `${HOST_PREFIX}${base}` : base;
}

export function clearedCookie(base: string, secureTransport: boolean): CookieSpec {
  return {
    name: cookieName(base, secureTransport),
    value: "",
    maxAge: 0,
    secure: secureTransport,
    httpOnly: true,
    sameSite: "Lax",
  };
}

/** The routed URL the edge delivered, and nothing else (plan §4.1 step 1). */
export function isHttpsUrl(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).protocol === "https:";
  } catch {
    return false;
  }
}
