# T-116 Provider and clearance configuration

Lane: 2 (shared path) · Week: 3 · Protected: yes (`supabase/migrations/`, `src/platform/gateway/` chain and clearance) · Depends on: T-003, T-115 (must be merged before claiming)
Status: ready
Plan refs: §6.1, §12.4, §20.3 week 3, F37, F38; decision [#45](https://github.com/TerraOI/TerraOI/issues/45)

## Goal
The model-chain configuration that the gateway receives today as reviewed, injected configuration (`parseGatewayConfiguration`) can be loaded from Postgres: `model_providers`, `provider_routes`, `tenant_provider_policy` and `provider_health` (§6.1). The gateway's chain and clearance behaviour does not change. Only the source of its configuration does, behind the existing injection seam.

## Owns (may edit)
- One new migration in `supabase/migrations/` (timestamp later than every merged one) and its pgTAP file in `supabase/tests/database/`
- A typed repository in `src/platform/gateway/` that produces the same parsed configuration type the gateway already consumes
- `src/contracts/database.types.ts` only through `pnpm db:types`

## Must not edit
- The chain-walking and clearance logic in `src/platform/gateway/route.ts` and `call.ts`, except to accept the repository through the existing seam
- Admin UI (T-202, T-313)

## Contract
- `tenant_provider_policy` is tenant-scoped: RLS on, reads through a scoped RPC, organisation from `TenantContext` only (AGENTS.md §4.1, §4.2).
- `model_providers` and `provider_routes` are platform tables: no `anon`/`authenticated` write; reads by the gateway's server path only, documented with the privilege used.
- Per-function `revoke execute … from public, anon` for every new function (#60 precedent).
- `provider_health` is written by T-314's passive health checks. This packet owns the table, not the writer.

## Acceptance tests (write first)
- [ ] positive: a seeded configuration loads into the same parsed type, and the existing gateway tests pass against it unchanged
- [ ] negative: company2 cannot read company1's `tenant_provider_policy`; a deactivated member reads nothing
- [ ] negative: `authenticated` cannot insert or update any of the four tables; `has_function_privilege` is false for `anon` on every new function
- [ ] negative: a policy row permitting a data class the platform route does not clear is refused (the tenant can narrow, never widen, §12.4)
- [ ] failure: a malformed or missing configuration row makes the gateway fail closed (no provider selected), never fall back to a default chain

## Done evidence
CI `database` job output (assertion count), `pnpm verify` output, `supabase db lint --level error`.

## Out of scope
- Admin approval UI (T-202, T-313)
- Health probing and circuit breakers (T-314)
- Billing reconciliation
