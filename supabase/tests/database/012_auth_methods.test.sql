-- T-201 · slot 012 · the sign-in methods' SQL invariants.
--
-- 1-19 are PR-1's (#181): the rules the merged schema could already answer. 20 onward name the three
-- objects PR-2's migration `20261115060000_identity_methods.sql` adds — the invite-claim RPC, the
-- per-tenant Entra issuer policy and its read, and the other-session revocation a completed password
-- reset owes — exactly as this file's header said they would when the slot was opened.
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
-- How to read those assertions honestly: `set_tenant_scope` consults `auth.uid()` and
-- `is_active_member` and never reads `toi_identity.sessions` (20261105060000_tenancy_core.sql:203-220),
-- and that separation is the claim, not an accident. So the session rows are what assertions 1 and 6
-- establish — a live, unrevoked, right-host session for each deactivated member, which is the state the
-- Worker's own session check accepts — and 3, 5, 7 and 8 then say the tenant answer does not change.
-- Delete the session fixtures and 1 and 6 fail; that is the pair's job.
--
-- Which assertions are new, and which are deliberate re-pins: 1, 6 (the session half) and 9 (the
-- profiles primary key — the first PK assertion in `supabase/tests/`) are new. 3, 4, 5, 7, 8, 11 and
-- 14 re-pin 010/011/017 rules *in the shape this packet's sign-in paths produce*, with a live session in
-- the picture; they are regression cover, not new mechanism. 10, 13, 15 and 19 are count-and-status
-- controls whose whole purpose is to say "nothing moved". 16 is a non-vacuity control for 17-19.
--
-- The second half is the data-level fact a claim RPC must preserve. 011 pins the *grants* (no
-- INSERT/UPDATE/DELETE for `authenticated` on organisation_memberships); what is pinned here is that
-- nothing in the data moved after a replay — the count PR-2's `redeem_invitation_v1` is held to below
-- (25-38). The write attempts are captured, and the assertion is about their effect ("no write succeeded"),
-- not about which mechanism stopped them, so the check does not depend on whether the grant or the
-- policy answered first.
--
-- What PR-2 adds below, in one sentence each:
--   * **the claim RPC** (`public.redeem_invitation_v1`) — 20-38. Its shape is the security property: no
--     user argument, `auth.uid()` only, so the attempts 16-19 pinned as *refused writes* now have an
--     honest path and still come back with nothing (34-35). Its address binding is a canonical
--     `profiles.email` comparison (32-33, 37), a caller with no subject is refused rather than answered
--     (38), and it sets no tenant scope of its own (29), which is the ADR-0003 §3b carve-out doing work
--     rather than being cited.
--   * **the issuer policy** (`public.tenant_entra_issuers` and its read) — 39-51. An allow-list with
--     nothing in it answers "empty", never "everything"; an organization that does not exist raises;
--     the table itself stays shut to both request roles (46-47, the per-table default-privilege trap
--     `20261107024000_session_store.sql:227` names for its own schema); and a stored issuer in a
--     non-canonical form is refused, because `entra-linking.ts:37` matches exactly and a variant would
--     look configured while never matching (49-50).
--   * **the revocation** (`toi_identity.revoke_user_sessions_v1`) — 52-68. The load-bearing one is
--     57-58: a user with **no** other session at all gets `true`, because this function's boolean means
--     "the revocation ran" and `signin-completion.ts:143-148` refuses the reset on `false`. Read 58 with
--     60-61, where a malformed host is *refused* instead of reported as a successful no-op: together
--     they are what stops `true` from meaning "the UPDATE statement matched something somewhere". And
--     68 is the same claim from the other side — the session a reset mints survives it, because the
--     Worker revokes before it issues.
--
-- pgTAP cannot run on a builder machine (FAQ-0009): CI's `database` job is the venue for every number
-- below, and the plan count here is a claim CI checks, not local evidence. Fixtures are synthetic and
-- live inside this transaction, which rolls back; `supabase/seed.sql` is untouched (AGENTS.md §4.7).
-- Seeded ids: company1 = 1111…1111 (host company1.terraoi.app), its owner …0a1, its suspended former
-- member …0a3; company2 = 2222…2222 and its owner …0b1.
begin;
create extension if not exists pgtap with schema extensions;

