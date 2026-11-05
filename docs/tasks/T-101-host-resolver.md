# T-101 Exact-host tenant resolver and TenantContext per request

Lane: 1 · Week: 1 · Protected: yes (`src/platform/tenancy/`) · Depends on: T-000, T-002, T-003 · Status: done — merged as [PR #18](https://github.com/TerraOI/TerraOI/pull/18); the staging check below is still open pending T-004
Plan refs: §4.1, §9.4; F01

## Goal
Every request on a tenant host resolves exactly one active tenant through `tenant_domains`,
produces a frozen `TenantContext`, and any unknown, malformed, reserved or suspended host gets a
generic failure with no tenant branding or data.

## Owns (may edit)
- `src/platform/tenancy/` (host resolver, context builder, middleware), `src/app/api/health/` untouched
- `src/platform/tenancy/*.test.ts`

## Must not edit
- `src/contracts/` (contract changes need an ADR), `supabase/migrations/` (T-003 owns the schema),
  `src/platform/identity/` (T-102), Lane 2 paths

## Contract
[`TenantContext`](../../src/contracts/tenant-context.ts) + `createTenantContext`,
[`NormalizedHost`](../../src/contracts/keys.ts), RPC `resolve_tenant_host(text)` and
`set_tenant_scope(uuid)` from the merged tenancy migration
`supabase/migrations/20261105060000_tenancy_core.sql` (lands with T-003). Rules and the
"who builds it" order are in [docs/contracts/tenancy-and-context.md](../../docs/contracts/tenancy-and-context.md).

## Acceptance tests (write first)
- [x] the order is fixed by plan §4.1 and must not drift: registry lookup (step 2) → unknown,
      malformed, reserved or suspended host gets the generic failure (step 3) → only then session
      and membership (step 4). A signed-out visitor on an unregistered or suspended host gets the
      generic unknown-address page, never a sign-in prompt (`#18` B1)
- [x] `src/platform/tenancy/host.test.ts`: `company1.terraoi.app` → company1 id; `www.terraoi.app`
      and `admin.terraoi.app` classified as reserved, not tenant
- [x] negative: unknown host, `company1.terraoi.app:8443`, `Company1.terraoi.app`,
      `deep.sub.company1.terraoi.app`, `workers.dev` preview alias, `127.0.0.1` → generic failure, zero tenant detail
- [x] negative: a `X-Forwarded-Host` / `Host` spoof cannot change the resolved organization;
      the context is built from the externally routed host only
- [x] negative: suspended tenant (status `suspended`, or domain status not `active`) → no context, no branding
- [x] negative: a body/query/cookie `organisationId` is ignored and rejected at the contract boundary
- [x] failure: two concurrent requests for two different tenants from the same user keep separate
      contexts (no module-level or process-global state)
- [x] development: the `developmentHost` adapter parameter is honored **only** in a development
      runtime (`NODE_ENV === "development"`), and ignored in production, test and an unset
      environment (`#18` N1)

Named test files as they shipped: `src/platform/tenancy/host.test.ts` and
`src/platform/tenancy/resolve-tenant-context.test.ts` — 24 tests between them.

## Done evidence
`pnpm verify`; staging: `curl -H "Host: company1.terraoi.app" https://<staging>/api/tenant-debug`
returns the org id for company1 and a generic error for a look-alike host (a temporary debug route
is removed before merge or gated to staging).

**Landed:** every item above is covered by a unit test; CI `verify`, `database`, `lanes`,
`migrations`, `provisional` and `secrets` green on the final commit `d048661`; supervisor
post-merge review accepted on #18. **Not done:** the staging `curl` check and the temporary debug
route — there is no staging project or secrets yet (T-004) and the Postgres-backed store arrives
with T-102. `/api/tenant-debug` was never added, so there is nothing to gate or remove.

## Out of scope
Sign-in and membership UI (T-102); custom customer domains; cookie domain changes; provisioning UI.
