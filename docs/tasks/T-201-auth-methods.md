# T-201 Password sign-in, Microsoft SSO, invites and identity linking

Lane: 1 · Week: 2 · Protected: yes (`src/platform/identity/`) · Depends on: T-002, T-003, T-101, T-102 · Status: ready
Plan refs: §4.2 (TOI-ADR-15), §4.1 step 6, §16 (host/session row); F02, F05 (callback registration)

## Goal
The three M1 sign-in methods — magic link, email + password, Microsoft Entra SSO — all work on the
tenant origin and end in the same host-only session; an Entra identity links to the invited
`profiles` row **only** when the provider-verified email matches, and any verified identity without
an active `organisation_memberships` row gets only the generic no-access page.

## Owns (may edit)
- `src/platform/identity/` (password, Entra callback, invite claim, linking, session, reset),
  `src/app/(tenant)/login/`, `src/app/auth/`, `src/app/(tenant)/account/`
- `src/platform/identity/*.test.ts`, `supabase/tests/database/012_auth_methods.test.sql`
- if invite/reset state needs SQL: one migration
  `supabase/migrations/YYYYMMDDHHMMSS_identity_methods.sql`, timestamp agreed in the daily sync;
  migrations are protected and merged ones are never edited

## Must not edit
`src/contracts/`, `src/platform/tenancy/` (T-101), `supabase/migrations/` (no merged migration is
edited); additive `supabase/seed.sql` fixtures only in the same PR as a new migration

## Contract
`TenantContext.membershipStatus: "active"` and `createTenantContext` in
[`tenant-context.ts`](../../src/contracts/tenant-context.ts);
[`NormalizedHost`](../../src/contracts/keys.ts) for exact callback-URL allow-listing; tables
`profiles` and `organisation_memberships` (`invited | active | suspended | removed`) with
`is_active_member(uuid)` and `set_tenant_scope(uuid)` from the merged tenancy migration
`supabase/migrations/20261105060000_tenancy_core.sql` (lands with T-003). Identity proves
*who*, membership decides *whether* (F02): see
[docs/contracts/tenancy-and-context.md](../../docs/contracts/tenancy-and-context.md).

## Acceptance tests (write first)
- [ ] positive: `src/platform/identity/password-signin.test.ts` — seeded `owner1@company1.test` signs
      in with a password on `company1.terraoi.app` and gets a session whose cookie is host-only,
      `Secure`, `HttpOnly`, `SameSite=Lax`
- [ ] positive: `src/platform/identity/entra-linking.test.ts` — Entra sign-in with a
      **provider-verified** email matching an invited membership links to the existing profile: one
      profile row, one membership, no duplicate identity
- [ ] negative: same file — an unverified provider email is never auto-linked; a Microsoft account
      with no membership row sees only the no-access page; a tenant allow-listed to one Entra tenant
      ID refuses an outside account
- [ ] negative: `supabase/tests/database/012_auth_methods.test.sql` — a `suspended` or `removed`
      membership cannot scope to the tenant (`28000`) even with a valid session and the right
      organization id; a link or invite replayed against company2 creates nothing
- [ ] negative: an invite bound to `field2@company1.test` cannot be claimed by another address, and a
      reset link opened on the wrong host yields no session
- [ ] failure: `src/platform/identity/password-reset.test.ts` — reset revokes other sessions; an
      expired, already-used or rate-limited request returns one indistinguishable safe error (no
      address enumeration); an Entra outage gives a generic failure and no partial session

## Done evidence
`pnpm verify`; `pnpm db:test` when the migration lands; staging: sign in as the seeded owner by
password **and** by Entra on `company1-staging.terraoi.app`, paste the `Set-Cookie` attributes, and
show `left@company1.test` (suspended) gets only the no-access page.

## Out of scope
Central SSO, the multi-tenant switcher, custom customer domains and a provisioning UI (plan §15.0
"Deferred after M1"); admin invite/role/project pages are T-202; reset **email branding** is T-204.
