# T-116 Provider and clearance configuration

Lane: 2 (shared path) · Week: 3 · Protected: yes (`supabase/migrations/`, `src/platform/gateway/` chain and clearance) · Depends on: T-003, T-115 (must be merged before claiming)
Status: in progress (wyuinline) — [#143](https://github.com/TerraOI/TerraOI/pull/143) merged at `10a3499` with Round-4 CHANGES_REQUESTED still open, so the merged migration stays untouched (AGENTS.md §6). Follow-up migration `20261118214900_provider_configuration_round4.sql` applies B7 (deferred one-revision constraint + BEFORE bump on ceiling/enabled), B8 (drop member SELECT grant and policy), B9 (JWT seed-user negatives in `046`), N6 (drop unused `tenant_provider_policy_v1()`), N8 (`route_position` column comment). Evidence owed: CI `database` (`046` `plan(75)`) and `supabase db lint` — no Docker locally (FAQ-0009). Typed-repository half still waits on T-004 §20.8.
Plan refs: §6.1, §12.4, §20.3 week 3, F37, F38; decision [#45](https://github.com/TerraOI/TerraOI/issues/45)

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Server path** ([#134](https://github.com/TerraOI/TerraOI/issues/134)): the gateway reads provider configuration through `security definer` read functions (pinned `search_path`) in a **non-exposed** schema, executed by its own `NOLOGIN` role `toi_gateway_config` over a `CONFIG_DB` Hyperdrive binding, with **no table grants**. T-314's health writes go through one named function on the same role. One role per server path, never shared with `toi_job_api`. The human steps are in T-004.
- **Function privileges** ([#142](https://github.com/TerraOI/TerraOI/issues/142), FAQ-0010): any function this packet leaves in `public` (the trigger functions) is revoked from `public, anon, authenticated` by full signature in the creating transaction; a request-role grant is added to `001`'s allow-list in the same PR.

- **Production gateway bundle** ([#178 ruling](https://github.com/TerraOI/TerraOI/pull/178#issuecomment-6985784215), [#199](https://github.com/TerraOI/TerraOI/issues/199), 2026-11-18): this packet also owns the one production builder of `GatewayDeps` (`call.ts`), which no packet owned. It lives in `src/platform/gateway/` (the only place the provider factories may be named, per `provider-boundary.test.ts`) and assembles the parsed configuration from this packet's repository, the provider adapters from Worker bindings, the health reader/writer over `provider_health`, and the meter. Consumers (T-104's `chatGatewayBundle()` today) receive it through injection and never build one. If any part is missing or fails to load (binding absent, configuration malformed, read error), the builder returns no bundle and the caller answers `unavailable`, never a default chain (AGENTS.md §4.3). The Owns and Acceptance entries below carry it.

## Goal
The model-chain configuration that the gateway receives today as reviewed, injected configuration (`parseGatewayConfiguration`) can be loaded from Postgres: `model_providers`, `provider_routes`, `tenant_provider_policy` and `provider_health` (§6.1). The gateway's chain and clearance behaviour does not change. Only the source of its configuration does, behind the existing injection seam.

## Owns (may edit)
- One new migration in `supabase/migrations/` (timestamp later than every merged one) and its pgTAP file in `supabase/tests/database/`
- A typed repository in `src/platform/gateway/` that produces the same parsed configuration type the gateway already consumes
- The production `GatewayDeps` builder in `src/platform/gateway/` and its test (#178 ruling)
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
- [ ] positive: in a configured environment the builder yields a `GatewayDeps` the existing gateway tests accept
- [ ] failure: a missing binding, a malformed configuration or a failed read each make the builder yield no bundle, and the consumer answers `unavailable`

## Done evidence
CI `database` job output (assertion count), `pnpm verify` output, `supabase db lint --level error`.

## Out of scope
- Admin approval UI (T-202, T-313)
- Health probing and circuit breakers (T-314)
- Billing reconciliation
