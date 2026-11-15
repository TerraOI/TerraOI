-- T-201 (PR-2, `t-201b-invite-reset-sql`): the three SQL halves PR-1 deliberately left out.
--
-- PR-1 (#181) landed the decision logic for the three M1 sign-in methods and, because it could not land
-- this file, it left the three capabilities **absent** rather than stubbed: `allowedEntraIssuers` and
-- `revokeUserSessions` are not implemented in `src/platform/identity/adapters.ts`, and both handlers
-- check for them **before** dialing a provider, so `POST /auth/entra` and `POST /auth/password-reset`
-- answer `unavailable` today instead of taking a user through a Microsoft round trip or a recovery email
-- that is certain to end at a refusal. This migration is the reason those ports may exist.
--
-- Three objects, and each is shaped by a rule that already exists in the merged schema:
--
--   1. `public.redeem_invitation_v1` — the invitee claiming **their own** invitation (F05). There is no
--      invitations table: an invitation *is* an `organisation_memberships` row in status `invited`
--      (20261105060000_tenancy_core.sql:68-80), and the address it binds to is `profiles.email`, stored
--      only in canonical form (`:59`, pinned by 011 assertions 1-6).
--   2. `toi_identity.revoke_user_sessions_v1` — the revocation a completed password reset owes, over the
--      session store's own carrier (#75).
--   3. `public.tenant_entra_issuers` + `public.entra_issuer_allowed_v1` — plan §4.2: "tenant admins may
--      additionally restrict a tenant to an allow-listed Entra tenant ID". **On this branch only**, that
--      read is the verdict-shaped one (`entraIssuerAllowed(organisationId, issuerTenantId) -> 'allowed' |
--      'denied' | null`, `null` still a refusal) rather than the list-shaped `entra_allowed_issuers_v1`
--      that #186 ships, because the branch exists to price the shape question in `#185`. Same policy,
--      same table, same privileges; what moves is where the exact-match comparison happens.
--
-- pgTAP: every assertion this file needs joins slot **012** (`012_auth_methods.test.sql`), which
-- COORDINATION §6b reserves to T-201 and whose header already said these land in PR-2. Two merged
-- suites count the `toi_identity` function set and therefore move with object 2 — `014` test 44 (five
-- SECURITY DEFINER functions) and `016` test 16 (the worker's EXECUTE set). Those edits are made here,
-- in one named commit, because the alternative is a red CI run that hides every other result; ADR-0003
-- §3a decided that grant set as *five functions*, so the sixth is on the supervisor's list in the PR
-- body and the PR carries `provisional`. Nothing is skipped or softened: both counts go **up**.
--
-- Privileges (FAQ-0010): all three functions are revoked from `public, anon, authenticated,
-- service_role` by full signature **inside this file**, and the two `public` ones a request role must
-- reach are granted back to `authenticated` only, with `001_function_privileges.test.sql`'s allow-list
-- updated in this same PR. The `toi_identity` one is granted to `toi_session_worker` and to no request
-- role — 001 test 33 keeps `anon`/`authenticated` out of that schema, and this migration does not
-- change that.
--
-- What is deliberately **not** here:
--   * no write to `organisations.policy_revision`. #98's writer (`bump_policy_revision()` + its
--     triggers, in T-202 PR-1 #179, unmerged at the time of writing) is the only writer, and it fires on
--     `organisation_memberships` — so this claim moves the revision automatically once #179 merges, and
--     moves nothing until then. Bumping it here would be a second writer, which is what #98 exists to
--     prevent.
--   * no admin surface for the issuer list (T-202), no RLS policy on `tenant_entra_issuers` for
--     members (nothing reads it through the Data API in M1), and no seeded issuer row: Company1's real
--     Entra tenant id is a customer value, not a fixture (AGENTS.md §4.7). Populating one is an owner
--     step until T-202 lands the admin page — named in the PR body, because the packet's staging Entra
--     box depends on it.
--   * no retention rule for anything new: this migration creates no new table that accumulates rows.
--     The password reset's bookkeeping is the `revoked_at` stamp on each session row it takes down,
--     which is the record ADR-0003 §2 already names ("a timestamp, not a boolean, so a support review
--     can see when it happened"); a separate revocations table would need a retention rule of its own
--     and another grant, and would say nothing `revoked_at` does not.

-- ---------------------------------------------------------------- 1. the per-tenant Entra issuer allow-list
-- Tenant configuration, so it lives in `public` with the rest of the tenant tables, carries
-- `organisation_id`, and is RLS-enabled like every one of them (guardrail 000 rule 1).
create table public.tenant_entra_issuers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,

  -- Entra tenant ids are uuids, and `entra-linking.ts:37` matches them exactly ("never case-folded:
  -- a near miss is a refusal"). CHECKing the canonical form here is what makes that rule hold at the
  -- data level: a stored `ABCDEF...` variant could never match, and the failure would look like a
  -- configuration that works.
  issuer_tenant_id text not null check (
    issuer_tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  created_at timestamptz not null default now(),

  -- One row per (tenant, issuer): a duplicated allow-list entry is not a second policy, and the unique
  -- key is what makes an idempotent admin write possible later (T-202) without a read-then-write race.
  unique (organisation_id, issuer_tenant_id)
);

comment on table public.tenant_entra_issuers is
  'Plan §4.2: the Entra tenant ids a tenant permits. Empty means the tenant has allowed none, which refuses every Entra sign-in — it does not mean unrestricted.';

alter table public.tenant_entra_issuers enable row level security;

-- A new table in `public` may arrive with privileges already granted by the stored default privileges
-- (`001` test 35 names those rows: they belong to `supabase_admin`, and a migration cannot close them),
-- and `20261105060000_tenancy_core.sql:335`'s blanket revoke reached only the tables that existed then.
-- So the revoke is per-table and explicit, exactly as `20261107024000_session_store.sql:227` does it for
-- its own new table. RLS with **no policies** is the second guard, not the first.
revoke all on table public.tenant_entra_issuers from anon, authenticated, service_role;

-- The read behind `allowedEntraIssuers(organisationId)`.
--
-- SECURITY DEFINER, unlike the two §3b reads, and it has to be: the table has no policies, so an
-- invoker read would answer `[]` to everyone — which `decideEntraLink` reads as "this tenant permits no
-- issuer" and turns into a refusal of every Entra sign-in, silently and plausibly. The bound is the
-- exact-organisation predicate in the body, plus the grants below.
--
-- It also cannot be a FAQ-0011 scoped RPC. The issuer gate runs **before** the membership question, and
-- it must answer for identities that hold no membership at all: the packet's positive case is an
-- *invited* membership being linked, and its negative case is a Microsoft account with no membership
-- row reaching the no-access surface (`docs/tasks/T-201-auth-methods.md:38-43`). `set_tenant_scope`
-- raises 28000 for both of those callers (20261105060000_tenancy_core.sql:214), so a scoped read would
-- answer them the way it answers an unauthorized caller. That is the same pre-activation problem
-- ADR-0003 §3b recorded for `current_membership_v1`; what differs is that this one reads one tenant's
-- configuration rather than the caller's own row, so the disclosure surface is a question for the
-- supervisor (see the PR body), not something this file decides. Two things keep it narrow: it is never
-- reachable by `anon` (every caller holds the signed-in user's token by the time the gate runs), and it
-- returns one tenant's list to a caller who must already name that tenant's id, which the Worker takes
-- from the routed host and never from the request (AGENTS.md §4.1).
-- PROTOTYPE (the branch is `t-201c-proto-issuer-verdict`; #186 ships the list-shaped read): the same
-- policy asked as the question the gate actually asks, so there is no configuration list for a caller
-- to iterate. `#185`'s option 4, and the shape is the supervisor's to rule on — this branch exists to
-- show what choosing it costs, in the two places the cost lands: the exact-match rule moves from
-- `entra-linking.ts` into this predicate (pinned by slot `012` assertion 69), and the "no issuer at all"
-- answer has to stay a caller-side answer (pinned in Vitest).
create or replace function public.entra_issuer_allowed_v1(p_organisation_id uuid, p_issuer_tenant_id text)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_organisation_id is null or p_issuer_tenant_id is null then
    raise exception 'organization id and issuer tenant id are both required' using errcode = '22023';
  end if;

  -- An identity the provider gave no issuer for is **not** a denied issuer: it is an unknown identity,
  -- and `entra-linking.ts` answers that before dialing anything. An empty candidate reaching this
  -- function is a caller bug, refused rather than answered — answering `denied` here would turn a
  -- "who is this?" into "this tenant refuses them", which is the one confusion the gate's two outcomes
  -- exist to keep apart.
  if btrim(p_issuer_tenant_id) = '' then
    raise exception 'issuer tenant id is required' using errcode = '22023';
  end if;

  -- An organization this host does not have is not an organization that permits nothing. The raise is
  -- the same signal the request-side read already maps to `policy_unresolved`, which is why the verdict
  -- set stays two-valued: `unknown_tenant` as a return value would be a third way to say what a raise
  -- says, and a third state is one more branch to pin in two venues.
  if not exists (select 1 from public.organisations o where o.id = p_organisation_id) then
    raise exception 'no such organization' using errcode = '28000';
  end if;

  -- Exact match, never case-folded: the payload's uuid must equal a stored row. The rule is stated at
  -- `src/platform/identity/entra-linking.ts` and used to be enforced there; here it is the predicate
  -- itself, which is why slot `012` assertion 69 asks an upper-cased uuid against a lower-cased row.
  -- A `lower(...)` or `ilike` in this comparison would leave every other issuer assertion passing.
  if exists (
    select 1 from public.tenant_entra_issuers i
     where i.organisation_id = p_organisation_id
       and i.issuer_tenant_id = p_issuer_tenant_id
  ) then
    return 'allowed';
  end if;
  return 'denied';
end;
$$;

comment on function public.entra_issuer_allowed_v1(uuid, text) is
  'The Entra issuer gate''s verdict (plan §4.2): does this tenant permit this issuer — allowed or denied, nothing else enumerable. Pre-activation and deliberately unscoped — the gate runs before the membership question and must answer for identities with no membership row; the bound is the exact-organisation predicate, and anon never reaches it. A missing organization raises rather than answering denied.';

-- ---------------------------------------------------------------- 2. the invite claim (F05)
-- The one write in this file, and the one function here that is SECURITY DEFINER out of necessity:
-- `authenticated` holds no INSERT or UPDATE grant on `organisation_memberships` at all (pinned by 011
-- assertions 7-13 and re-pinned with a live session in the picture by 012 assertions 12 and 17), and
-- this PR does **not** add one. So the claim runs with the owner's privileges and its bound is inside
-- the body — the opposite trade from 017 assertion 7, which pins the two §3b reads as INVOKER because a
-- definer version of *those* would see rows the caller's RLS forbids.
create or replace function public.redeem_invitation_v1(
  p_organisation_id uuid,
  p_email text
) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_membership uuid;
  v_status text;
  v_profile_email text;
begin
  -- No tenant scope, by the same argument as `current_membership_v1` (ADR-0003 §3b, FAQ-0011's last
  -- paragraph): `set_tenant_scope` refuses any non-active member, and the whole point of this RPC is
  -- the step that turns an invited membership into an active one. The bound is the row set: `user_id`
  -- comes from `auth.uid()` and there is **no user argument**, so no caller — not the Worker, not
  -- anyone holding a token — can address another person's invitation. That is the property 012
  -- assertions 16-19 pinned in advance, where an active company2 member reaches for the invitation
  -- bound to `field2@company1.test` and comes back with nothing.
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if p_organisation_id is null then
    raise exception 'organization id is required' using errcode = '22023';
  end if;

  -- Shape before lookup, and the same canonical form `profiles.email` is CHECKed to
  -- (20261105060000_tenancy_core.sql:59). `signin-completion.ts:111` canonicalizes before it calls, so
  -- a non-canonical argument is a caller bug, and a raise is how it surfaces — not a silent
  -- near-match, and not the same answer as an address mismatch.
  if p_email is null or p_email <> lower(btrim(p_email)) or position(' ' in p_email) > 0 then
    raise exception 'address must be in canonical form' using errcode = '22023';
  end if;

  select m.id, m.status
    into v_membership, v_status
    from public.organisation_memberships m
   where m.organisation_id = p_organisation_id
     and m.user_id = v_user;

  -- "No invited row of mine in that tenant" covers three states at once — no row at all, a row that is
  -- already active, and a row that was suspended or removed — and says nothing about which, so the
  -- answer cannot be used to probe what a tenant's membership table holds. A `suspended` or `removed`
  -- row is **not** resurrected by a claim attempt: reinstating a departed member is an admin act
  -- (#179's `activate_membership_v1`, gated on `members.admin`), never something a signed-in user does
  -- to themselves.
  if v_membership is null or v_status <> 'invited' then
    return 'not_found';
  end if;

  -- The address binding. An invitation binds to a canonical `profiles.email`, so the claim checks the
  -- verified address the sign-in actually carried against that stored row — both sides canonical, so
  -- the comparison is exact and `canonicalEmail()` is the only place casing is handled (011 assertions
  -- 1-6 are why `v_profile_email` can be compared rather than normalized again).
  select pr.email into v_profile_email from public.profiles pr where pr.id = v_user;
  if v_profile_email is distinct from p_email then
    return 'email_mismatch';
  end if;

  -- Write-then-check rather than check-then-write: the `status = 'invited'` in the predicate closes the
  -- race against a second claim or against an admin activating the same row, and a zero-row update is
  -- reported as "this call claimed nothing" instead of as a claim that happened. The caller does not
  -- take a `redeemed` answer on trust either — `signin-completion.ts:159-162` re-reads the membership
  -- and access follows the row as it is now.
  update public.organisation_memberships
     set status = 'active',
         joined_at = now()
   where id = v_membership
     and status = 'invited';

  if not found then
    return 'not_found';
  end if;
  return 'redeemed';
end;
$$;

comment on function public.redeem_invitation_v1(uuid, text) is
  'F05: the invitee claiming their own invitation. SECURITY DEFINER because `authenticated` holds no write grant on organisation_memberships (011 tests 7-13), and bounded inside the body on auth.uid() — there is no user argument. Sets no tenant scope (ADR-0003 §3b: the claim is the step that makes an invited row active). Returns one of exactly three values: redeemed | not_found | email_mismatch; the caller re-reads the membership on redeemed rather than trusting this answer. A suspended or removed row is never resurrected; the admin activation path is #179.';

-- ---------------------------------------------------------------- 3. other-session revocation on a reset
-- In `toi_identity`, not `public`: it writes the session rows, and the schema is not in
-- `[api] schemas`, so it is reachable only over the `SESSION_DB` Hyperdrive carrier as
-- `toi_session_worker` (#75, ADR-0003 §3a). That is also why this one takes `p_user_id` where the two
-- `public` RPCs above refuse to: there is no JWT on this carrier and no `auth.uid()` to key on, which is
-- the same reason `insert_session_v1` and `authenticate_session_v1` name their subject. The Worker's
-- `userId` comes from the provider-verified identity, and the reset it serves is that same user's.
create or replace function toi_identity.revoke_user_sessions_v1(
  p_user_id uuid,
  p_host text,
  p_now timestamptz
) returns boolean
language plpgsql volatile security definer set search_path = toi_identity, pg_temp as $$
begin
  if p_user_id is null then
    raise exception 'a user id is required' using errcode = '22023';
  end if;
  if p_now is null then
    raise exception 'a timestamp is required' using errcode = '22023';
  end if;

  -- The host argument is held to the shape the stored column is CHECKed to
  -- (20261107024000_session_store.sql:64-68, and `resolve_tenant_host`'s rule at
  -- 20261105060000_tenancy_core.sql:238). This is not tidiness: the predicate below matches `host`
  -- exactly, so a stray space, a port or a case variant would revoke **nothing** — and this function's
  -- boolean would then report a revocation that never happened. Refusing the shape is what keeps
  -- `true` meaning "the revocation ran".
  if p_host is null
     or p_host <> lower(btrim(p_host))
     or p_host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9]))+$'
     or (length(p_host) - length(replace(p_host, '.', ''))) > 2 then
    raise exception 'host must be a normalized bare hostname' using errcode = '22023';
  end if;

  -- Every row this user still holds on **this host**, live or expired, not yet stamped. Expired rows
  -- are included on purpose: they authenticate nowhere either way (`authenticate_session_v1` requires
  -- `expires_at > p_now`), and taking them with the rest is what makes the state after this statement
  -- mean something to a support review. Already-revoked rows keep the instant they actually stopped
  -- working, which is why the predicate tests `revoked_at is null` instead of overwriting it.
  --
  -- Host-scoped, like every other session rule (ADR-0003 §2, §4): a reset on company1 cannot reach a
  -- company2 row, and 012 pins that a foreign-host row survives. Whether a credential change *should*
  -- also revoke this organization's other hosts (a `company1-staging` alias, a `www.` form) is an open
  -- question for the supervisor — this signature is the one PR-1 recorded, and it does not pre-empt
  -- that answer.
  update toi_identity.sessions
     set revoked_at = p_now
   where user_id = p_user_id
     and host = p_host
     and revoked_at is null;

  -- THE CONTRACT, and the reason 012 has an assertion for it: `true` means **the revocation ran**, not
  -- "it revoked at least one row". A user signing in for the first time has no other session to take
  -- down, and a reset that read zero rows as a failure would lock them out of their own account —
  -- `signin-completion.ts:143-148` refuses the completion on `false`, so a row-count answer would make
  -- the first-ever password reset uncompletable. Anything that goes wrong here raises and aborts the
  -- caller's transaction, which the adapter reports as a failed revocation and the handler answers with
  -- the same generic outcome as any other service fault; nothing in this function can both fail and
  -- return true.
  return true;
end;
$$;

comment on function toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz) is
  'The revocation a completed password reset owes: every session this user still holds on this host, stamped revoked_at and never un-stamped. TRUE means the revocation RAN, not that it revoked a row — a first-ever reset has none and must still complete. Host-scoped (ADR-0003 §2/§4); a malformed host raises 22023 rather than reporting a no-op as a success. Granted to toi_session_worker only.';

-- ---------------------------------------------------------------- 4. privileges (FAQ-0010)
-- PostgreSQL hands EXECUTE on every new function to PUBLIC and a migration cannot close that default
-- (001 tests 34-38 record why, and FAQ-0010 is the rule), so each function is revoked by full
-- signature in the file that creates it and granted back to exactly the role named.
revoke execute on function
  public.entra_issuer_allowed_v1(uuid, text),
  public.redeem_invitation_v1(uuid, text)
  from public, anon, authenticated, service_role;

-- Both are called with the **signed-in user's own token** (ADR-0003 §7: no service-role key on this
-- path), so `authenticated` is the only request role that needs them. `anon` gets neither: the host
-- resolver is the one pre-sign-in function the merged schema exposes, and neither of these runs before
-- a provider has verified somebody.
grant execute on function
  public.entra_issuer_allowed_v1(uuid, text),
  public.redeem_invitation_v1(uuid, text)
  to authenticated;

revoke execute on function
  toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

-- The sixth function on the session carrier, against ADR-0003 §3a's decided grant of "the five
-- *_session_v1 functions" — flagged for the supervisor in the PR body, and 016 test 16 is updated to
-- name it rather than left to fail. No request role reaches it (001 test 33 pins that, and it stays
-- pinned), and no table is granted to anyone: the function is definer with a pinned search_path, like
-- the five beside it.
grant execute on function
  toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz)
  to toi_session_worker;
