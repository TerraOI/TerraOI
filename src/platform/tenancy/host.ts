import { NormalizedHost } from "@/contracts/keys";

/**
 * F01, first half: turn what the edge sent us into a host we are willing to look up.
 *
 * Nothing here repairs a host into a tenant: case, port, path, extra labels, preview aliases and
 * IP literals are rejected so the caller can render a generic failure (plan §4.1 step 1, 3).
 * Recognition of a *known* tenant still comes from the domain registry (`findHost`).
 */
export type HostClass = "tenant" | "platform" | "admin";

export type HostRejectReason =
  | "missing_host"
  | "malformed_host"
  | "too_many_labels"
  | "preview_alias"
  | "ip_literal";

export type HostParse =
  | { ok: true; host: string; class: HostClass }
  | { ok: false; reason: HostRejectReason };

/** TerraOI's own surfaces: never a fallback tenant (plan §3.2). */
const PLATFORM_HOSTS = new Set(["terraoi.app", "www.terraoi.app"]);
const ADMIN_HOSTS = new Set(["admin.terraoi.app"]);

/** Deployment aliases must not become a way around the host check (plan §4.1). */
const PREVIEW_SUFFIXES = [".workers.dev"];

const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function parseHost(rawHost: string | null | undefined): HostParse {
  if (rawHost === null || rawHost === undefined || rawHost.length === 0) {
    return { ok: false, reason: "missing_host" };
  }
  if (rawHost !== rawHost.trim() || rawHost.includes(" ")) {
    return { ok: false, reason: "malformed_host" };
  }
  if (IP_LITERAL.test(rawHost)) return { ok: false, reason: "ip_literal" };
  if (PREVIEW_SUFFIXES.some((suffix) => rawHost.endsWith(suffix))) {
    return { ok: false, reason: "preview_alias" };
  }
  if (rawHost.split(".").length > 3) return { ok: false, reason: "too_many_labels" };
  if (!NormalizedHost.safeParse(rawHost).success) return { ok: false, reason: "malformed_host" };

  const hostClass: HostClass = PLATFORM_HOSTS.has(rawHost)
    ? "platform"
    : ADMIN_HOSTS.has(rawHost)
      ? "admin"
      : "tenant";
  return { ok: true, host: rawHost, class: hostClass };
}

/**
 * The externally routed host. Cloudflare overwrites `X-Forwarded-Host` for routed requests and
 * adds `CF-Connecting-IP`; a request that reaches an origin directly cannot be trusted to name
 * its own host, so a spoofed `X-Forwarded-Host` is ignored, as is a multi-hop list we cannot
 * attribute to one edge (plan §4.1 step 5: strip and re-derive tenant headers).
 */
export function requestHost(headers: Headers): string | null {
  const cameThroughEdge = headers.has("cf-connecting-ip");
  const forwarded = headers.get("x-forwarded-host");
  if (cameThroughEdge && forwarded !== null && !forwarded.includes(",")) {
    return forwarded;
  }
  return headers.get("host");
}
