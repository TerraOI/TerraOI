# Tenancy and request context

Schemas: [`tenant-context.ts`](../../src/contracts/tenant-context.ts),
[`keys.ts`](../../src/contracts/keys.ts) · Plan §4.1–§4.3, §6.2 · Functions F01–F05, F28

## Who builds a `TenantContext`

Only the request pipeline, in this order, on **every** page, API, upload, download and action
request:

1. `resolveTenantHost` (F01) normalizes the externally routed hostname and looks it up
   exactly in `tenant_domains`. Unknown, suspended, reserved or malformed hosts get a generic
   failure — never a fallback tenant.
   The hostname comes from **the URL the edge delivered the request to** (`new URL(request.url)`
   on Workers) and from no header at all: TerraOI has no origin behind Cloudflare, so
   `X-Forwarded-Host` and `Host` are client-supplied, and `CF-Connecting-IP` is on every Worker
   request and proves nothing about them. This is what F02's cross-host replay has to fail
   (plan §4.1 steps 1 and 5, [PR #18](https://github.com/TerraOI/TerraOI/pull/18)). A development
   host for `next dev` is an explicit adapter parameter, never a header or a fallback.
   The two surfaces get that URL differently ([ADR-0006](../decisions/0006-page-host-via-proxy-header.md),
   [#55](https://github.com/TerraOI/TerraOI/issues/55)):
   - **Route handlers** read `requestHost(request)`, from `request.url`, and never a header.
   - **Pages** cannot see the request URL. `src/proxy.ts` deletes any inbound
     `x-toi-routed-host` and sets it fresh from `new URL(request.url).host` on every request;
     pages read it only through `resolvePageTenantContext` in [`page-host.ts`](../../src/platform/tenancy/page-host.ts), which re-enters the same `requestHost` → `parseHost` path route handlers use, refuses a value that is not a bare host, and fails closed (`missing_host`) when it is missing — never a default tenant. No page
     reads `Host` or `X-Forwarded-Host`, and a route handler reading the proxy header is a review blocker: the two trusted sources stay bound to their own surfaces (ADR-0006). This holds once the OpenNext spike in ADR-0006 passes (code landed, staging proof owed);
     until then no page resolves a tenant host.
2. `authenticateTenantUser` (F02) requires a verified session **and** an active
   `organisation_memberships` row for that organization. Identity alone grants nothing.
3. Roles, permitted services and permitted projects are computed server-side from current
   database state, together with the `policyRevision` in force.
4. `createTenantContext` parses and deep-freezes the result. Handlers receive a value that
   cannot be re-pointed at another organization or widened to another project mid-request.

The schema is `.strict()`: an organization, tenant, user, role or host field arriving in a body
or query string is a parse error, not an ignored key. Inbound internal tenant headers are
stripped and re-derived (plan §4.1 step 5).

## What the host format rule does and does not prove

`NormalizedHost` rejects uppercase, scheme, port, path and more than one subdomain level below
the zone (`company1.terraoi.app` ✓, `deep.sub.company1.terraoi.app` ✗). That is format hygiene
only. **Recognized** tenants come from the domain registry (F01), and a custom customer hostname
would need one more label — so custom domains are a separate, ADR'd feature (plan §5.1).

## Database scope and the RLS predicate (F03)

Every tenant operation runs through a security-invoker RPC that, **in one transaction**:
establishes a transaction-local organization, verifies `auth.uid()` membership, then executes
bounded SQL. Consequences later tables must keep:

- The effective read predicate is *active organization ∧ active membership ∧ request
  organization matches ∧ area/level ∧ source/project audience ∧ permitted service ∧ published
  version/effective date* (plan §6.2).
- A scope set in one RPC never carries into the next: no session-level `SET`, no pooled
  connection state, no process-global variable.
- `SECURITY DEFINER` helpers pin `search_path` (enforced by
  [`000_guardrails.test.sql`](../../supabase/tests/database/000_guardrails.test.sql)).
- Every tenant table has composite `(organisation_id, id)` foreign keys and RLS with negative
  tests for another tenant, another project and a deactivated member.

## Lifecycle

`organisations.status` moves `provisioning → active → suspended → archived/deleting`; a
suspended tenant produces no `TenantContext` at all (F28), so sessions, reads, model calls and
signed-object access stop together rather than being checked surface by surface.
