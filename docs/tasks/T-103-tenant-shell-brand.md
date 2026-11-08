# T-103 Tenant shell and brand loading in `terraoi` mode

Lane: 1 · Week: 1 · Protected: no · Depends on: T-002, T-003, T-101, T-102 · Status: in progress (wyuinline) — the brand **validator, loader and cache** half is open as this PR: `src/platform/branding/` now holds the one validated `TenantBrand` object (hex colors only, real contrast checks, unresolved placeholders refused, https-only support links, asset path/type/size/content rules), the F04 host-driven loader with its platform fallback and admin-visible note, and the public cache that is hostname-keyed, bounded and refuses to hold membership data. The **shell** half (`src/components/tenant-shell/`, `src/app/(tenant)/layout.tsx`) is deliberately not opened: a Server Component still has no way to get the trusted routed host ([#55](https://github.com/TerraOI/TerraOI/issues/55)), there is no `tenant_brands` row to read ([#62](https://github.com/TerraOI/TerraOI/issues/62) — the loader reaches it through an injected port whose honest default today is "no row"), and nothing rules on how brand assets are served (the question this PR opens). The staging `Done evidence` below is **not** claimed, for those reasons. `TenantBrand` stays out of `src/contracts/` because [ADR-0004](../decisions/0004-tenant-brand-contract.md) is still proposed and blocked
Plan refs: §5.1, §9.1; F04

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
