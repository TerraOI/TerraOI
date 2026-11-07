-- T-102 / ADR-0003: the server-side session store (#37 option b).
--   * `anon` and `authenticated` cannot read `toi_identity.sessions`, in the catalog and at runtime;
--   * a revoked session does not authenticate;
--   * a session issued on company1 does not authenticate on company2;
--   * the token columns hold an encryption envelope, so a plaintext Supabase JWT cannot be stored.
-- These are the three pgTAP cases the supervisor named in the #37 decision, plus the column rules
-- that make them hold whatever the caller does.
--
-- Slot 014, chosen so it sits with the identity block (010 tenancy, 011 identity invariants, 012
-- methods, 013 admin) and does not collide with a claimed slot: 040 is the merged
-- `040_knowledge_uploads.test.sql`, and 012/013/035/045/050/060/070+ are claimed by T-201, T-202,
-- T-104, T-211, T-213, T-214 and T-216. See the migration header.
--
-- What is NOT tested here: how the Worker reaches this schema. Issue #75 decides that, so the
-- migration grants nothing to any role and the functions are owner-only — which is why the behavior
-- cases below run as the migration owner and the role cases only ever assert refusal.
--
-- Fixtures are synthetic and created inside this transaction, which rolls back (AGENTS.md §4.7);
-- supabase/seed.sql is not touched. The seeded identities 1111…1111 = company1 and the owner
-- …0a1 come from it, as in 010/011.
begin;
create extension if not exists pgtap with schema extensions;

select plan(43);

-- Helpers report an error as its SQLSTATE instead of aborting the test transaction, and run as the
-- role under test (SECURITY INVOKER): the pattern 010_tenancy.test.sql established.
create function pg_temp.try_insert(p_session_key text, p_user_id uuid, p_host text, p_access text, p_refresh text, p_created timestamptz, p_expires timestamptz)
returns text language plpgsql security invoker as $fn$
begin
  begin
    select toi_identity.insert_session_v1(
      p_session_key, p_user_id, p_host, p_created, p_expires, 'v1', p_access, p_refresh, p_expires);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.auth_count(p_session_key text, p_host text, p_now timestamptz)
returns integer language plpgsql security invoker as $fn$
declare
  v integer;
begin
  select count(*)::int into v from toi_identity.authenticate_session_v1(p_session_key, p_host, p_now);
  return v;
end;
$fn$;

create function pg_temp.try_auth(p_session_key text, p_host text, p_now timestamptz) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from toi_identity.authenticate_session_v1(p_session_key, p_host, p_now);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_revoke(p_session_key text, p_now timestamptz) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform toi_identity.revoke_session_v1(p_session_key, p_now);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_rotate(p_session_key text, p_access text, p_now timestamptz) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform toi_identity.rotate_session_tokens_v1(p_session_key, 'v1', p_access, p_access, p_now + interval '1 hour', p_now);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Capture table, created by the role that fills it (010's approach) so a `set local role` block can
-- write into it while the assertions read it as the owner.
set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_revoked (session_key text);
reset role;

-- A fixed clock: every lifetime case is measured against it, so a slow CI runner cannot change a
-- boundary. `T0` is "now" for the fixtures.
create temp table t_clock (t0 timestamptz);
insert into t_clock select timestamptz '2026-11-07 12:00:00+00';

-- Synthetic ciphertext in the envelope shape the Worker produces: `<version>.<12-byte iv>.<gcm ct>`.
-- Synthetic session key: 43 base64url characters, as the digest is.
-- ---------------------------------------------------------------- 1–5 the shape of the store
select has_schema('toi_identity', '1 the session schema exists');
select has_table('toi_identity', 'sessions', '2 toi_identity.sessions exists');

select is(
  (select relrowsecurity from pg_class where oid = 'toi_identity.sessions'::regclass),
  true,
  '3 RLS is enabled on toi_identity.sessions (guardrail 000 covers public only, so this schema pins its own)'
);

select is_empty(
  $$ select policyname::text from pg_policies where schemaname = 'toi_identity' $$,
  '4 the session table has no policies: nothing is readable through RLS, by anyone'
);

select is_empty(
  $$ select p.proname::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'toi_identity'
        and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                         where cfg = 'search_path=toi_identity, pg_temp') $$,
  '5 every toi_identity SECURITY DEFINER function pins search_path = toi_identity, pg_temp'
);

-- ---------------------------------------------------------------- 6–13 the grant state
-- Not being in `[api] schemas` is a dashboard setting CI cannot see, so the ACLs are the contract
-- (same reasoning as 030_pilot_inquiries.test.sql).
select ok(not has_schema_privilege('anon', 'toi_identity', 'usage'),
  '6 anon has no usage on schema toi_identity');
select ok(not has_schema_privilege('authenticated', 'toi_identity', 'usage'),
  '7 authenticated has no usage on schema toi_identity');
select ok(not has_schema_privilege('service_role', 'toi_identity', 'usage'),
  '8 service_role has no usage on schema toi_identity (#37: no service-role key in the Worker for this path)');

select is(has_table_privilege('anon', 'toi_identity.sessions', 'select'), false,
  '9 anon cannot select the session table');
select is(has_table_privilege('authenticated', 'toi_identity.sessions', 'select'), false,
  '10 authenticated cannot select the session table (a signed-in member may not read sessions)');
select is(has_function_privilege('authenticated', 'toi_identity.authenticate_session_v1(text, text, timestamptz)', 'execute'), false,
  '11 authenticated cannot execute authenticate_session_v1');
select is(has_function_privilege('authenticated', 'toi_identity.insert_session_v1(text, uuid, text, timestamptz, timestamptz, text, text, text, timestamptz)', 'execute'), false,
  '12 authenticated cannot create a session row for itself');
select is(has_function_privilege('service_role', 'toi_identity.authenticate_session_v1(text, text, timestamptz)', 'execute'), false,
  '13 service_role cannot execute authenticate_session_v1 either: the grant target waits for #75');

-- ---------------------------------------------------------------- 14–17 runtime refusal
-- The grant state alone can be vacuous if a later migration grants `usage` by accident; these prove
-- the statements themselves fail today.
set local role anon;
select throws_ok($$ select * from toi_identity.sessions $$, '42501', null,
  '14 anon cannot select the session table at runtime');
select throws_ok($$ select * from toi_identity.authenticate_session_v1('Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2', 'company1.terraoi.app', timestamptz '2026-11-07 12:00:00+00') $$,
  '42501', null, '15 anon cannot call the session lookup at runtime');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select throws_ok($$ select user_id, access_token_ciphertext from toi_identity.sessions $$, '42501', null,
  '16 an active member cannot read sessions, with their own tenant scope or without one');
select throws_ok($$ select toi_identity.revoke_session_v1('Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2', timestamptz '2026-11-07 12:00:00+00') $$,
  '42501', null, '17 a member cannot revoke somebody else''s session through the API');
insert into t_out values ('anon_auth_state', pg_temp.try_auth('Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2', 'company1.terraoi.app', timestamptz '2026-11-07 12:00:00+00'));
reset role;

select is((select result from t_out where case_name = 'anon_auth_state'), '42501',
  '18 (as authenticated) the session lookup itself is refused, not merely empty');

-- ---------------------------------------------------------------- fixtures (owner)
-- The live session, and the three lifetime variants, all for the seeded company1 owner.
insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, key_version, access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
select 'a1live' || repeat('A', 37), '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
       t0, t0 + interval '8 hours', 'v1',
       'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
       'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
       t0 + interval '1 hour'
  from t_clock;

insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, key_version, access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
select 'a1host2x' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'company2.terraoi.app',
       t0, t0 + interval '8 hours', 'v1',
       'v1.AAAAAAAAAAAAAAAA.EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
       'v1.CCCCCCCCCCCCCCCC.FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
       t0 + interval '1 hour'
  from t_clock;

-- ---------------------------------------------------------------- 19–24 host and lifetime rules
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'company1.terraoi.app', (select t0 from t_clock)), 1,
  '19 a live session authenticates on the host it was issued on');
