# T-201 Password sign-in, Microsoft SSO, invites and identity linking

Lane: 1 · Week: 2 · Protected: yes (`src/platform/identity/`) · Depends on: T-002, T-003, T-101, T-102; the invite claim also on T-202 PR-1b (`tenant_invitations`, [#179 ruling](https://github.com/TerraOI/TerraOI/pull/179#issuecomment-6985900913)) · Status: in progress (wyuinline) — **PR-1** is open as [PR #181](https://github.com/TerraOI/TerraOI/pull/181): the three M1 methods' decision logic on one shared guard chain and one shared completion tail (`src/platform/identity/signin-request.ts`, `signin-completion.ts`), password sign-in and recovery through **GoTrue's own credential endpoints** (no password-hashing dependency added, and none needed), the Entra linking policy in `entra-linking.ts` (link only on a provider-verified email; refuse an unverified one; refuse an issuer outside the tenant's allow-list; a verified identity with no active membership gets only the no-access surface), and pgTAP slot `012`. `pnpm verify` green on this machine (986 tests, 79 files); **`pnpm db:test` is not**: no Docker on a builder machine (FAQ-0009), so slot `012`'s plan count belongs to CI's `database` job. **PR-2** `t-201b-invite-reset-sql` — the invite-claim RPC, the reset bookkeeping and other-session revocation, and the per-tenant Entra issuer allow-list, with one migration and the `001_function_privileges` allow-list entries — is **not started**; the two ports that need it are **absent** from the adapter, and both handlers check for them before dialing a provider, so `POST /auth/entra` and `POST /auth/password-reset` answer `unavailable` today rather than taking the user through a provider round trip or a recovery email that is certain to end at a refusal — inert, and inert visibly. The password method is complete and works without PR-2. Not `done`: protected path, so the supervisor's `APPROVED` on the final head is required, and **every staging box below is owed, not waived** — Entra credentials and the `company1-staging.terraoi.app` runs are T-004 §20.8 owner steps, and staging deploys are blocked repo-wide while [#177](https://github.com/TerraOI/TerraOI/issues/177) is open.
Plan refs: §4.2 (TOI-ADR-15), §4.1 step 6, §16 (host/session row); F02, F05 (callback registration)

## Supervisor rulings to apply (2026-11-18)
These supersede anything below that disagrees.
- **Invite claim** ([#179 ruling](https://github.com/TerraOI/TerraOI/pull/179#issuecomment-6985900913), [#186 note](https://github.com/TerraOI/TerraOI/pull/186#issuecomment-6985928849)): `redeem_invitation_v1` reads a pending, unexpired `tenant_invitations` row (T-202 PR-1b) for the routed tenant, matches the caller's **provider-verified** email (`auth.users.email` with `email_confirmed_at` set, read in the definer function, no `p_email` argument), and in one transaction inserts the membership as `active` with the invited role and marks the invitation `accepted`. Answers stay `redeemed | not_found | email_mismatch`; an expired or revoked invitation answers `not_found`. A suspended or removed membership is never resurrected by a claim. It is the only function that makes a membership active.

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
      **provider-verified** email matching a pending invitation links to the existing profile: one
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
