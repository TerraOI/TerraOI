-- T-201 (PR-1) · slot 012 · the sign-in methods' SQL invariants.
--
-- This file pins the half of the packet's negative acceptance items the merged schema can already
-- answer: **a `suspended` or `removed` membership cannot scope to the tenant (28000) even with a valid
-- session and the right organization id**, **a link or invite replayed against company2 creates
-- nothing**, and **an invitation bound to one address (`field2@company1.test`) cannot be claimed by
-- another** — including by an active member of the same tenant who can legitimately scope it.
--
-- The first is a cross-product no earlier suite reaches. 010_tenancy proves a suspended membership
-- cannot scope (its assertion 25) and 011_identity proves `invited` and `removed` cannot either — both
-- with no session in sight. 014_identity_session proves a revoked or foreign-host session does not
-- authenticate, with no membership question at all. Here a *live, correctly-hosted, unrevoked* session
-- row exists for each deactivated member and authenticates, and the tenant answer is still 28000: the
-- session proves who signed in, never whether they may be here (ADR-0003 §7, F02).
--
-- The second half is the data-level fact a claim RPC must preserve. 011 pins the *grants* (no
-- INSERT/UPDATE/DELETE for `authenticated` on organisation_memberships); what is pinned here is that
-- nothing in the data moved after a replay — the count that PR-2's `redeem_invitation_v1` will be held
-- to. The write attempts are captured, and the assertion is about their effect ("no write succeeded"),
-- not about which mechanism stopped them, so the check does not depend on whether the grant or the
-- policy answered first.
--
-- Not named here: the invite-claim RPC, the password-reset bookkeeping and the per-tenant Entra issuer
-- policy. None is in the merged schema, so their assertions join this file in PR-2
-- (t-201b-invite-reset-sql) together with the migration that creates them, and any request-role grant
-- goes onto 001's allow-list in that same PR (FAQ-0010).
--
-- pgTAP cannot run on a builder machine (FAQ-0009): CI's `database` job is the venue for every number
-- below, and the plan count here is a claim CI checks, not local evidence. Fixtures are synthetic and
-- live inside this transaction, which rolls back; `supabase/seed.sql` is untouched (AGENTS.md §4.7).
-- Seeded ids: company1 = 1111…1111 (host company1.terraoi.app), its owner …0a1, its suspended former
-- member …0a3; company2 = 2222…2222 and its owner …0b1.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

-- ---------------------------------------------------------------- fixtures, in this transaction only
-- `removed` is a status the merged check constraint allows and no seeded row holds, so it is created
-- here rather than imagined by the code.
insert into public.organisation_memberships (organisation_id, user_id, status, joined_at)
values ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000b1', 'removed', now())
on conflict (organisation_id, user_id) do nothing;

-- company1's owner is only *invited* in company2: the row an invite replay would try to claim.
insert into public.organisation_memberships (organisation_id, user_id, status, joined_at)
values ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a1', 'invited', null)
on conflict (organisation_id, user_id) do nothing;

-- An invitation **bound to field2@company1.test** (seeded …0a2): the row the packet's box names. It is
-- company2's to claim, and the person who tries below is `multi@example.test` (…0a4) — seeded as an
-- *active* company2 member, so the refusal is about the row and not about tenancy.
insert into public.organisation_memberships (organisation_id, user_id, status, joined_at)
values ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a2', 'invited', null)
on conflict (organisation_id, user_id) do nothing;

-- Live session rows for the two deactivated members, issued on the host they will try to use. Key and
-- ciphertext shapes are what the columns require; 014 assertions 40–41 already proved the envelope
-- CHECK has teeth, so the pair here is envelope-shaped on purpose.
insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, key_version,
   access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
values
  ('t201susp' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a3', 'company1.terraoi.app',
   timestamptz '2026-11-14 11:00:00+00', timestamptz '2026-11-14 19:00:00+00', 'v1',
   'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
   'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
   timestamptz '2026-11-14 12:00:00+00'),
  ('t201rm' || repeat('A', 37), '00000000-0000-4000-8000-0000000000b1', 'company1.terraoi.app',
   timestamptz '2026-11-14 11:00:00+00', timestamptz '2026-11-14 19:00:00+00', 'v1',
   'v1.AAAAAAAAAAAAAAAA.EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
   'v1.CCCCCCCCCCCCCCCC.FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
   timestamptz '2026-11-14 12:00:00+00');