select is(
  (select user_id::text from toi_identity.authenticate_session_v1('a1live' || repeat('A', 37), 'company1.terraoi.app', (select t0 from t_clock))),
  '00000000-0000-4000-8000-0000000000a1',
  '20 and it yields the identity that signed in, not the host or the caller''s argument');
-- The decision's third case: a session issued on company1 does not authenticate on company2. The
-- row that matches the key but not the host exists, so this is the cross-host case, not a typo.
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'company2.terraoi.app', (select t0 from t_clock)), 0,
  '21 the same session key does not authenticate on company2');
select is(pg_temp.auth_count('a1host2x' || repeat('A', 35), 'company1.terraoi.app', (select t0 from t_clock)), 0,
  '22 nor a company2-issued session on company1 (the guard is symmetric)');
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'company1.terraoi.app.evil.test', (select t0 from t_clock)), 0,
  '23 a look-alike host grants nothing: the comparison is exact, not a suffix test');
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'Company1.terraoi.app', (select t0 from t_clock)), 0,
  '24 a case variant of the issuing host grants nothing');

-- ---------------------------------------------------------------- 25–29 expiry
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'company1.terraoi.app', (select t0 from t_clock) + interval '8 hours' - interval '1 second'), 1,
  '25 the session still authenticates one second before its expiry');
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'company1.terraoi.app', (select t0 from t_clock) + interval '8 hours'), 0,
  '26 and not at the expiry instant itself (the boundary is exclusive, as in readSession)');
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'company1.terraoi.app', (select t0 from t_clock) + interval '9 hours'), 0,
  '27 nor after it');