-- 19 in PR-1; 68 with the three objects PR-2's migration adds. CI checks this number against the
-- assertions that actually run (FAQ-0009: pgTAP cannot run on a builder machine).
select plan(68);

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

-- Pinned to the SQLSTATE, not merely to "nothing was written": a broken helper, a missing table and a
-- refused privilege would all leave `wrote:%` absent. 011 assertion 13 carries the teeth that prove the
-- grant is the guard (grant UPDATE, the same write succeeds, savepoint rolled back), so that is not
-- restated here.
select is(
  (select string_agg(result, ',' order by case_name) from t_replay
    where case_name in ('promote_own', 'add_self', 'add_other')),
  '42501,42501,42501',
  '12 each write a claim replay attempts is refused with 42501: `authenticated` holds no INSERT or UPDATE grant on organisation_memberships (§4.2)');

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
-- The two write attempts first, and the successful scope **last**: `set_tenant_scope` sets
-- `app.organisation_id` transaction-locally, so a scope that succeeds is left standing for the rest of
-- the transaction. Putting it last means nothing else in this file runs under a scope this file created
-- (010's discipline for a *refused* attempt was "the refusal set no scope"; here the point is the
-- opposite — the attempt is allowed to scope, and that is exactly why it must come after).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
create temp table t_other (case_name text, result text);
insert into t_other values
  ('promote_field2', pg_temp.try_promote('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a2')),
  ('add_for_field2', pg_temp.try_add('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a2')),
  ('scope_c2', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
reset role;

insert into t_counts
  select 'after_other', 'memberships_c2', count(*)::int from public.organisation_memberships
   where organisation_id = '22222222-2222-4222-8222-222222222222';

select is((select result from t_other where case_name = 'scope_c2'), 'ok',
  '16 (non-vacuity) the person attempting the claim is an active company2 member and can scope it: the refusals below are not about tenancy');
select is(
  (select string_agg(result, ',' order by case_name) from t_other
    where case_name in ('promote_field2', 'add_for_field2')),
  '42501,42501',
  '17 a different address in the same tenant cannot activate or duplicate the invitation bound to field2@company1.test, and it is the missing grant that says so (42501) (§4.2)');
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

-- ================================================================= PR-2: the three new objects
-- Fixtures for the claim and revocation cases, in this transaction only. `…0c1` is a synthetic invitee
-- whose invitation has not been claimed; `…0c2` deliberately has **no `profiles` row**, which is what
-- makes assertion 60 a statement about what the revocation does *not* touch. Session keys and ciphertext
-- shapes are what `20261107024000_session_store.sql:55,84-89` require; 014 assertions 40-41 already
-- proved that envelope CHECK has teeth, so the pair here is envelope-shaped, not real.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'invited@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Synthetic Invitee"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'nosessions@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Synthetic First-Time Reset"}'::jsonb)
on conflict (id) do nothing;

insert into public.profiles (id, email, display_name) values
  ('00000000-0000-4000-8000-0000000000c1', 'invited@company1.test', 'Synthetic Invitee')
on conflict (id) do nothing;

insert into public.organisation_memberships (organisation_id, user_id, status)
values ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000c1', 'invited')
on conflict (organisation_id, user_id) do nothing;

-- Two permitted Entra tenants for company1, none for company2, and one for company2 that must never
-- appear in company1's answer. These are invented uuids (AGENTS.md §4.7): a real customer's Entra
-- tenant id does not belong in this repository, and `supabase/seed.sql` gains no issuer row for the
-- same reason — populating a real one is an owner step, named in the PR body.
insert into public.tenant_entra_issuers (organisation_id, issuer_tenant_id) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('22222222-2222-4222-8222-222222222222', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
on conflict (organisation_id, issuer_tenant_id) do nothing;

-- The five session rows for …0c1 on two hosts: two live, one expired-but-never-revoked, one
-- already-revoked at an earlier instant, and one issued on the **other** tenant's host.
insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, revoked_at, key_version,
   access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
values
  ('t201rv1a' || repeat('A', 35), '00000000-0000-4000-8000-0000000000c1', 'company1.terraoi.app',
   timestamptz '2026-11-14 11:00:00+00', timestamptz '2026-11-14 19:00:00+00', null, 'v1',
   'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
   'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
   timestamptz '2026-11-14 12:00:00+00'),
  ('t201rv2a' || repeat('B', 35), '00000000-0000-4000-8000-0000000000c1', 'company1.terraoi.app',
   timestamptz '2026-11-14 11:15:00+00', timestamptz '2026-11-14 19:00:00+00', null, 'v1',
   'v1.AAAAAAAAAAAAAAAA.EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
   'v1.CCCCCCCCCCCCCCCC.FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
   timestamptz '2026-11-14 12:00:00+00'),
  ('t201rvxa' || repeat('C', 35), '00000000-0000-4000-8000-0000000000c1', 'company1.terraoi.app',
   timestamptz '2026-11-14 01:00:00+00', timestamptz '2026-11-14 09:00:00+00', null, 'v1',
   'v1.AAAAAAAAAAAAAAAA.GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
   'v1.CCCCCCCCCCCCCCCC.HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
   timestamptz '2026-11-14 02:00:00+00'),
  ('t201rvra' || repeat('D', 35), '00000000-0000-4000-8000-0000000000c1', 'company1.terraoi.app',
   timestamptz '2026-11-14 05:00:00+00', timestamptz '2026-11-14 13:00:00+00',
   timestamptz '2026-11-14 06:00:00+00', 'v1',
   'v1.AAAAAAAAAAAAAAAA.IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
   'v1.CCCCCCCCCCCCCCCC.JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ',
   timestamptz '2026-11-14 06:00:00+00'),
  ('t201rvfa' || repeat('E', 35), '00000000-0000-4000-8000-0000000000c1', 'company2.terraoi.app',
   timestamptz '2026-11-14 11:00:00+00', timestamptz '2026-11-14 19:00:00+00', null, 'v1',
   'v1.AAAAAAAAAAAAAAAA.KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
   'v1.CCCCCCCCCCCCCCCC.LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL',
   timestamptz '2026-11-14 12:00:00+00');

-- Helpers, same shape as the ones above: report a refusal as its SQLSTATE rather than aborting the
-- transaction, run as the role under test, and name every relation in full.
create function pg_temp.try_claim(p_organisation_id uuid, p_email text) returns text
language plpgsql security invoker set search_path = pg_temp as $fn$
begin
  begin
    return public.redeem_invitation_v1(p_organisation_id, p_email);
  exception when others then
    return 'sqlstate:' || sqlstate::text;
  end;
end;
$fn$;

-- `(empty)` and `(null)` are the two answers the port must never confuse: an empty allow-list refuses
-- Entra sign-ins for that tenant, and a policy that cannot be read refuses them too but says why.
create function pg_temp.try_issuers(p_organisation_id uuid) returns text
language plpgsql security invoker set search_path = pg_temp as $fn$
declare v text[];
begin
  begin
    select public.entra_allowed_issuers_v1(p_organisation_id) into v;
    if v is null then return '(null)'; end if;
    if array_length(v, 1) is null then return '(empty)'; end if;
    return array_to_string(v, ',');
  exception when others then
    return 'sqlstate:' || sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_issuer_write(p_organisation_id uuid, p_issuer text) returns text
language plpgsql security invoker set search_path = pg_temp as $fn$
begin
  begin
    insert into public.tenant_entra_issuers (organisation_id, issuer_tenant_id)
    values (p_organisation_id, p_issuer);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_revoke(p_user_id uuid, p_host text, p_now timestamptz) returns text
language plpgsql security invoker set search_path = pg_temp as $fn$
declare v boolean;
begin
  begin
    select toi_identity.revoke_user_sessions_v1(p_user_id, p_host, p_now) into v;
    return coalesce(v::text, '(null)');
  exception when others then
    return 'sqlstate:' || sqlstate::text;
  end;
end;
$fn$;

-- The revocation's own effect table: counts, not booleans, so an assertion that says "nothing changed"
-- has a number to name.
create temp table t_rev (phase text, what text, n integer);

-- ----------------------------------- 20-24: the claim RPC's shape and privileges (FAQ-0010)
select is(has_function_privilege('anon', 'public.redeem_invitation_v1(uuid, text)', 'execute'), false,
  '20 anon cannot execute the claim RPC: it is keyed to auth.uid(), so an anonymous caller has no uid to claim with (§4.2)');
select is(has_function_privilege('service_role', 'public.redeem_invitation_v1(uuid, text)', 'execute'), false,
  '21 service_role holds no grant on the claim RPC either: the sign-in path never uses a privileged key (ADR-0003 §7)');
select ok(has_function_privilege('authenticated', 'public.redeem_invitation_v1(uuid, text)', 'execute'),
  '22 authenticated can execute the claim RPC, and 001 test 32 names it on the allow-list (FAQ-0010)');

select is(
  pg_get_function_identity_arguments('public.redeem_invitation_v1(uuid, text)'::regprocedure),
  'p_organisation_id uuid, p_email text',
  '23 the claim RPC takes the tenant and the verified address, and no argument can name another user (ADR-0003 §3b)');

select ok(
  exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'redeem_invitation_v1' and p.prosecdef
  ),
  '24 the claim RPC is SECURITY DEFINER because the write it performs has no grant for `authenticated` — 011 tests 7-9 pin the absent grant, 12 above re-pins it with a live session in the picture, and this PR does not add one; the bound is inside the body');

-- ----------------------------------- 25-31: an invitee claiming their own invitation
select is(
  (select count(*)::int from public.organisation_memberships
    where organisation_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '00000000-0000-4000-8000-0000000000c1'
      and status = 'invited' and joined_at is null),
  1::int,
  '25 (fixture) the synthetic invitee holds exactly one unclaimed invited row in company1');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1';
create temp table t_claim (case_name text, result text);
insert into t_claim values
  ('scope_before', pg_temp.scope_now()),
  ('claim', pg_temp.try_claim('11111111-1111-4111-8111-111111111111', 'invited@company1.test')),
  ('scope_after', pg_temp.scope_now());
reset role;

select is((select result from t_claim where case_name = 'claim'), 'redeemed',
  '26 the invited identity claiming with the address the provider verified gets `redeemed` (F05, §4.2)');
select is(
  (select status from public.organisation_memberships
    where organisation_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '00000000-0000-4000-8000-0000000000c1'),
  'active',
  '27 and the row is active: the claim is the step that turns an invitation into a membership');
select ok(
  (select joined_at is not null from public.organisation_memberships
    where organisation_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '00000000-0000-4000-8000-0000000000c1'),
  '28 the claim records when the member joined, so the row says what happened and not only what it is now');
select is((select result from t_claim where case_name = 'scope_after'),
  (select result from t_claim where case_name = 'scope_before'),
  '29 the claim set no tenant scope of its own: `set_tenant_scope` refuses an invited membership, which is why this RPC is the §3b carve-out and not a FAQ-0011 scoped write');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1';
insert into t_claim values
  ('claim_again', pg_temp.try_claim('11111111-1111-4111-8111-111111111111', 'invited@company1.test'));
reset role;

select is((select result from t_claim where case_name = 'claim_again'), 'not_found',
  '30 a second claim by the same identity claims nothing: an active row is not an invitation, and an ended membership is never resurrected by a claim attempt');
select is(
  (select joined_at from public.organisation_memberships
    where organisation_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '00000000-0000-4000-8000-0000000000c1'),
  (select joined_at from public.organisation_memberships
    where organisation_id = '11111111-1111-4111-8111-111111111111'
      and user_id = '00000000-0000-4000-8000-0000000000c1'),
  '31 (non-vacuity) the row a replay cannot re-claim still carries one join instant, so 30 is about the second call writing nothing rather than about a row that moved twice');

-- ----------------------------------- 32-38: the address binding, and the packet's own negative box
-- …0a2 holds the invited company2 row PR-1 created at the top of this file, bound to
-- `field2@company1.test`; …0a4 is an active company2 member who can take its scope. So 34-35 re-run
-- exactly the attempt 17-19 refused as a raw write, now through the RPC that is allowed to write.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_claim values
  ('claim_wrong_address', pg_temp.try_claim('22222222-2222-4222-8222-222222222222', 'multi@example.test'));
reset role;

select is((select result from t_claim where case_name = 'claim_wrong_address'), 'email_mismatch',
  '32 an invitation bound to field2@company1.test cannot be claimed under another address: the binding is the caller''s canonical profiles.email, compared exactly (§4.2)');
select is(
  (select status from public.organisation_memberships
    where organisation_id = '22222222-2222-4222-8222-222222222222'
      and user_id = '00000000-0000-4000-8000-0000000000a2'),
  'invited',
  '33 and that invitation is still unclaimed after the mismatched attempt');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
insert into t_claim values
  ('claim_as_other_member', pg_temp.try_claim('22222222-2222-4222-8222-222222222222', 'multi@example.test'));
reset role;

select is((select result from t_claim where case_name = 'claim_as_other_member'), 'not_found',
  '34 a different address in the same tenant cannot claim the invitation bound to field2@company1.test, now through the RPC that really can write: it is keyed on auth.uid(), not on the address it is handed (§4.2)');
select is(
  (select status from public.organisation_memberships
    where organisation_id = '22222222-2222-4222-8222-222222222222'
      and user_id = '00000000-0000-4000-8000-0000000000a2'),
  'invited',
  '35 field2''s invitation is untouched by that attempt: 17-19 stopped it as a write, 34-35 stop it as a claim');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1';
insert into t_claim values
  ('claim_other_tenant', pg_temp.try_claim('22222222-2222-4222-8222-222222222222', 'invited@company1.test'));
reset role;

select is((select result from t_claim where case_name = 'claim_other_tenant'), 'not_found',
  '36 the same identity claiming in a tenant where it holds no row claims nothing: a link replayed against company2 creates nothing (the packet''s negative box, at the RPC)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1';
insert into t_claim values
  ('claim_noncanonical', pg_temp.try_claim('11111111-1111-4111-8111-111111111111', 'Invited@Company1.TEST'));
reset role;

select is((select result from t_claim where case_name = 'claim_noncanonical'), 'sqlstate:22023',
  '37 a non-canonical address is refused by shape before any row is read, rather than answered as a mismatch: canonicalEmail() runs upstream, and anything else is a caller bug');

-- The uid branch, at runtime: `auth.uid()` reads the same GUC the other suites set (010/011/017), and a
-- token that carries no subject has no invitation to claim. This is the whole bound of the RPC failing
-- open — nothing is claimed, and the refusal is a raise, not an empty answer.
set local role authenticated;
set local request.jwt.claim.sub = '';
insert into t_claim values ('claim_no_uid', pg_temp.try_claim('11111111-1111-4111-8111-111111111111', 'invited@company1.test'));
reset role;

select is((select result from t_claim where case_name = 'claim_no_uid'), 'sqlstate:28000',
  '38 a caller with no auth.uid() is refused with 28000 rather than answered with a claim: the RPC''s only bound is the subject, so a request without one gets nothing (§4.2)');

-- ----------------------------------- 39-51: the per-tenant Entra issuer policy
select is(has_function_privilege('anon', 'public.entra_allowed_issuers_v1(uuid)', 'execute'), false,
  '39 anon cannot read a tenant''s Entra allow-list: the gate runs only after a provider has verified somebody (§4.1)');
select is(has_function_privilege('service_role', 'public.entra_allowed_issuers_v1(uuid)', 'execute'), false,
  '40 service_role holds no grant on the issuer read either (FAQ-0010)');
select ok(has_function_privilege('authenticated', 'public.entra_allowed_issuers_v1(uuid)', 'execute'),
  '41 authenticated can read it: an Entra identity with no membership row in this tenant still has to be put through the issuer gate (plan §4.2, the packet''s no-access case)');

select is(
  pg_get_function_identity_arguments('public.entra_allowed_issuers_v1(uuid)'::regprocedure),
  'p_organisation_id uuid',
  '42 the issuer read takes one argument: the tenant, which the Worker took from the routed host and never from the request (§4.1)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
create temp table t_issuers (case_name text, result text);
insert into t_issuers values
  ('c1', pg_temp.try_issuers('11111111-1111-4111-8111-111111111111')),
  ('c2', pg_temp.try_issuers('22222222-2222-4222-8222-222222222222')),
  ('missing', pg_temp.try_issuers('33333333-3333-4333-8333-333333333333'));
reset role;

select is((select result from t_issuers where case_name = 'c1'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '43 a tenant''s own list comes back in full and ordered, and company2''s issuer is not in it: the read is bounded to one organization (§4.2)');
select is((select result from t_issuers where case_name = 'c2'), '(empty)',
  '44 a tenant that has configured nothing answers empty, never null: empty means no permitted issuer, which is a refusal, not a wildcard (entra-linking.ts:24)');
select is((select result from t_issuers where case_name = 'missing'), 'sqlstate:28000',
  '45 an organization that does not exist is refused rather than answered with an empty list: a mis-provisioned tenant must not look like one that has deliberately allowed nothing');

select is(has_table_privilege('anon', 'public.tenant_entra_issuers', 'select'), false,
  '46 anon cannot select the issuer table: a new table in public may arrive with default privileges, so this is revoked per-table and not left to the merged blanket revoke (§4.2)');
select is(has_table_privilege('authenticated', 'public.tenant_entra_issuers', 'select'), false,
  '47 nor can authenticated: the RPC is the only path to this table, which is what plan §4.3 asks of a tenant table');
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.tenant_entra_issuers'::regclass)
  and not exists (select 1 from pg_policies where tablename = 'tenant_entra_issuers'),
  '48 RLS is enabled on it with no policy of any kind: there is nothing to widen by accident, and the definer read is the deliberate exception');

insert into t_issuers values
  ('uppercase', pg_temp.try_issuer_write('11111111-1111-4111-8111-111111111111', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')),
  ('canonical', pg_temp.try_issuer_write('11111111-1111-4111-8111-111111111111', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'));

select is((select result from t_issuers where case_name = 'uppercase'), '23514',
  '49 an issuer id in a non-canonical form cannot be stored: entra-linking.ts:37 matches exactly, so a stored variant would look configured and never match (§4.2)');
select is((select result from t_issuers where case_name = 'canonical'), 'ok',
  '50 control: the canonical form writes cleanly, so 49 is about the casing and not about the insert');

select ok(
  exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'entra_allowed_issuers_v1' and p.prosecdef
  ),
  '51 the issuer read is SECURITY DEFINER, which is the opposite trade to 017 test 7 and a deliberate one: the table has no policy, so an INVOKER read would answer "empty" to everyone and refuse every Entra sign-in plausibly instead of visibly');

-- ----------------------------------- 52-59: the revocation's shape, privileges and the first-ever case
select is(has_function_privilege('anon', 'toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz)', 'execute'), false,
  '52 anon cannot execute the revocation: it lives in the schema the Data API does not expose (§4.2)');
select is(has_function_privilege('authenticated', 'toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz)', 'execute'), false,
  '53 nor can a signed-in user: no request role reaches the session carrier, and 001 test 33 keeps it that way');
select is(has_function_privilege('service_role', 'toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz)', 'execute'), false,
  '54 service_role holds no grant here either (FAQ-0010)');
select ok(has_function_privilege('toi_session_worker', 'toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz)', 'execute'),
  '55 toi_session_worker can execute it: this is the carrier the Worker signs a reset with (#75), and the grant set ADR-0003 §3a fixed at five functions is the supervisor''s to widen — named in the PR body');

select is(
  pg_get_function_identity_arguments('toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz)'::regprocedure),
  'p_user_id uuid, p_host text, p_now timestamptz',
  '56 the revocation names its subject, its host and its instant: unlike the public RPCs above, this carrier has no auth.uid() to key on, which is why insert_session_v1 takes one too');

-- A user with no session row at all, and no `profiles` row either: the row count is the fixture for 58,
-- and the missing profile is what 60 reads.
insert into t_rev select 'before', 'sessions_c2', count(*)::int from toi_identity.sessions
  where user_id = '00000000-0000-4000-8000-0000000000c2';
insert into t_rev select 'before', 'profiles_c2', count(*)::int from public.profiles
  where id = '00000000-0000-4000-8000-0000000000c2';

select is((select n from t_rev where phase = 'before' and what = 'sessions_c2'), 0::int,
  '57 (fixture) this user holds no session row of any kind: the state of someone resetting a password they have never signed in with');

select is(pg_temp.try_revoke('00000000-0000-4000-8000-0000000000c2', 'company1.terraoi.app',
                             timestamptz '2026-11-14 11:30:00+00'), 'true',
  '58 and the revocation still reports that it RAN: `true` is not "at least one row was revoked", because a first-ever reset read as a failure would lock the user out of their own account (signin-completion.ts:143-148)');

select ok((select n from t_rev where phase = 'before' and what = 'profiles_c2') = 0,
  '59 the same answer for a user with no profiles row: the revocation touches the session store and nothing in the tenant tables');

-- ----------------------------------- 60-68: what a real revocation takes down, and what it must not
insert into t_rev
  select 'before', 'live_c1', count(*)::int from toi_identity.sessions
   where user_id = '00000000-0000-4000-8000-0000000000c1' and host = 'company1.terraoi.app' and revoked_at is null;
insert into t_rev
  select 'before', 'live_c2_host', count(*)::int from toi_identity.sessions
   where user_id = '00000000-0000-4000-8000-0000000000c1' and host = 'company2.terraoi.app' and revoked_at is null;

-- The refused shape first, before any revocation has run: without the host-shape rule in the function,
-- this call would match nothing and answer `true` — a reset that reported revoking sessions and revoked
-- none. 61 is the half that says nothing moved.
select is(pg_temp.try_revoke('00000000-0000-4000-8000-0000000000c1', 'Company1.terraoi.app',
                             timestamptz '2026-11-14 11:30:00+00'), 'sqlstate:22023',
  '60 a host that is not a normalized bare hostname is refused with 22023 rather than matched against nothing: that is what keeps the boolean honest');
select is(
  (select count(*)::int from toi_identity.sessions
    where user_id = '00000000-0000-4000-8000-0000000000c1' and host = 'company1.terraoi.app' and revoked_at is null),
  (select n from t_rev where phase = 'before' and what = 'live_c1'),
  '61 and the refused call stamped nothing: the same rows that were live before it are live after it');

select is(pg_temp.try_revoke('00000000-0000-4000-8000-0000000000c1', 'company1.terraoi.app',
                             timestamptz '2026-11-14 11:30:00+00'), 'true',
  '62 the reset for a user who does hold sessions also reports true — the same answer, whether there was one row to take down or four');
select is(
  (select count(*)::int from toi_identity.sessions
    where user_id = '00000000-0000-4000-8000-0000000000c1' and host = 'company1.terraoi.app'
      and revoked_at = timestamptz '2026-11-14 11:30:00+00'),
  3::int,
  '63 every row this user held on this host is now stamped at the reset instant — the two live ones and the expired one that was never revoked, because after this statement the user has nothing live here');
select is(
  (select count(*)::int from toi_identity.sessions
    where user_id = '00000000-0000-4000-8000-0000000000c1' and host = 'company2.terraoi.app' and revoked_at is null),
  (select n from t_rev where phase = 'before' and what = 'live_c2_host'),
  '64 and the row issued on the other tenant''s host survives: revocation is host-scoped, so a company1 reset cannot reach a company2 session (ADR-0003 §2, §4)');
select is(
  (select revoked_at from toi_identity.sessions where session_key = 't201rvra' || repeat('D', 35)),
  timestamptz '2026-11-14 06:00:00+00',
  '65 an already-revoked row keeps the instant it actually stopped working, which is the record ADR-0003 §2 says the timestamp exists to be');

select is(pg_temp.try_revoke('00000000-0000-4000-8000-0000000000c1', 'company1.terraoi.app',
                             timestamptz '2026-11-14 11:45:00+00'), 'true',
  '66 a second run reports true as well (a reset completed twice is still two completed resets), and');
select is(
  (select count(*)::int from toi_identity.sessions
    where user_id = '00000000-0000-4000-8000-0000000000c1' and host = 'company1.terraoi.app'
      and revoked_at = timestamptz '2026-11-14 11:45:00+00'),
  0::int,
  '67 writes nothing: the predicate tests `revoked_at is null`, so the first instant survives the replay');

-- The ordering the Worker relies on, expressed in SQL: the revocation runs **before** the new session
-- row exists (`signin-completion.ts:131-149` precedes `issueSession`), so the session a reset mints is
-- never caught by the reset that minted it.
insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, revoked_at, key_version,
   access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
values ('t201rvna' || repeat('F', 35), '00000000-0000-4000-8000-0000000000c1', 'company1.terraoi.app',
   timestamptz '2026-11-14 11:30:05+00', timestamptz '2026-11-14 19:30:05+00', null, 'v1',
   'v1.AAAAAAAAAAAAAAAA.MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM',
   'v1.CCCCCCCCCCCCCCCC.NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN',
   timestamptz '2026-11-14 12:30:05+00');

select is(
  (select count(*)::int from toi_identity.sessions
    where session_key = 't201rvna' || repeat('F', 35) and revoked_at is null),
  1::int,
  '68 a session minted after the revocation on the same host and for the same user is untouched by it: revoke-then-mint is the order, and the new session is the one the browser keeps');

select * from finish();
rollback;
