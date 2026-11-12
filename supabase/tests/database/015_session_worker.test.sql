-- T-102h / #75: toi_session_worker can call the five session functions and nothing else.
begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

select ok(
  (select rolcanlogin = false from pg_roles where rolname = 'toi_session_worker'),
  '1 toi_session_worker exists and is NOLOGIN'
);

select ok(has_schema_privilege('toi_session_worker', 'toi_identity', 'usage'),
  '2 toi_session_worker has usage on toi_identity');

select is(has_table_privilege('toi_session_worker', 'toi_identity.sessions', 'select'), false,
  '3 toi_session_worker cannot select toi_identity.sessions directly');
select is(has_table_privilege('toi_session_worker', 'toi_identity.sessions', 'insert'), false,
  '4 toi_session_worker cannot insert into toi_identity.sessions directly');
select is(has_table_privilege('toi_session_worker', 'toi_identity.sessions', 'update'), false,
  '5 toi_session_worker cannot update toi_identity.sessions directly');
select is(has_table_privilege('toi_session_worker', 'toi_identity.sessions', 'delete'), false,
  '6 toi_session_worker cannot delete from toi_identity.sessions directly');

select ok(has_function_privilege('toi_session_worker', 'toi_identity.authenticate_session_v1(text, text, timestamptz)', 'execute'),
  '7 toi_session_worker can execute authenticate_session_v1');
select ok(has_function_privilege('toi_session_worker', 'toi_identity.insert_session_v1(text, uuid, text, timestamptz, timestamptz, text, text, text, timestamptz)', 'execute'),
  '8 toi_session_worker can execute insert_session_v1');
select ok(has_function_privilege('toi_session_worker', 'toi_identity.revoke_session_v1(text, timestamptz)', 'execute'),
  '9 toi_session_worker can execute revoke_session_v1');
select ok(has_function_privilege('toi_session_worker', 'toi_identity.rotate_session_tokens_v1(text, text, text, text, timestamptz, timestamptz)', 'execute'),
  '10 toi_session_worker can execute rotate_session_tokens_v1');
select ok(has_function_privilege('toi_session_worker', 'toi_identity.prune_expired_sessions_v1(timestamptz, interval)', 'execute'),
  '11 toi_session_worker can execute prune_expired_sessions_v1');

-- API-facing roles stay refused (the #75 threat model keeps service_role out too).
select is(has_function_privilege('service_role', 'toi_identity.authenticate_session_v1(text, text, timestamptz)', 'execute'), false,
  '12 service_role still cannot execute authenticate_session_v1');
select is(has_function_privilege('authenticated', 'toi_identity.insert_session_v1(text, uuid, text, timestamptz, timestamptz, text, text, text, timestamptz)', 'execute'), false,
  '13 authenticated still cannot insert a session');

-- Runtime: the role can call authenticate (empty is fine) but cannot SELECT the table.
grant toi_session_worker to postgres;
set local role toi_session_worker;
select lives_ok(
  $$ select * from toi_identity.authenticate_session_v1('Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2', 'company1.terraoi.app', timestamptz '2026-11-07 12:00:00+00') $$,
  '14 toi_session_worker can call authenticate_session_v1 at runtime'
);
select throws_ok($$ select * from toi_identity.sessions $$, '42501', null,
  '15 toi_session_worker cannot select the session table at runtime');
reset role;

select * from finish();
rollback;