-- ---------------------------------------------------------------- 30–33 revocation
select is(toi_identity.revoke_session_v1('a1host2x' || repeat('A', 35), (select t0 from t_clock)), true,
  '28 sign-out sets revoked_at and reports that it did');
select is(pg_temp.auth_count('a1host2x' || repeat('A', 35), 'company2.terraoi.app', (select t0 from t_clock)), 0,
  '29 a revoked session does not authenticate, well inside its 8-hour lifetime (the #37 case)');
select is(toi_identity.revoke_session_v1('a1host2x' || repeat('A', 35), (select t0 from t_clock)), false,
  '30 revoking twice reports the second attempt: revoked_at is not rewritten');
select is(
  (select count(*)::int from toi_identity.sessions where session_key = 'a1host2x' || repeat('A', 35) and revoked_at is not null),
  1::int, '31 and the row records when the revocation happened');

-- ---------------------------------------------------------------- 34–36 rotation
insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, key_version, access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
select 'a1rotate' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
       t0, t0 + interval '8 hours', 'v1',
       'v1.AAAAAAAAAAAAAAAA.GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
       'v1.CCCCCCCCCCCCCCCC.HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
       t0 + interval '1 hour'
  from t_clock;

select is(toi_identity.rotate_session_tokens_v1('a1rotate' || repeat('A', 35), 'v2',
         'v2.AAAAAAAAAAAAAAAA.IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
         'v2.CCCCCCCCCCCCCCCC.JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ',
         (select t0 from t_clock) + interval '2 hours', (select t0 from t_clock)),
  true, '32 a rotation writes into a live session');
select is(
  (select refresh_token_ciphertext from toi_identity.sessions where session_key = 'a1rotate' || repeat('A', 35)),
  'v2.CCCCCCCCCCCCCCCC.JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ',
  '33 and the old refresh token is overwritten, not kept alongside it (Supabase rotates on use)');
select is(toi_identity.rotate_session_tokens_v1('a1host2x' || repeat('A', 35), 'v2',
         'v2.AAAAAAAAAAAAAAAA.KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
         'v2.CCCCCCCCCCCCCCCC.LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL',
         (select t0 from t_clock) + interval '2 hours', (select t0 from t_clock)),
  false, '34 a rotation that loses to a revocation writes nothing: a revoked session stays revoked');

