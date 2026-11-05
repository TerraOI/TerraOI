import { parseHost, requestHost } from "@/platform/tenancy/host";

// Which requests the TerraOI site (landing page, privacy notice, pilot inquiry API) answers.
// The host rules are T-101's (`@/platform/tenancy/host`), so a later host fix reaches this module
// too; nothing here keeps its own host list or parser (builder review of #26, B3).

/** True only for terraoi.app and www.terraoi.app, as classified by `parseHost`. */
export function isPlatformHost(host: string | null): boolean {
  const parsed = parseHost(host);
  return parsed.ok && parsed.class === "platform";
}

// A bare host, optionally with a port. Anything else (a path, userinfo, spaces) is refused before
// it reaches the URL parser, which would otherwise read `terraoi.app/x` or `u@terraoi.app` as
// `terraoi.app`.
const BARE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/**
 * For pages, which have no `request.url`: rebuild the routed URL from `Host`. On Workers the
 * request URL is itself built from `Host`, so this is the value `requestHost` would check for an
 * API route. `X-Forwarded-Host` is never read.
 *
 * Under `next dev` (and only there; `requestHost` enforces it) localhost is served as
 * `TERRAOI_DEV_HOST`, default terraoi.app.
 */
export function platformHostFromHeaders(headers: Headers): string | null {
  const raw = headers.get("host");
  const url = raw !== null && BARE_HOST.test(raw) ? `https://${raw}/` : "invalid:";
  const host = requestHost({ url }, { developmentHost: process.env.TERRAOI_DEV_HOST || "terraoi.app" });
  return isPlatformHost(host) ? host : null;
}
