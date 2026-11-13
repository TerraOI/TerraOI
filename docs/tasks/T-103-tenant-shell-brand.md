# T-103 Tenant shell and brand loading in `terraoi` mode

Lane: 1 · Week: 1 · Protected: no · Depends on: T-002, T-003, T-101, T-102 · Status: in progress (wyuinline) — the brand **validator, loader and cache** half is open as this PR: `src/platform/branding/` now holds the one validated `TenantBrand` object (hex colors only, real contrast checks, unresolved placeholders refused, https-only support links, asset path/type/size/content rules), the F04 host-driven loader with its platform fallback and admin-visible note, and the public cache that is hostname-keyed, bounded and refuses to hold membership data. The **shell** half (`src/components/tenant-shell/`, `src/app/(tenant)/layout.tsx`) is deliberately not opened: a Server Component still has no way to get the trusted routed host ([#55](https://github.com/TerraOI/TerraOI/issues/55)), there is no `tenant_brands` row to read ([#62](https://github.com/TerraOI/TerraOI/issues/62) — the loader reaches it through an injected port whose honest default today is "no row"), and nothing rules on how brand assets are served (the question this PR opens). The staging `Done evidence` below is **not** claimed, for those reasons. `TenantBrand` stays out of `src/contracts/` because [ADR-0004](../decisions/0004-tenant-brand-contract.md) is still proposed and blocked

**Update (2026-11-10), the brand-configuration half.** #55, #62 and #118 are answered, so the blockers named above are closed: `20261109213000_brand_config.sql` creates `tenant_brands` and `tenant_brand_assets`, and `src/platform/branding/brand-source.ts` feeds the port that used to answer "no row", while `GET /brand-assets/{configVersion}/{name}` serves a host's own assets with the FAQ-0008 header set (pgTAP slot 026; §6a loopback harness for the socket claims). **Status: code complete; staging evidence owed** ([COORDINATION.md §6a](../../docs/COORDINATION.md)). Owed and named: ADR-0006's staging spike (a Workers request that proves `proxy.ts` overwrites a forged `x-toi-routed-host`) — until it passes, no page may read that header, so the shell half stays closed; #38's object-storage path, which is why customer asset bytes live in the row behind a 64 KiB CHECK rather than in a bucket; and the §20.8 human steps in [T-004](T-004-infrastructure.md) that put a deploy in front of `curl` at all. The `curl -sD-` evidence below is therefore not ticked, and no acceptance box that names staging is ticked on unit evidence.
Plan refs: §5.1, §9.1; F04

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Owns** (from [#62](https://github.com/TerraOI/TerraOI/issues/62)): `src/contracts/tenant-brand.ts`, ADR-0004 to accepted for §2–§5 and §7 ([#65](https://github.com/TerraOI/TerraOI/issues/65)), and one migration for `tenant_brands` and `tenant_brand_assets`.
- **Brand asset delivery** ([#118](https://github.com/TerraOI/TerraOI/issues/118), FAQ-0008): a git-ignored `prebuild` copy of the kit into `public/brand/v<kit version>/` (and `check:structure` refuses a committed copy); customer assets through `GET /brand-assets/{configVersion}/{name}`, host from `request.url`, read by an anon definer `load_public_brand_asset(host, config_version, name)`; unknown host/version/name is one identical 404; headers `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, and for SVG `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.
- **Done evidence adds:** `curl -sD-` for the platform logo on `terraoi.app` and a company1 logo on its host, and company1's logo path on company2's host returning the 404. The shell half may open (#55 and #62 are answered), after the #55 staging spike that proves `proxy.ts` on Workers.

## Goal
A signed-in employee on a tenant host gets the branded shell (navigation, expert list, project
picker) driven by one validated `TenantBrand`, and the `terraoi` platform mode for
`terraoi.app`/`admin.terraoi.app`.

## Owns (may edit)
- `src/platform/branding/`, `src/components/tenant-shell/`, `src/app/(tenant)/layout.tsx`,
  `src/app/layout.tsx`, `public/`
- `src/platform/branding/*.test.ts`

## Must not edit
`brand/` (read-only design source), `src/contracts/`, `src/platform/{tenancy,identity}/`, Lane 2 paths

## Contract
`TenantBrand` contract lands with this packet in `src/contracts/tenant-brand.ts` — **needs an ADR**
([COORDINATION.md §2](../../docs/COORDINATION.md)); until then build against
[`TenantContext`](../../src/contracts/tenant-context.ts) and the kit sources
`brand/terraoi-brand-kit/02-system/tokens.json` + `brand-config.json`, read **only** through
`src/platform/branding/` ([FAQ-0001](../../docs/FAQ.md), [brand/README.md](../../brand/README.md)).

## Acceptance tests (write first)
- [ ] positive: mode `terraoi` for platform hosts, `customer`/`powered` selectable only by tenant
      configuration — never by a query parameter or header
- [ ] negative: an unknown host, or a tenant with no brand row, falls back to the platform brand
      and leaks no other customer's name, logo or colors
- [ ] negative: invalid color values, an SVG/HTML asset over the size limit, a non-https support
      URL and an unresolved placeholder (`{{company}}`) are each rejected with a safe error
- [ ] negative: contrast check — white text on a light primary is refused, not shipped
- [ ] failure: brand row missing/partial → platform fallback plus an admin-visible note, never a
      blank shell or a crash
- [ ] cache: the public brand cache is hostname-keyed, bounded, and contains **no** membership data

## Done evidence
`pnpm verify`; staging: company1 host shows Company1 colors/logo/title, company2 host shows its
own, `terraoi.app` shows platform branding; `curl -sD-` shows `Cache-Control` on the brand asset
response.

## Out of scope
Email/report/manifest branding in all three modes (T-204); custom domains; form designer; admin UI.
