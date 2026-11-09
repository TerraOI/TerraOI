# ADR-0006 Pages read the tenant host from a proxy-set header; route handlers keep `request.url`

Status: **accepted, conditional on the OpenNext spike below** · Date: 2026-11-08 · Deciders: supervisor ([#55](https://github.com/TerraOI/TerraOI/issues/55))
Plan refs: §4.1 steps 1, 5 and 6; F01, F02

## Context

[`tenancy-and-context.md`](../contracts/tenancy-and-context.md) said the tenant hostname comes from `new URL(request.url)` and from no header at all. Route handlers can do that, because they receive the `Request`. App Router **pages** cannot: a server component sees only `headers()`, and `Host` / `X-Forwarded-Host` are client-supplied on Workers, so the tenant login page (T-102/T-131) had no trusted way to learn its host. #55 asked how pages get it.

## Decision

Option 2 of #55, scoped as plan §4.1 step 5 already describes it ("route handlers independently establish context rather than trusting a client-supplied header or only the page proxy"):

1. **`src/proxy.ts`** (Next 16's name for middleware) matches every route. It reads `new URL(request.url).host`, **deletes any inbound `x-toi-routed-host`**, and sets that header fresh. A client can never supply the value, because the proxy overwrites it on every request.
2. **Pages** get the host only through one helper in `src/platform/tenancy/` that reads that header and passes it to `resolveTenantContext()`. No page reads `Host` or `X-Forwarded-Host`. A page with no proxy header fails closed with the generic failure, never a default tenant.
3. **Route handlers** keep using `requestHost(request)` from `request.url` and never read the proxy header.
4. **`platformHostFromHeaders`** (`src/platform/site/platform-host.ts`) stays as merged for platform/public surfaces; its comment points at this ADR.

**Condition.** Before the tenant login page builds on this, a staging spike must show that `@opennextjs/cloudflare` 1.20 runs `proxy.ts` on Workers and that a forged inbound `x-toi-routed-host` is overwritten. If it does not, fall back to #55 option 1 (a route handler renders the tenant login), and report on #55.

## Consequences

- The contract text changes in the same PR as this ADR (`docs/contracts/tenancy-and-context.md`, step 1).
- The implementing PR (protected) adds `src/proxy.ts`, the page helper, a `check:structure` allowance for `src/proxy.ts`, and these tests: a forged inbound header is replaced; a page with no proxy header fails closed; company1 and company2 hosts resolve to different contexts.
- Two trusted host sources now exist, each bound to one surface. Mixing them (a handler reading the header, a page reading `Host`) is a review blocker.

## Alternatives considered

- **Option 1, render tenant login from a route handler.** Keeps one host source but gives up server components for the login page. It remains the fallback.
- **Trust `Host` on pages.** Rejected: client-supplied on Workers, and exactly what F02's cross-host replay has to fail.
