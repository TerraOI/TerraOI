import { NextResponse, type NextRequest } from "next/server";

import { ROUTED_HOST_HEADER } from "@/platform/tenancy/page-host";

/**
 * ADR-0006 rule 1: the proxy (`middleware.ts`'s Next 16 name) is the only writer of
 * `x-toi-routed-host`.
 *
 * On Workers there is no origin behind Cloudflare, so `Host` and `X-Forwarded-Host` arrive exactly
 * as the client sent them and prove nothing about the address the request was routed to (plan §4.1
 * step 1). A server component cannot see `request.url`, so the proxy — which can — stamps the host
 * the edge delivered the request to onto the request that continues into the app. Pages read it only
 * through `src/platform/tenancy/page-host.ts`; route handlers keep `requestHost(request)` from
 * `request.url` and never read this header (ADR-0006 rule 3).
 *
 * The delete-then-set order is the security property: an inbound value — forged, replayed, or left
 * over from another proxy chain — is removed before the fresh one is written, so the header can
 * carry exactly one value and it is always ours.
 */
export function routedHostHeaders(inbound: Headers, url: string): Headers {
  const headers = new Headers(inbound);
  headers.delete(ROUTED_HOST_HEADER);
  let routedHost: string | null = null;
  try {
    routedHost = new URL(url).host;
  } catch {
    // Fail closed: no header means the page gets the generic failure, never a guessed tenant. The
    // proxy never turns a malformed URL into a 500 for every route.
  }
  if (routedHost !== null) headers.set(ROUTED_HOST_HEADER, routedHost);
  return headers;
}

/**
 * No `matcher`: the default already runs the proxy on every application route, and naming one
 * matcher risks narrowing it. Next's own static assets (`_next/static`, `_next/image`, files in
 * `public/`) are not pages and never resolve a tenant, so they do not need the header.
 *
 * There is deliberately no `config.runtime`. Next 16.4.5 rejects an Edge proxy at build time —
 * `pnpm cf:build` fails with "Proxy does not support Edge runtime" — so this file compiles to the
 * Node.js middleware, and `@opennextjs/cloudflare` 1.20 labels that path
 * "Node.js middleware support is experimental in cloudflare, and not officially maintained by
 * OpenNext maintainers". That is the load-bearing uncertainty ADR-0006's spike exists to settle;
 * the PR body records what each local run showed.
 */
export default function proxy(request: NextRequest): NextResponse {
  return NextResponse.next({ request: { headers: routedHostHeaders(request.headers, request.url) } });
}
