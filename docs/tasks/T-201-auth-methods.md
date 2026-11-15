# T-201 Password sign-in, Microsoft SSO, invites and identity linking

Lane: 1 · Week: 2 · Protected: yes (`src/platform/identity/`) · Depends on: T-002, T-003, T-101, T-102 · Status: in progress (wyuinline) — **PR-1** is open as [PR #181](https://github.com/TerraOI/TerraOI/pull/181): the three M1 methods' decision logic on one shared guard chain and one shared completion tail (`src/platform/identity/signin-request.ts`, `signin-completion.ts`), password sign-in and recovery through **GoTrue's own credential endpoints** (no password-hashing dependency added, and none needed), the Entra linking policy in `entra-linking.ts` (link only on a provider-verified email; refuse an unverified one; refuse an issuer outside the tenant's allow-list; a verified identity with no active membership gets only the no-access surface), and pgTAP slot `012`. `pnpm verify` green on this machine (996 tests, 79 files); **`pnpm db:test` is not** — no Docker on a builder machine (FAQ-0009) — so slot `012` is CI's to run, and CI's `database` job on that head reports `012_auth_methods.test.sql … ok`, `Files=12, Tests=436, Result: PASS`. **PR-2** is open as [PR #186](https://github.com/TerraOI/TerraOI/pull/186) (draft, based on `t-201a-auth-methods` while #181 is unmerged): one migration `supabase/migrations/20261115060000_identity_methods.sql` — `public.redeem_invitation_v1` (claims the caller's **own** `invited` row, subject from `auth.uid()`, bound to `profiles.email` in slot 011's canonical form; no user argument on the call), `public.tenant_entra_issuers` read by `public.entra_allowed_issuers_v1` (RLS on with no policies, `[]` means "permits nothing", a nonexistent organization raises rather than answering empty), and `toi_identity.revoke_user_sessions_v1`, whose boolean means **the revocation ran** and not "rows fell", so a first-ever reset completes — plus slot `012` at `plan(19) -> plan(68)`, the two `001_function_privileges` allow-list entries (FAQ-0010), and the adapter ports PR-1 left absent. `pnpm verify` green on this machine at head `ac33a8e` (1014 tests, 79 files), `check:migrations` and `check:lanes` green; **`pnpm db:test` still cannot run here** (no Docker, FAQ-0009), so slot `012`'s 68 assertions are CI's `database` job's to run. Two merged assertions in other packets' slots (`014` #44, `016` #16) moved because the migration adds a sixth `toi_identity` function and a seventh `toi_session_worker` grant — asked in [#184](https://github.com/TerraOI/TerraOI/issues/184), which is what #186's `Provisional on:` line names; the issuer read's disclosure surface is [#185](https://github.com/TerraOI/TerraOI/issues/185), and the two rulings PR-1 recorded stay open as [#182](https://github.com/TerraOI/TerraOI/issues/182) and [#183](https://github.com/TerraOI/TerraOI/issues/183). `POST /auth/entra` and `POST /auth/password-reset` are no longer inert **where their carriers are bound** (`SESSION_DB` for the revocation, the Data API for the issuer read); where a carrier is missing the port stays absent, the handler checks before dialing a provider, and the answer is still `unavailable` rather than a provider round trip or a recovery email certain to fail. Password **sign-in** works without PR-2; password **reset** needs the revocation, and the Entra staging box additionally needs a real tenant's issuer row populated (T-004 §20.8 owner step). Not `done`: protected path, so the supervisor's `APPROVED` on the final head is required, and **every staging box below is owed, not waived** — Entra credentials and the `company1-staging.terraoi.app` runs are T-004 §20.8 owner steps, and staging deploys are blocked repo-wide while [#177](https://github.com/TerraOI/TerraOI/issues/177) is open.
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
