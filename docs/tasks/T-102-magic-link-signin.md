# T-102 Magic-link sign-in, membership gate and host-only session

Lane: 1 · Week: 1 · Protected: yes (`src/platform/identity/`) · Depends on: T-002, T-003, T-101 · Status: in progress (wyuinline) — every code half is on `main`: **a** merged as [#30](https://github.com/TerraOI/TerraOI/pull/30), **b** as [#50](https://github.com/TerraOI/TerraOI/pull/50), and **c+d** through [#77](https://github.com/TerraOI/TerraOI/pull/77) at `0f5fecd`, which carried [#90](https://github.com/TerraOI/TerraOI/pull/90)'s request/complete flow, the `/auth/magic-link`, `/auth/callback` and `/auth/sign-out` routes, and the #37(b) session carrier — `src/platform/identity/session-store.ts`, migration `20261107024000_session_store.sql`, pgTAP `supabase/tests/database/014_identity_session.test.sql`, [ADR-0003](../decisions/0003-session-and-identity-carrier.md) — and in doing so **replaced** the pre-#37(b) `complete-magic-link.ts` and `http-response.ts` that the stacked [#52](https://github.com/TerraOI/TerraOI/pull/52) and [#57](https://github.com/TerraOI/TerraOI/pull/57) had put on `main`. Re-checked by `git merge-base --is-ancestor` against `main` at `c7e7e8d` (CI, `Main guard` and `Deploy staging` all green there); the CI `database` job runs `014_identity_session.test.sql` and reports `PASS`. The staging demo below is **not** claimed — it waits on [#75](https://github.com/TerraOI/TerraOI/issues/75) (how the Worker reaches the session row) and [#64](https://github.com/TerraOI/TerraOI/issues/64) (no outbound email transport), which is the question in [#94](https://github.com/TerraOI/TerraOI/issues/94)
Plan refs: §4.2, §4.4; F02, F05 (invite part)

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Staging evidence is owed, not waived** ([#94](https://github.com/TerraOI/TerraOI/issues/94), COORDINATION.md §6a): status reads "code complete; staging evidence owed" until T-105 ([#64](https://github.com/TerraOI/TerraOI/issues/64)) and `SESSION_DB` ([#75](https://github.com/TerraOI/TerraOI/issues/75)) land and the run is recorded. Until then `unresolvedSessionStore()` answering "unavailable" is correct behaviour.
- **Add a loopback test now:** the real callback and sign-out handlers over Node `http` (`listen(0)` on `127.0.0.1`) with the in-memory session store and email fakes; assert the `Set-Cookie` attributes on the wire (host-only, `Secure`, `HttpOnly`, `SameSite`, path) and the no-access response for `left@company1.test`.

## Goal
An invited person signs in on their tenant origin with an email magic link; a verified identity
plus an **active `organisation_memberships` row** is what grants access. Sessions are host-only
cookies, and state-changing requests require exact-Origin plus CSRF checks.

## Owns (may edit)
- `src/platform/identity/`, `src/app/(tenant)/login/`, `src/app/auth/` callback routes
- `src/platform/identity/*.test.ts`, `supabase/tests/database/011_identity*.test.sql`

## Must not edit
- `src/contracts/`, `src/platform/tenancy/` (T-101), `supabase/migrations/` unless this packet
  lands its own `YYYYMMDDHHMMSS_identity.sql` (protected, timestamp agreed in the daily sync)

## Contract
`TenantContext.membershipStatus` must be the literal `"active"`
([tenant-context.ts](../../src/contracts/tenant-context.ts)); tables
`organisation_memberships`, `profiles`, `tenant_domains` and helpers `is_active_member`,
`set_tenant_scope` from the merged tenancy migration
`supabase/migrations/20261105060000_tenancy_core.sql` (lands with T-003).

## Acceptance tests (write first)
- [ ] positive: magic link issued on `company1.terraoi.app` establishes a session whose cookie is
      host-only (`Set-Cookie` has no `Domain=`), `Secure`, `HttpOnly`, `SameSite=Lax`, and a
      `__Host-` prefix where the adapter allows it
- [ ] negative: a valid identity with **no** membership row (or status `suspended`/`invited`) sees
      the generic no-access page — not tenant branding beyond the public login surface
- [ ] negative: a session cookie from `company1` is not accepted on `company2`; a callback URL for
      tenant A replayed on tenant B's host fails
- [ ] negative: a `POST` without a matching `Origin` and valid CSRF token is rejected
- [ ] negative: an invite bound to `user@example.test` cannot be claimed by `User@Example.test`
      bypassing normalization, and cannot be redeemed on another tenant
- [ ] failure: expired / already-used magic link → safe error, no session, no tenant data;
      rate-limited request does not leak whether the address is invited

## Done evidence
`pnpm verify`, `pnpm db:test` (pgTAP for the membership/invite constraints), staging: sign in as
the seeded `owner1@company1.test`, confirm the cookie attributes in the response headers, and
confirm `left@company1.test` (suspended) gets the no-access page.

## Out of scope
Password and Microsoft SSO (T-201); admin invite UI (T-202); multi-tenant switcher UX; central SSO.
