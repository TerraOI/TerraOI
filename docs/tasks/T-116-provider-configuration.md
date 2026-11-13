# T-116 Provider and clearance configuration

Lane: 2 (shared path) · Week: 3 · Protected: yes (`supabase/migrations/`, `src/platform/gateway/` chain and clearance) · Depends on: T-003, T-115 (must be merged before claiming)
Status: in progress (wyuinline) — the configuration half is open as a PR at round 3 of [#143](https://github.com/TerraOI/TerraOI/pull/143): one migration (`20261113074600_provider_configuration.sql`, re-timestamped for the N5 rebase) creating `model_providers`, `provider_routes`, `tenant_provider_policy` and `provider_health` with the narrow-only and one-matrix-revision guards, pgTAP slot `046` (row in COORDINATION §6b), and every new function revoked from `public, anon, authenticated` by full signature per #60/FAQ-0010. **No request-role function grant in this PR**: after round 3's B5, `tenant_provider_policy_v1()` is closed to `anon` and `authenticated` as well — it reads `current_organisation_id()` but never sets the scope, which FAQ-0011 puts inside the calling RPC's own transaction, so a granted read answers a tenant zero rows and clears more than that tenant recorded (§4.3). The consumer named here is the gateway's tenant-policy read on the server path (#134), not the Data API; an admin read (T-202) would be a new FAQ-0011-shaped RPC in its own migration plus its own `001` entry. Evidence owed: the CI `database` job (pgTAP `046`, `plan(73)`) and `supabase db lint` — `pnpm db:test` needs Docker, which no builder has (FAQ-0009). The **typed repository** half is now ruled by #134 (Server path above): `security definer` read functions in a non-exposed schema, executed by `NOLOGIN` role `toi_gateway_config` over `CONFIG_DB`, no table grants. That half is writable in SQL and TypeScript today; what no builder can do is give it a live binding — the login user, its password, the Hyperdrive config and the `wrangler.jsonc` binding are T-004 §20.8 human steps. `provider_health` is written by T-314 through one named function on the same role, not here.
Plan refs: §6.1, §12.4, §20.3 week 3, F37, F38; decision [#45](https://github.com/TerraOI/TerraOI/issues/45)

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Server path** ([#134](https://github.com/TerraOI/TerraOI/issues/134)): the gateway reads provider configuration through `security definer` read functions (pinned `search_path`) in a **non-exposed** schema, executed by its own `NOLOGIN` role `toi_gateway_config` over a `CONFIG_DB` Hyperdrive binding, with **no table grants**. T-314's health writes go through one named function on the same role. One role per server path, never shared with `toi_job_api`. The human steps are in T-004.
- **Function privileges** ([#142](https://github.com/TerraOI/TerraOI/issues/142), FAQ-0010): any function this packet leaves in `public` (the trigger functions) is revoked from `public, anon, authenticated` by full signature in the creating transaction; a request-role grant is added to `001`'s allow-list in the same PR.

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