-- ---------------------------------------------------------------- 37–42 the column rules
-- A plaintext Supabase JWT must be unwritable, so "encrypted at rest" is a constraint, not a habit.
insert into t_out values
  ('plaintext_jwt', pg_temp.try_insert('a1jwt000' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
      'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lcjEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.ZmFrZS1zaWduYXR1cmU',
      'v1.CCCCCCCCCCCCCCCC.MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM',
      (select t0 from t_clock), (select t0 from t_clock) + interval '8 hours')),
  ('short_key', pg_temp.try_insert('too-short', '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
      'v1.AAAAAAAAAAAAAAAA.NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN',
      'v1.CCCCCCCCCCCCCCCC.OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
      (select t0 from t_clock), (select t0 from t_clock) + interval '8 hours')),
  ('upper_host', pg_temp.try_insert('a1upper0' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'Company1.terraoi.app',
      'v1.AAAAAAAAAAAAAAAA.PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP',
      'v1.CCCCCCCCCCCCCCCC.QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
      (select t0 from t_clock), (select t0 from t_clock) + interval '8 hours')),
  ('expired_row', pg_temp.try_insert('a1past00' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
      'v1.AAAAAAAAAAAAAAAA.RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR',
      'v1.CCCCCCCCCCCCCCCC.SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
      (select t0 from t_clock), (select t0 from t_clock))),
  ('good_row', pg_temp.try_insert('a1good00' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
      'v1.AAAAAAAAAAAAAAAA.TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
      'v1.CCCCCCCCCCCCCCCC.UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU',
      (select t0 from t_clock), (select t0 from t_clock) + interval '8 hours'));

select is((select result from t_out where case_name = 'plaintext_jwt'), '23514',
  '35 a plaintext Supabase JWT cannot be written into the ciphertext column');
select is((select result from t_out where case_name = 'short_key'), '23514',
  '36 a session key that is not a 43-character digest is refused, so a cookie value can never be a key');
select is((select result from t_out where case_name = 'upper_host'), '23514',
  '37 a host that is not normalized cannot be recorded, so the cross-host comparison has one form to match');
select is((select result from t_out where case_name = 'expired_row'), '23514',
  '38 a session that expires at or before its creation is refused (the lifetime must be a span)');
select is((select result from t_out where case_name = 'good_row'), 'ok',
  '39 control: the well-formed row writes cleanly, so 35–38 are about the values, not about the insert');

-- ---------------------------------------------------------------- 40–41 teeth
-- Drop the ciphertext CHECK and the same plaintext JWT is accepted; the savepoint rollback restores
-- the constraint and the row (the idiom 011_identity.test.sql uses for the email CHECK).
savepoint sp_cipher_check;
alter table toi_identity.sessions drop constraint sessions_access_token_ciphertext_check;
insert into t_out
  select 'jwt_after_drop', pg_temp.try_insert('a1jwt001' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
      'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lcjEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.ZmFrZS1zaWduYXR1cmU',
      'v1.CCCCCCCCCCCCCCCC.VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
      (select t0 from t_clock), (select t0 from t_clock) + interval '8 hours'));
select is((select result from t_out where case_name = 'jwt_after_drop'), 'ok',
  '40 drop the CHECK and the plaintext JWT writes: the guard is the CHECK, not the insert statement');
rollback to savepoint sp_cipher_check;
select is((select count(*)::int from toi_identity.sessions where session_key = 'a1jwt001' || repeat('A', 35)), 0::int,
  '41 the savepoint rollback restores both the constraint and the row count');

-- ---------------------------------------------------------------- 42 retention
insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, revoked_at, key_version, access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
select 'a1aged00' || repeat('A', 35), '00000000-0000-4000-8000-0000000000a1', 'company1.terraoi.app',
       t0 - interval '30 days', t0 - interval '29 days', null, 'v1',
       'v1.AAAAAAAAAAAAAAAA.WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
       'v1.CCCCCCCCCCCCCCCC.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
       t0 - interval '29 days'
  from t_clock;

select is(toi_identity.prune_expired_sessions_v1((select t0 from t_clock), interval '7 days'), 1,
  '42 the prune deletes the long-expired row and nothing that is still live');
select is(pg_temp.auth_count('a1live' || repeat('A', 37), 'company1.terraoi.app', (select t0 from t_clock)), 1,
  '43 (final) the live session is untouched by the prune');

select * from finish();
rollback;
