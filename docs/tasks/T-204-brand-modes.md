# T-204 Brand contract in all three modes: login, shell, chat, errors, email

Lane: 1 · Week: 2 · Protected: no · Depends on: T-002, T-102, T-103 · Status: ready
Plan refs: §5.1, §4.4 (public brand cache), §16 (white-label row), §20.5 (M1 subset); F04

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Sender domain** ([#64](https://github.com/TerraOI/TerraOI/issues/64), [#98](https://github.com/TerraOI/TerraOI/issues/98)): the human step is T-004's "Email transport" line (T-105), which the sentence below points at.
- **Brand-mode test** ([#65](https://github.com/TerraOI/TerraOI/issues/65)): rewrite `brand-modes.test.tsx:43-54` against the two marker values exported by `src/contracts/tenant-brand.ts` (scoped edit authorized, as in #44).

## Goal
One validated brand object drives product identity everywhere an employee can see it — login, reset
and invite pages, the tenant shell, chat empty and error states, browser titles, manifest and favicon,
notifications and **email** — in all three modes (`terraoi`, `powered`, `customer`), with a reviewed
platform fallback and no unresolved placeholder or unverified sender anywhere.

## Owns (may edit)
- `src/platform/branding/` (loader, validation, mode resolution, fallback),
  `src/platform/notifications/` (email templates and sender configuration)
- `src/app/` (login/reset/invite pages, error boundaries, layout metadata, manifest and icon routes),
  `src/components/`, `public/`
- `src/platform/branding/*.test.ts`, `src/platform/notifications/*.test.ts`

## Must not edit
`brand/` is a read-only design source — the app reads tokens only through `src/platform/branding/`
and never imports from `brand/` ([FAQ-0001](../../docs/FAQ.md), [brand/README.md](../../brand/README.md));
also `src/contracts/` (the `TenantBrand` contract needs an ADR, [COORDINATION.md §2](../../docs/COORDINATION.md)),
`src/platform/tenancy/`, `src/platform/identity/` and Lane 2 paths

## Contract
`TenantBrand` as introduced with [T-103](./T-103-tenant-shell-brand.md): display and legal names,
descriptor, logo, favicon, primary/on-primary/accent colors, attribution, report owner, email sender
name, verified sender and reply-to, document prefix, support links, locale, timezone. Until that
contract is merged, read `tokens.json` and `brand-config.json` **only** inside
`src/platform/branding/` and keep the shape identical. The mode is tenant configuration resolved from
the host-resolved organization (F04 in
[docs/contracts/tenancy-and-context.md](../../docs/contracts/tenancy-and-context.md)), never a request
parameter.

## Acceptance tests (write first)
- [ ] positive: `src/platform/branding/brand-modes.test.ts` — each mode renders its surface set:
      `terraoi` on platform hosts, `powered` with attribution, `customer` without provider attribution
      in product content, across login, shell, chat empty/error and email
- [ ] positive: `src/platform/notifications/email-branding.test.ts` — invite, reset and knowledge
      notifications carry the tenant display name, a **verified** sender and reply-to, and a link whose
      host is that tenant's origin
- [ ] negative: `?brand=`, a header, a cookie or a query parameter cannot select the mode, and a brand
      row for another tenant is never served or cached under this host
- [ ] negative: `customer` mode still shows the real `company1.terraoi.app` host and keeps required legal
      disclosures; an SVG/HTML upload, unverified sender, non-https support URL, invalid color, failed
      contrast pair and unresolved `{{company}}` are each rejected
- [ ] failure: a missing or partially invalid brand row yields the reviewed platform fallback plus an
      admin-visible note — never a blank shell, a crash, or an email from an unverified domain
- [ ] cache: the public brand cache is hostname-keyed and bounded, holds **no** membership data, and a
      configuration-version change invalidates it within the documented TTL

## Done evidence
`pnpm verify`; staging: Company1 shows its names, colors and logo in `customer` mode, the same tenant
switched to `powered` shows attribution, `terraoi.app` shows platform branding, and a staging invite
email shows the verified sender (headers pasted, no secret values).

## Out of scope
Printed reports and PDF/Word export branding, custom customer domains, a brand editor UI and the
control-plane UI (plan §15.0 "Deferred after M1"); first shell load in `terraoi` mode was T-103;
sending-domain setup is a human step in [T-004](./T-004-infrastructure.md) ("Email transport", for [T-105](./T-105-email-transport.md)).
