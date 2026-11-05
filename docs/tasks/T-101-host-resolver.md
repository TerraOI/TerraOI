# T-101 Exact-host tenant resolver and TenantContext per request

Lane: 1 · Week: 1 · Protected: yes (`src/platform/tenancy/`) · Depends on: T-000, T-002, T-003 · Status: in progress (wyuinline)
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
- [ ] `src/platform/tenancy/host-resolver.test.ts`: `company1.terraoi.app` → company1 id; `www.terraoi.app`
      and `admin.terraoi.app` classified as reserved, not tenant
- [ ] negative: unknown host, `company1.terraoi.app:8443`, `Company1.terraoi.app`,
      `deep.sub.company1.terraoi.app`, `workers.dev` preview alias, `127.0.0.1` → generic failure, zero tenant detail
- [ ] negative: a `X-Forwarded-Host` / `Host` spoof cannot change the resolved organization;
      the context is built from the externally routed host only
- [ ] negative: suspended tenant (status `suspended`, or domain status not `active`) → no context, no branding
- [ ] negative: a body/query/cookie `organisationId` is ignored and rejected at the contract boundary
- [ ] failure: two concurrent requests for two different tenants from the same user keep separate
      contexts (no module-level or process-global state)

## Done evidence
`pnpm verify`; staging: `curl -H "Host: company1.terraoi.app" https://<staging>/api/tenant-debug`
returns the org id for company1 and a generic error for a look-alike host (a temporary debug route
is removed before merge or gated to staging).

## Out of scope
Sign-in and membership UI (T-102); custom customer domains; cookie domain changes; provisioning UI.
