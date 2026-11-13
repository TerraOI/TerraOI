-- T-102h / #75: toi_session_worker can call the five session functions and nothing else.
begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

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

select is(has_function_privilege('service_role', 'toi_identity.authenticate_session_v1(text, text, timestamptz)', 'execute'), false,
  '12 service_role still cannot execute authenticate_session_v1');
select is(has_function_privilege('authenticated', 'toi_identity.insert_session_v1(text, uuid, text, timestamptz, timestamptz, text, text, text, timestamptz)', 'execute'), false,
  '13 authenticated still cannot insert a session');

-- Runtime: collect outcomes under the worker role (pgTAP helpers are not on its search_path),
-- then assert as the migration owner — same pattern as 020_knowledge.test.sql.
create function pg_temp.try_auth_as_worker() returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from toi_identity.authenticate_session_v1(
      'Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2',
      'company1.terraoi.app',
      timestamptz '2026-11-07 12:00:00+00');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_select_sessions() returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from toi_identity.sessions limit 1;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Capture table created by the role that fills it (010/020 pattern); owner asserts after reset.
grant toi_session_worker to postgres;
set local role toi_session_worker;
create temporary table t_worker_out (case_name text primary key, result text not null);
insert into t_worker_out values
  ('auth_call', pg_temp.try_auth_as_worker()),
  ('select_table', pg_temp.try_select_sessions());
reset role;

select is((select result from t_worker_out where case_name = 'auth_call'), 'ok',
  '14 toi_session_worker can call authenticate_session_v1 at runtime');
select is((select result from t_worker_out where case_name = 'select_table'), '42501',
  '15 toi_session_worker cannot select the session table at runtime');

-- Direct EXECUTE grants only. has_function_privilege is true for every function PUBLIC can
-- execute, which is the catalog default, so that check cannot tell a later GRANT to this role
-- from a privilege every role already has. aclexplode names the grantee.
select is_empty(
  $$ select n.nspname || '.' || p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname in ('public', 'toi_identity', 'job_api')
        and a.grantee = 'toi_session_worker'::regrole
        and a.privilege_type = 'EXECUTE'
        and not (n.nspname = 'toi_identity' and p.proname in (
          'authenticate_session_v1', 'insert_session_v1', 'revoke_session_v1',
          'rotate_session_tokens_v1', 'prune_expired_sessions_v1')) $$,
  '16 toi_session_worker is granted execute on no function except the five session functions'
);

select is_empty(
  $$ select n.nspname || '.' || c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'toi_identity')
        and c.relkind in ('r', 'p', 'v', 'm')
        and (has_table_privilege('toi_session_worker', c.oid, 'SELECT')
          or has_table_privilege('toi_session_worker', c.oid, 'INSERT')
          or has_table_privilege('toi_session_worker', c.oid, 'UPDATE')
          or has_table_privilege('toi_session_worker', c.oid, 'DELETE')
          or has_table_privilege('toi_session_worker', c.oid, 'TRUNCATE')
          or has_table_privilege('toi_session_worker', c.oid, 'REFERENCES')
          or has_table_privilege('toi_session_worker', c.oid, 'TRIGGER')) $$,
  '17 toi_session_worker has no table privilege in public or toi_identity'
);

select * from finish();
rollback;
