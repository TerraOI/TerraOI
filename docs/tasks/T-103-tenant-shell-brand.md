# T-103 Tenant shell and brand loading in `terraoi` mode

Lane: 1 · Week: 1 · Protected: no · Depends on: T-002, T-003, T-101, T-102 · Status: ready
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
