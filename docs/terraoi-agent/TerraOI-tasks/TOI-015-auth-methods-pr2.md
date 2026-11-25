# TOI-015 T-201 PR-2: invite claim, Entra issuer allow-list, reset revocation

Source: [T-201](../../tasks/T-201-auth-methods.md) (In-M1 column: "Magic link, password and Microsoft SSO, invite-only"), plan §4.2; supervisor rulings on #186 (invite model, from #179), #182, #183, #184, #185; ADR-0003 §3a/§3b/§4 as amended 2026-11-20. Status: **VERIFY** (protected paths: `supabase/migrations/`, `src/platform/identity/`; staging owed).

Found during the audit: [#186](https://github.com/TerraOI/TerraOI/pull/186) was **closed unmerged** after its rulings were given, and nothing replaced it — so on `main` and on every open PR the invite claim threw ("RPC not landed"), and `POST /auth/password-reset` and `POST /auth/entra` were deliberately inert.

## Built (to the rulings)
| Ruling | Implementation |
|---|---|
| #179: claim reads a pending, unexpired `tenant_invitations` row; verified address from `auth.users` inside the definer; no `p_email`; inserts active membership with the invited role; invitation `accepted`; never resurrects suspended/removed | `public.redeem_invitation_v1(p_host)` in `supabase/migrations/20261125130000_identity_methods.sql`; creates the profile on a first-ever sign-in |
| #182: reset revocation organisation-wide, host resolved inside, unknown host refused | `toi_identity.revoke_user_sessions_v1` revokes on every host of the organisation |
| #183: `true` = the revocation ran, including zero rows | returns true after the update; 018 #25 pins the zero-session case |
| #184: sixth function on `toi_session_worker`, 014 #44 and 016 #16 edits authorised | grant + exactly those two edits |
| #185: Entra read keyed on the routed host, unknown host indistinguishable from "no issuers", old signature dropped, authenticated only | `public.entra_allowed_issuers_v1(p_host)`; the org-keyed signature never existed on `main` |
| TS | `signin-completion.ts` (claim when no membership row; port `{host, accessToken}`), `entra-linking.ts` (port `(host, accessToken)`), `tenancy-data-api.ts` (two RPC calls), `session-db.ts` (`createSessionRevoker`), `adapters.ts` (ports installed only where carriers exist) |

## Evidence
- pgTAP `018_identity_methods.test.sql` 27/27 (privileges; claim on wrong/unknown host, other address, unverified, success with role + accepted + profile, replay, no resurrection; Entra host keying, suspended org, no subject; org-wide revocation, other org survives, zero sessions true, unknown host 28000, non-normalised host 22023); 001/014/016 updated as ruled.
- Vitest identity suite 322 pass (updated invite-model tests; new `session-revoker.test.ts`, adapter wiring tests).

## Deviations to confirm (backlog Q-13)
- The claim is **host-keyed** (`p_host`) like the #185 read, rather than taking the organisation id the Worker resolved: the routed host is the only tenant input a pre-membership request has, and it lets SQL itself prove "a company1 invite claimed on company2's host creates nothing" (018 #5).
- New pgTAP slot **018** instead of growing PR-1's 012.
