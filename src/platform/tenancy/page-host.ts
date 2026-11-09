import type { HostAdapterOptions } from "./host";
import { resolveTenantContext, type TenancyStore, type TenantResolution } from "./resolve-tenant-context";

/**
 * ADR-0006 rule 2: the one page-side host source.
 *
 * App Router pages have no `request.url`, so `src/proxy.ts` puts the routed host on the request as
 * `x-toi-routed-host` — deleting any inbound copy first, so a client can never supply it. Pages read
 * it *only* through this module and pass it to `resolveTenantContext()`. A page with no proxy header
 * fails closed with the generic failure: there is no default tenant and no `Host` fallback.
 *
 * Route handlers do not use this. They keep `requestHost(request)` from `request.url` (ADR-0006
 * rule 3); a handler reading this header would be a review blocker.
 */
export const ROUTED_HOST_HEADER = "x-toi-routed-host";

/**
 * A bare host, optionally with a port — the same guard `src/platform/site/platform-host.ts:16`
 * applies to the platform surface. Anything with a path, query, userinfo, space or tab is refused
 * *before* the URL parser, which would otherwise repair `company1.terraoi.app/x` or
 * `u@company1.terraoi.app` into a usable host and turn a malformed header into a tenant lookup.
 */
const BARE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/**
 * The raw proxy-set value, or null when the proxy did not run. No validation here, and deliberately
 * no fallback to `Host` or `X-Forwarded-Host` (both client-supplied on Workers, plan §4.1 step 1);
 * `resolvePageTenantContext` is where the value is validated.
 */
export function pageRoutedHost(headers: Headers): string | null {
  return headers.get(ROUTED_HOST_HEADER);
}

export interface ResolvePageTenantContextInput {
  /** The page's own `headers()` result. Only `x-toi-routed-host` is read out of it. */
  headers: Headers;
  /** The verified session user, from the session adapter — never from a header or cookie value. */
  userId: string | null;
  store: TenancyStore;
  /** Development-only, environment-bound host for `next dev` (plan §4.1 step 1). */
  hostOptions?: HostAdapterOptions;
}

/**
 * Same order, same reasons, same failure codes as `resolveTenantContext` — this function adds no
 * tenancy rule of its own. It rebuilds a URL from the proxy-set host so that the single validation
 * path (`requestHost` → `parseHost` → `NormalizedHost` → host class) is shared with route handlers
 * instead of being re-implemented for pages (plan §4.1 step 6: one host resolver for every surface).
 */
export async function resolvePageTenantContext(
  input: ResolvePageTenantContextInput,
): Promise<TenantResolution> {
  const routedHost = pageRoutedHost(input.headers);
  if (routedHost !== null && !BARE_HOST.test(routedHost)) return { ok: false, reason: "malformed_host" };

  // The `invalid:` placeholder is the merged idiom — `platformHostFromHeaders` builds the same
  // placeholder URL in src/platform/site/platform-host.ts. It keeps `requestHost` as the single
  // decision point, so a missing header fails closed in production while an explicit,
  // environment-bound `developmentHost` still works under `next dev` — `requestHost` ignores that
  // parameter everywhere else (host.ts:102-103).
  const url = routedHost === null ? "invalid:" : `https://${routedHost}/`;

  return resolveTenantContext({
    // Scheme and path are inert here: `requestHost` reads only the host and refuses an explicit
    // port, and `parseHost` refuses anything that is not a normalized tenant host.
    request: { url },
    hostOptions: input.hostOptions,
    userId: input.userId,
    store: input.store,
  });
}
