# T-304 Kill-switch settings and the tenant provisioning script (F05)

Lane: 1 · Week: 3 · Protected: yes (`supabase/migrations/`, `src/platform/tenancy/`, `scripts/` is shared) · Depends on: T-003, T-101 (both merged), T-102 (a–d open as #30/#50/#52/#57; only e's test-only pgTAP #59 is merged), T-115 (a merged as #31; b/c/d open as #53/#56/#58, for the provider switch), T-311 (same week, for the expert switch) · Status: ready
Gated by decisions: [#45](https://github.com/TerraOI/TerraOI/issues/45) (provider configuration), [#62](https://github.com/TerraOI/TerraOI/issues/62) (no packet owns tenant brand configuration), [#67](https://github.com/TerraOI/TerraOI/issues/67) (`organisations.locale` rejects `en-GB`)
Plan refs: §17.1 (kill switches as settings), §15.0 ("Tenant provisioning by script (F05), not an admin UI"; "Kill switches (tenant, expert, provider) as settings"), §15.2 (M1-PILOT: kill switches verified), §16 (Operations row), §13 (control-plane boundary), §4.1/§4.2; F05, F28 (and F06 for the expert switch)

## Goal
Two operations surfaces, both as settings rather than UI: a **script** that provisions a tenant —
organization row, exact hosts, default roles and entitlements — resumably and with reserved slugs
refused, granting the platform admin no operational access; and **kill switches** for platform, tenant,
expert and provider that stop new sessions, runs and model calls immediately without touching the
deterministic record system. §15.2 makes "kill switches verified" an M1-PILOT gate item, so the evidence
is a staging drill, not a unit test alone.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_lifecycle_switches.sql`: the switch settings table
  (platform/tenant/expert/provider rows with an actor and reason), the provisioning RPC
  (`provision_tenant_v1`) and the suspend/resume RPCs — timestamp agreed in the daily sync; merged
  migrations are never edited
- `src/platform/tenancy/` (lifecycle calls: provision, suspend, resume; the switch read used by the
  request pipeline), `scripts/provision-tenant.mjs` (the script; `scripts/` is shared —
  [scripts/README.md](../../scripts/README.md))
- `supabase/tests/database/100_lifecycle_switches.test.sql`, `src/platform/tenancy/*.test.ts`,
  `scripts/provision-tenant.test.mjs`

## Must not edit
`supabase/migrations/20261105060000_tenancy_core.sql` and every other merged migration; `src/contracts/`;
`src/platform/gateway/` (the provider switch is read by Lane 2's chain selection — ask through
[COORDINATION.md §2](../../docs/COORDINATION.md)); `workers/` and `localbox/`; `.github/`; no production
credential and no secret in the script or its logs (AGENTS.md §4.6, §6).

## Contract
F05 `provisionTenant`: authorized control-plane action → org/domain/defaults/entitlements, with
§11's acceptance behavior — resumable, reserved slug rejected, **no operational access granted to a
platform admin**. The merged tenancy schema already gives the pieces: `organisations.status`
(`provisioning | active | suspended | archived | deleting`), `tenant_domains.status`
(`active | reserved | suspended`) and `slug`/`host` checks in
[`20261105060000_tenancy_core.sql`](../../supabase/migrations/20261105060000_tenancy_core.sql), and
`resolve_tenant_host` serves only an `active` domain whose organization is `provisioning` or `active`
(`:234-248`) — so a `reserved` host row resolves nothing and a `suspended` tenant produces no
`TenantContext` at all (F28, [docs/contracts/tenancy-and-context.md](../../docs/contracts/tenancy-and-context.md)
"Lifecycle"). A tenant sitting in `provisioning` resolves but has no members, so nothing is served.
F28 is the kill switch's contract, not a new mechanism.
**Decision owed (#45):** plan §6.1's `model_providers` / `provider_routes` / `tenant_provider_policy` /
`provider_health` tables have no owning packet, so a **provider** switch has nothing to name until the
supervisor schedules that configuration (this packet assumes a switch row keyed by `providerKey` and no
registry). The **expert** switch assumes [T-311](./T-311-expert-definitions.md)'s `tenant_experts`;
if that has not merged, this packet lands tenant, platform and provider switches only and says so.
**Two more that provisioning runs straight into:** provisioning seeds a tenant's brand defaults, but
[#62](https://github.com/TerraOI/TerraOI/issues/62) records that no packet owns `tenant_brands` (plan
§6.1 names it; `git grep -i brand -- supabase` is empty), so this packet seeds the organization row and
nothing brand-shaped, and does not invent a brand table. And `organisations.locale` carries the CHECK
`^[a-z]{2}(-[A-Z][a-z]{2})?$`
([`20261105060000_tenancy_core.sql:25`](../../supabase/migrations/20261105060000_tenancy_core.sql)),
which [#67](https://github.com/TerraOI/TerraOI/issues/67) reports as rejecting `en-GB` while accepting
`en-Gbr`: the script passes a locale the current CHECK accepts (plain `en`) and never works around the
constraint.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/100_lifecycle_switches.test.sql` — one provisioning call creates
      the organization, its `company1`/`company1-staging` domain rows, the default roles and its service
      entitlements, and leaves status `provisioning` until the run completes
- [ ] positive: re-running the script for the same slug **resumes** the same organization — no duplicate
      rows, no second domain set; the switch table records the actor and reason for every flip
- [ ] negative: a reserved slug (`admin`, `www`, `terraoi`) and a host already registered to another
      organization are refused; provisioning a tenant as a platform admin creates **no**
      `organisation_memberships` row, so that admin gets no tenant context and reads no tenant data
- [ ] negative: same file — another tenant sees no switch or lifecycle row, a `suspended` membership
      cannot flip anything, and a tenant admin cannot flip a **platform** or provider switch
- [ ] negative: with the tenant switch off, `resolve_tenant_host` returns nothing, `set_tenant_scope`
      grants nothing, uploads and citation downloads refuse, and no new run starts — while existing rows
      stay intact (the deterministic record system is not disabled, §17.1)
- [ ] negative: with a provider switched off, that provider is absent from the eligible chain for
      **every** tenant (asserted through T-115's route selection, not through a page), and with an expert
      switched off it is not selectable and its runs are refused
- [ ] failure: the script interrupted mid-run leaves `provisioning` and is resumable — never an `active`
      tenant with a domain but no roles; a resume after a partial run does not double-create entitlements
- [ ] failure: a switch flipped while a run is in flight is re-checked before delivery
      (`persistFinalAndAuditBeforeDelivery`, plan §9.4) and the answer is withheld; the incident note
      records that already-sent provider data is not erased by cancelling new calls (§17.1)

## Done evidence
`pnpm verify`; `pnpm db:test` (CI `database` job on a machine without Docker); staging drill: provision a
third synthetic tenant by script, suspend `company1-staging` and show sign-in, upload, chat and citation
all refuse within one request, resume it, then flip the provider switch and show the chain skipping that
provider in the run audit. Secrets live in `wrangler secret` / the Supabase dashboard and the DNS and
project creation stay human steps (plan §20.8).

## Out of scope
The control-plane UI at `admin.terraoi.app` (plan §15.0 deferred after M1), connector kill switches (no
connectors in M1), restore/rehearsal and rollback artifacts (T-404), dashboards and alert thresholds
(T-405), budget ceilings as settings (T-313), and any provider registry migration (#45 decides that).