-- ---------------------------------------------------------------- helpers (the 010/017 pattern)
-- A refusal is reported as its SQLSTATE instead of aborting the test transaction, and every helper runs
-- with the privileges of the role under test (SECURITY INVOKER) with every relation named in full.
create function pg_temp.try_scope(p_organisation_id uuid) returns text
language plpgsql security invoker set search_path = pg_temp as $fn$
begin
  begin
    perform public.set_tenant_scope(p_organisation_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.is_member(p_organisation_id uuid) returns text
language sql security invoker set search_path = pg_temp as $fn$
  select coalesce(public.is_active_member(p_organisation_id)::text, 'null');
$fn$;

-- The scope is read in the same transaction as the attempt and while still under the role under test:
-- `set_config(..., is_local => true)` ends with the transaction, which is the point of FAQ-0011.
create function pg_temp.scope_now() returns text
language sql security invoker set search_path = pg_temp as $fn$
  select coalesce(public.current_organisation_id()::text, 'none');
$fn$;

create function pg_temp.auth_count(p_session_key text, p_host text, p_now timestamptz) returns integer
language plpgsql security invoker set search_path = pg_temp as $fn$
declare v integer;
begin
  select count(*)::int into v from toi_identity.authenticate_session_v1(p_session_key, p_host, p_now);
  return v;
end;
$fn$;

-- What a claim replay would try, written the way the PR-2 RPC will have to write it: promote the row
-- this user already holds in that tenant, or add one. Reported as a refusal, or as the rows written.
create function pg_temp.try_promote(p_organisation_id uuid, p_user_id uuid) returns text
language plpgsql security invoker set search_path = pg_temp as $fn$
begin
  begin
    update public.organisation_memberships
       set status = 'active', joined_at = now()
     where organisation_id = p_organisation_id and user_id = p_user_id;
    return 'wrote:' || sql_rowcount::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_add(p_organisation_id uuid, p_user_id uuid) returns text
language plpgsql security invoker set search_path = pg_temp as $fn$
begin
  begin
    insert into public.organisation_memberships (organisation_id, user_id, status)
    values (p_organisation_id, p_user_id, 'active');
    return 'wrote:' || sql_rowcount::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Counts are taken by the migration owner, because RLS bounds what a member can count; the attempts
-- themselves run as the role under test.
create temp table t_counts (phase text, what text, n integer);
insert into t_counts
  select 'before', 'memberships_c2', count(*)::int from public.organisation_memberships
   where organisation_id = '22222222-2222-4222-8222-222222222222';
insert into t_counts
  select 'before', 'profiles', count(*)::int from public.profiles;

-- ----------------------------------- 1–5: a live session and a suspended membership in company1
select is(
  pg_temp.auth_count('t201susp' || repeat('A', 35), 'company1.terraoi.app', timestamptz '2026-11-14 11:30:00+00'),
  1::int,
  '1 the suspended member''s session row authenticates on its own host: the session half of the case holds');

select is(
  (select count(*)::int from toi_identity.sessions
    where session_key = 't201susp' || repeat('A', 35) and revoked_at is null),
  1::int,
  '2 and that session is not revoked, so the refusals below are about membership and not about a dead row');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
create temp table t_a3 (case_name text, result text);
insert into t_a3 values
  ('scope_c1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111')),
  ('scope_after', pg_temp.scope_now()),
  ('is_member', pg_temp.is_member('11111111-1111-4111-8111-111111111111'));
reset role;

select is((select result from t_a3 where case_name = 'scope_c1'), '28000',
  '3 a valid session and the right organization id still cannot scope for a suspended membership (§4.2)');
select is((select result from t_a3 where case_name = 'scope_after'), 'none',
  '4 the refused attempt set no scope, so nothing later in the transaction can read it as authorization');
select is((select result from t_a3 where case_name = 'is_member'), 'false',
  '5 the policy predicate agrees: a suspended membership is not an active member, so RLS says the same');

-- ----------------------------------- 6–8: a live session and a removed membership in company1
select is(
  pg_temp.auth_count('t201rm' || repeat('A', 37), 'company1.terraoi.app', timestamptz '2026-11-14 11:30:00+00'),
  1::int,
  '6 the removed member''s session is live too: removing a membership does not delete the session it minted');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
create temp table t_b1 (case_name text, result text);
insert into t_b1 values
  ('scope_c1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111')),
  ('is_member', pg_temp.is_member('11111111-1111-4111-8111-111111111111'));
reset role;

select is((select result from t_b1 where case_name = 'scope_c1'), '28000',
  '7 a removed membership cannot scope either, live session and correct organization id in hand');
select is((select result from t_b1 where case_name = 'is_member'), 'false',
  '8 `removed` is not active in the policy predicate, so the scope rule and RLS refuse the same people');

