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
 * What the deployment adapter hands us. TerraOI runs *on* Workers, so the request is already at
 * the edge: `request.url` is the absolute URL the matched route delivered, and `URL.host` is the
 * only host we are willing to look up. `headers` is carried because the adapter has it — tenancy
 * reads nothing out of it, which is why it is optional here.
 */
export interface TrustedRequest {
  url: string;
  headers?: Headers;
}

/**
 * Plan §4.1 step 1, "development exceptions are explicit and environment-bound": `next dev`
 * serves every tenant on `localhost`, which `parseHost` rejects, so a development-only adapter
 * passes the tenant host it is simulating. It is a parameter, never a header, cookie, query value
 * or env lookup inside this module — the caller that knows its environment supplies it, and the
 * Workers adapter must not supply it at all.
 */
export interface HostAdapterOptions {
  developmentHost?: string;
}

/**
 * F01, the host half. The tenant comes from the routed URL and from nothing else.
 *
 * `X-Forwarded-Host` and `Host` are client-supplied on this architecture: there is no origin
 * behind Cloudflare that could have rewritten them, and `CF-Connecting-IP` is present on every
 * Worker request, so its presence proves nothing. A browser pointed at `company1.terraoi.app`
 * that sends `X-Forwarded-Host: company2.terraoi.app` must still resolve company1 (F02, plan §4.1
 * steps 1 and 5). Those headers are not read here at all.
 */
export function requestHost(
  request: TrustedRequest,
  options: HostAdapterOptions = {},
): string | null {
  const developmentHost = options.developmentHost;
  if (developmentHost !== undefined && developmentHost.length > 0) return developmentHost;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  // The WHATWG parser lower-cases the host, which is the normalization plan §4.1 step 1 asks for.
  // An explicit port is still an unexpected port, so it is refused rather than silently dropped
  // (otherwise `:8443` would parse as the bare tenant host).
  if (url.port.length > 0) return null;
  return url.hostname;
}
