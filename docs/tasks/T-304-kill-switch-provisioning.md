# T-304 Kill-switch settings and the tenant provisioning script (F05)

Lane: 1 · Week: 3 · Protected: yes (`supabase/migrations/`, `src/platform/tenancy/`; `scripts/` is shared) · Depends on: T-003, T-101 (both merged), T-102 (a–d open as #30/#50/#52/#57; only e's test-only pgTAP #59 is merged), T-115 (a merged as #31; b/c/d open as #53/#56/#58, for the provider switch), T-311 (same week, for the expert switch) · Status: ready
Gated by decisions: [#45](https://github.com/TerraOI/TerraOI/issues/45), [#62](https://github.com/TerraOI/TerraOI/issues/62) (no tenant brand configuration exists), [#67](https://github.com/TerraOI/TerraOI/issues/67) (`organisations.locale` rejects `en-GB`)
Plan refs: §17.1 (kill switches as settings), §15.0 ("Tenant provisioning by script (F05), not an admin UI"; "Kill switches (tenant, expert, provider) as settings"), §15.2 (M1-PILOT: kill switches verified), §16 (Operations row), §13, §4.1–§4.2; F05, F28 (F06 for the expert switch)

## Goal
Two operations surfaces, both as settings rather than UI: a **script** that provisions a tenant —
organization row, exact hosts, default roles, entitlements — resumably, refusing reserved slugs and
granting the platform admin no operational access; and **kill switches** for platform, tenant, expert and
provider that stop new sessions, runs and model calls at once without touching the deterministic record
system. §15.2 makes "kill switches verified" an M1-PILOT gate item, so the evidence is a staging drill.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_lifecycle_switches.sql`: the switch settings (actor
  and reason per flip), `provision_tenant_v1`, and the suspend/resume RPCs — timestamp agreed in the
  daily sync; merged migrations are never edited
- `src/platform/tenancy/` (lifecycle calls and the switch read the request pipeline uses),
  `scripts/provision-tenant.mjs` — `scripts/` is shared ([scripts/README.md](../../scripts/README.md)),
  so the daily sync confirms no other PR is in it
- `supabase/tests/database/100_lifecycle_switches.test.sql`, `src/platform/tenancy/*.test.ts`,
  `scripts/provision-tenant.test.mjs`

## Must not edit
Merged migrations including
[`20261105060000_tenancy_core.sql`](../../supabase/migrations/20261105060000_tenancy_core.sql);
`src/contracts/`; `src/platform/gateway/` (the provider switch is read by Lane 2's chain selection — ask
through [COORDINATION.md §2](../../docs/COORDINATION.md)); `workers/`, `localbox/`, `.github/`; no secret
in the script, its logs or the repo (AGENTS.md §4.6).

## Contract
F05 `provisionTenant`: authorized control-plane action → org/domain/defaults/entitlements, resumable,
reserved slug rejected, **no operational access granted to a platform admin** (§11). The merged schema
already holds the parts: `organisations.status` (`provisioning | active | suspended | archived |
deleting`), `tenant_domains.status` (`active | reserved | suspended`) and the `slug`/`host` checks, while
`resolve_tenant_host` serves only an `active` domain whose organization is `provisioning` or `active`
(that file, `:234-248`) — a `reserved` row resolves nothing, a `suspended` tenant yields no
`TenantContext` at all (F28,
[docs/contracts/tenancy-and-context.md](../../docs/contracts/tenancy-and-context.md)), and a tenant in
`provisioning` resolves but has no members, so nothing is served. The switch table is the missing setting,
not a new mechanism.
**Owed:** **#45** — with no `model_providers` / `provider_routes` / `provider_health` owner, a provider
switch has nothing to name, so this packet assumes a switch row keyed by `providerKey` and no registry.
**The expert switch** assumes [T-311](./T-311-expert-definitions.md)'s `tenant_experts`; if that has not
merged, this packet lands platform, tenant and provider switches only and says so.
**#62** — provisioning seeds brand defaults, but no packet owns `tenant_brands` (plan §6.1 names it;
`git grep -i brand` over `supabase/` on `main` is empty), so this packet creates nothing brand-shaped.
**#67** — `organisations.locale` checks `^[a-z]{2}(-[A-Z][a-z]{2})?$` (that file, `:25`), which rejects
`en-GB`; and the adjacent timezone CHECK (`:26`) allows **exactly one slash**, so
`America/Argentina/Buenos_Aires` and `America/Indiana/Indianapolis` are rejected while malformed shapes like
`en-Gbr` pass. Provisioning seeds locale and timezone as one unit, so a fix that widens only `:25` leaves
half the bug — and **neither CHECK has ever run in CI**: the only `insert` into `organisations` on `main` is
`supabase/seed.sql:42`, and `locale` appears nowhere in `src/` or `supabase/tests/`. The script passes values
the current CHECKs accept and never works around a constraint.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/100_lifecycle_switches.test.sql` — one provisioning call creates the
      organization, its `company1` and `company1-staging` domain rows, default roles and entitlements, and
      stays `provisioning` until the run completes; re-running the same slug **resumes** it — no duplicate
      rows or domain set — and every switch flip records actor and reason
- [ ] negative: a reserved slug (`admin`, `www`, `terraoi`) and a host already registered to another
      organization are refused, and provisioning as a platform admin creates **no**
      `organisation_memberships` row, so that admin gets no tenant context and reads no tenant data
- [ ] negative: same file — another tenant sees no switch or lifecycle row, a `suspended` membership flips
      nothing, and a tenant admin cannot flip a platform or provider switch
- [ ] negative: with the tenant switch off, `resolve_tenant_host` returns nothing, `set_tenant_scope` grants
      nothing, uploads, downloads and runs refuse — while existing rows stay intact (the deterministic record
      system is never disabled, §17.1)
- [ ] negative: a provider switched off is absent from the eligible chain for **every** tenant (asserted
      through T-115's route selection, not a page), and an expert switched off is not selectable
- [ ] failure: the script interrupted mid-run leaves `provisioning` and is resumable — never an `active`
      tenant with a domain but no roles; a switch flipped mid-run is re-checked before delivery
      (`persistFinalAndAuditBeforeDelivery`, §9.4) and the answer is withheld, with the incident note
      recording that already-sent provider data is not erased by cancelling new calls (§17.1)

## Done evidence
`pnpm verify`; `pnpm db:test` (CI `database` job — no Docker here); staging drill: provision a third
synthetic tenant by script; suspend `company1-staging` and show sign-in, upload, chat and citation all
refuse within one request; resume it; flip a provider switch and show the chain skipping that provider in
the run audit. DNS, Supabase projects and secrets stay human steps (plan §20.8).

## Out of scope
The control-plane UI at `admin.terraoi.app` (§15.0 deferred), connector kill switches (none in M1),
restore rehearsal and rollback artifacts (T-404), dashboards and alert thresholds (T-405), budget
ceilings as settings (T-313), and any provider-registry migration (#45 decides that).