-- ----------------------------------- 9: one profile per identity, whatever the provider says
-- A verified Entra identity links to an existing profile; it cannot mint a second one for the same
-- identity, because the profile row's whole key *is* the identity id. Read from the catalog rather than
-- through a pgTAP constraint helper, so the check cannot pass by the constraint having gone missing.
select is(
  (select string_agg(a.attname, ',' order by a.attnum)
     from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
    where n.nspname = 'public' and c.relname = 'profiles' and i.indisprimary),
  'id',
  '9 public.profiles'' primary key is exactly the identity id: one identity, one profile row (§4.2)');

-- ----------------------------------- 10–15: a claim replayed against company2 creates nothing
-- The fixture first: without an invited row in company2 to replay against, the count checks below would
-- pass because there was nothing to replay.
select is(
  (select count(*)::int from public.organisation_memberships
    where organisation_id = '22222222-2222-4222-8222-222222222222'
      and user_id = '00000000-0000-4000-8000-0000000000a1'
      and status = 'invited'),
  1::int,
  '10 (fixture) company1''s owner really does hold an invited row in company2 to replay against');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create temp table t_replay (case_name text, result text);
insert into t_replay values
  ('scope_c2', pg_temp.try_scope('22222222-2222-4222-8222-222222222222')),
  ('promote_own', pg_temp.try_promote('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a1')),
  ('add_self', pg_temp.try_add('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a1')),
  ('add_other', pg_temp.try_add('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a3'));
reset role;

insert into t_counts
  select 'after', 'memberships_c2', count(*)::int from public.organisation_memberships
   where organisation_id = '22222222-2222-4222-8222-222222222222';
insert into t_counts
  select 'after', 'profiles', count(*)::int from public.profiles;

select is((select result from t_replay where case_name = 'scope_c2'), '28000',
  '11 the replay could not even take a scope in company2: invited is not active, in that tenant or any other');

select is(
  (select count(*)::int from t_replay where result like 'wrote:%'),
  0::int,
  '12 none of the writes a claim replay attempts got through, whoever stopped them (§4.2)');

select is(
  (select n from t_counts where phase = 'after' and what = 'memberships_c2'),
  (select n from t_counts where phase = 'before' and what = 'memberships_c2'),
  '13 company2 has exactly the membership rows it had: the replay created nothing');

select is(
  (select status from public.organisation_memberships
    where organisation_id = '22222222-2222-4222-8222-222222222222'
      and user_id = '00000000-0000-4000-8000-0000000000a1'),
  'invited',
  '14 and the row it tried to promote is still invited: a replay cannot claim an invitation');

select is(
  (select n from t_counts where phase = 'after' and what = 'profiles'),
  (select n from t_counts where phase = 'before' and what = 'profiles'),
  '15 and no profile row appeared either: a replayed link cannot mint an identity record (§4.2)');

-- ----------------------------------- 16–19: an invite bound to one address cannot be claimed by another
-- The attacker here is not an outsider: `multi@example.test` is an active member of company2 and can
-- take its scope. So the refusal below is about *whose* invitation it is, which is exactly the rule
-- PR-2's claim RPC has to preserve by keying on `auth.uid()` rather than on an address it is handed.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
create temp table t_other (case_name text, result text);
insert into t_other values
  ('scope_c2', pg_temp.try_scope('22222222-2222-4222-8222-222222222222')),
  ('promote_field2', pg_temp.try_promote('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a2')),
  ('add_for_field2', pg_temp.try_add('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a2'));
reset role;

insert into t_counts
  select 'after_other', 'memberships_c2', count(*)::int from public.organisation_memberships
   where organisation_id = '22222222-2222-4222-8222-222222222222';

select is((select result from t_other where case_name = 'scope_c2'), 'ok',
  '16 (non-vacuity) the person attempting the claim is an active company2 member and can scope it: the refusals below are not about tenancy');
select is(
  (select count(*)::int from t_other where result like 'wrote:%'),
  0::int,
  '17 a different address in the same tenant cannot activate or duplicate the invitation bound to field2@company1.test (§4.2)');
select is(
  (select status from public.organisation_memberships
    where organisation_id = '22222222-2222-4222-8222-222222222222'
      and user_id = '00000000-0000-4000-8000-0000000000a2'),
  'invited',
  '18 field2''s invitation is still invited after someone else tried to claim it: only the invited identity may redeem it, and only through PR-2''s RPC');
select is(
  (select n from t_counts where phase = 'after_other' and what = 'memberships_c2'),
  (select n from t_counts where phase = 'before' and what = 'memberships_c2'),
  '19 and company2 still has exactly the membership rows it started with: a claim attempt by another address creates nothing');

select * from finish();
rollback;
