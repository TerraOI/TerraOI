-- T-214 PR-1: `source_acl_bindings`, audience predicates and `authorize_source_access_v1`.
-- Migration: supabase/migrations/20261124140000_project_acl.sql.
-- Fixtures: merged seed (Site A project 410…001, site source 610…002 / chunk 81…0004, user …a1 on Site A,
-- …a2 company1 not on Site A, …b1 company2). Citation/history/staging evidence deferred (T-104 / T-203).
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

-- ---------------------------------------------------------------- helpers
create function pg_temp.try_scope(p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.set_tenant_scope(p_organisation_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_authorize(p_organisation_id uuid, p_source_id uuid, p_purpose text) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
declare v_result boolean;
begin
  begin
    v_result := public.authorize_source_access_v1(p_organisation_id, p_source_id, p_purpose);
    return case when v_result then 'true' else 'false' end;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_search_rows(p_organisation_id uuid, p_query text) returns integer
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  return (select count(*)::int
            from public.search_corpus_v1(p_organisation_id, array[]::text[], null, null,
                   p_query, null, null, null, null, 10)
           where o_evidence_kind = 'chunk'
             and o_chunk_id = '81000000-0000-4000-8000-000000000004');
end;
$fn$;

create function pg_temp.rev_of(p_organisation_id uuid) returns bigint
language sql security invoker as $$
  select policy_revision from public.organisations where id = p_organisation_id;
$$;

create function pg_temp.try_owner_sql(p_sql text) returns text
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Temp tables must be writable under `set local role authenticated` (041/045 idiom): either create
-- them as that role, or grant INSERT/SELECT. Grants keep owner-side DO blocks able to fill t_out.
create temp table t_out (case_name text, result text);
create temp table t_count (case_name text, n int);
grant insert, select on t_out to authenticated;
grant insert, select on t_count to authenticated;

-- ---------------------------------------------------------------- fixtures: extra project for dual-binding cases
select pg_temp.try_owner_sql(
  'insert into public.projects (id, organisation_id, key, name, visibility, status) values '
  || '(''43000000-0000-4000-8000-000000000001'', ''11111111-1111-4111-8111-111111111111'', '
  || '''bind-b'', ''Binding fixture B'', ''project'', ''active'') on conflict (id) do nothing');

-- ---------------------------------------------------------------- 1-6 Site A member vs non-member
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select public.set_tenant_scope('11111111-1111-4111-8111-111111111111');

select is(public.source_is_readable('61000000-0000-4000-8000-000000000002'), true,
  '1 a Site A member can read the project-scoped site source (§6.2)');

select is(pg_temp.try_authorize('11111111-1111-4111-8111-111111111111',
         '61000000-0000-4000-8000-000000000002', 'retrieve'), 'true',
  '2 authorize_source_access_v1 agrees for retrieve (F08)');

insert into t_count values ('a1_grid', pg_temp.try_search_rows(
  '11111111-1111-4111-8111-111111111111', 'grid'));
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select public.set_tenant_scope('11111111-1111-4111-8111-111111111111');

select is(public.source_is_readable('61000000-0000-4000-8000-000000000002'), false,
  '3 a company1 member outside Site A cannot read the site source');

select is(pg_temp.try_authorize('11111111-1111-4111-8111-111111111111',
         '61000000-0000-4000-8000-000000000002', 'cite'), 'false',
  '4 the same function withholds cite access without leaking existence (F08 minimal)');

insert into t_count values ('a2_grid', pg_temp.try_search_rows(
  '11111111-1111-4111-8111-111111111111', 'grid'));
reset role;

select is((select n from t_count where case_name = 'a1_grid'), 1,
  '5 search_corpus still returns the Site A chunk for the member');
select is((select n from t_count where case_name = 'a2_grid'), 0,
  '6 and returns zero evidence rows for the non-member on the same query');

-- ---------------------------------------------------------------- 7-9 cross-tenant and membership removal
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('b1_scope_c1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values ('b1_auth_c1', pg_temp.try_authorize('11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-000000000002', 'retrieve'));
select public.set_tenant_scope('22222222-2222-4222-8222-222222222222');
select is(public.source_is_readable('61000000-0000-4000-8000-000000000002'), false,
  '7 a company2 member never reads a company1 source under company2 scope');
reset role;

select is((select result from t_out where case_name = 'b1_scope_c1'), '28000',
  '8 set_tenant_scope refuses a foreign organisation for company2 (FAQ-0011)');
select is((select result from t_out where case_name = 'b1_auth_c1'), '28000',
  '9 and the authorize RPC inherits that refusal on the first statement');

-- remove Site A membership for a1
select is(pg_temp.try_owner_sql(
  'delete from public.project_memberships where project_id = '
  || '''41000000-0000-4000-8000-000000000001'' and user_id = '
  || '''00000000-0000-4000-8000-0000000000a1'''), 'ok',
  'fixture: drop Site A membership for …a1');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
select is(pg_temp.try_authorize('11111111-1111-4111-8111-111111111111',
         '61000000-0000-4000-8000-000000000002', 'history'), 'false',
  '10 after project membership is removed, the next authorize call withholds (§6.2)');
reset role;

-- restore membership for later cases
select pg_temp.try_owner_sql(
  'insert into public.project_memberships (organisation_id, project_id, user_id) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''41000000-0000-4000-8000-000000000001'', '
  || '''00000000-0000-4000-8000-0000000000a1'') on conflict (project_id, user_id) do nothing');

-- ---------------------------------------------------------------- 11-12 dual binding audience
select pg_temp.try_owner_sql(
  'insert into public.source_acl_bindings (organisation_id, source_id, project_id) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''61000000-0000-4000-8000-000000000001'', '
  || '''41000000-0000-4000-8000-000000000001''), '
  || '(''11111111-1111-4111-8111-111111111111'', ''61000000-0000-4000-8000-000000000001'', '
  || '''43000000-0000-4000-8000-000000000001'') on conflict (source_id, project_id) do nothing');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
select is(public.source_is_readable('61000000-0000-4000-8000-000000000001'), false,
  '11 a source bound to two projects stays invisible to a member of neither (bindings do not widen from a tenant-wide collection)');

-- membership insert as owner (definer); stay authenticated as …a2 for the follow-up read
select pg_temp.try_owner_sql(
  'insert into public.project_memberships (organisation_id, project_id, user_id) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''43000000-0000-4000-8000-000000000001'', '
  || '''00000000-0000-4000-8000-0000000000a2'') on conflict (project_id, user_id) do nothing');

select is(public.source_is_readable('61000000-0000-4000-8000-000000000001'), true,
  '12 membership in one bound project is enough even when the collection is tenant-wide');
reset role;

-- ---------------------------------------------------------------- 13-14 archived project
select pg_temp.try_owner_sql(
  'update public.projects set status = ''archived'' where id = '
  || '''41000000-0000-4000-8000-000000000001''');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
select is(public.source_is_readable('61000000-0000-4000-8000-000000000002'), false,
  '13 archiving the collection''s project stops source readability');
insert into t_count values ('archived_grid', pg_temp.try_search_rows(
  '11111111-1111-4111-8111-111111111111', 'grid'));
reset role;

select is((select n from t_count where case_name = 'archived_grid'), 0,
  '14 and search returns zero evidence rows for the same query');

-- restore project for cleanliness
select pg_temp.try_owner_sql(
  'update public.projects set status = ''active'' where id = '
  || '''41000000-0000-4000-8000-000000000001''');

-- ---------------------------------------------------------------- 15-17 policy_revision on bindings
do $rev$
declare
  v_before bigint;
  v_mid bigint;
  v_before_delete bigint;
  v_after bigint;
begin
  v_before := pg_temp.rev_of('11111111-1111-4111-8111-111111111111');
  perform pg_temp.try_owner_sql(
    'insert into public.source_acl_bindings (organisation_id, source_id, project_id) values '
    || '(''11111111-1111-4111-8111-111111111111'', ''61000000-0000-4000-8000-000000000002'', '
    || '''41000000-0000-4000-8000-000000000002'') on conflict (source_id, project_id) do nothing');
  v_mid := pg_temp.rev_of('11111111-1111-4111-8111-111111111111');
  insert into t_out values ('rev_insert_delta', (v_mid - v_before)::text);
  perform pg_temp.try_owner_sql(
    'insert into public.source_acl_bindings (organisation_id, source_id, project_id) values '
    || '(''11111111-1111-4111-8111-111111111111'', ''61000000-0000-4000-8000-000000000002'', '
    || '''41000000-0000-4000-8000-000000000002'') on conflict (source_id, project_id) do nothing');
  insert into t_out values ('rev_noop_delta', (pg_temp.rev_of('11111111-1111-4111-8111-111111111111') - v_mid)::text);
  v_before_delete := pg_temp.rev_of('11111111-1111-4111-8111-111111111111');
  perform pg_temp.try_owner_sql(
    'delete from public.source_acl_bindings where source_id = '
    || '''61000000-0000-4000-8000-000000000002'' and project_id = '
    || '''41000000-0000-4000-8000-000000000002''');
  v_after := pg_temp.rev_of('11111111-1111-4111-8111-111111111111');
  insert into t_out values ('rev_delete_delta', (v_after - v_before_delete)::text);
end;
$rev$;

select is((select result::bigint from t_out where case_name = 'rev_insert_delta'), 1::bigint,
  '15 inserting a binding moves policy_revision by one (#98)');
select is((select result::bigint from t_out where case_name = 'rev_noop_delta'), 0::bigint,
  '16 a replayed binding insert is a no-op for policy_revision');
select is((select result::bigint from t_out where case_name = 'rev_delete_delta'), 1::bigint,
  '17 deleting a binding moves policy_revision by one (#98)');

-- ---------------------------------------------------------------- 18-22 RPC shape and privileges
select is(p.provolatile::text, 'v',
  '18 authorize_source_access_v1 is volatile because set_tenant_scope is its first statement (FAQ-0011)')
  from pg_proc p
 where p.oid = 'public.authorize_source_access_v1(uuid, uuid, text)'::regprocedure;

select ok(
  position('perform public.set_tenant_scope(p_organisation_id);' in p.prosrc)
    between 1 and position('if v_arrived_scope' in p.prosrc),
  '19 set_tenant_scope is the first statement in the RPC body (FAQ-0011)')
  from pg_proc p
 where p.oid = 'public.authorize_source_access_v1(uuid, uuid, text)'::regprocedure;

select is(has_function_privilege('anon', 'public.authorize_source_access_v1(uuid, uuid, text)', 'execute'), false,
  '20 anon cannot execute authorize_source_access_v1');
select is(has_function_privilege('authenticated', 'public.authorize_source_access_v1(uuid, uuid, text)', 'execute'), true,
  '21 authenticated may execute authorize_source_access_v1');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('bad_purpose', pg_temp.try_authorize(
  '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000002', 'export'));
insert into t_out values ('b1_auth_c1_repeat', pg_temp.try_authorize(
  '22222222-2222-4222-8222-222222222222', '62000000-0000-4000-8000-000000000001', 'retrieve'));
reset role;

select is((select result from t_out where case_name = 'bad_purpose'), '22023',
  '22 an invalid purpose is refused with 22023');
select is((select result from t_out where case_name = 'b1_auth_c1_repeat'), '28000',
  '23 a company1 member cannot authorize through another tenant''s scope argument');

-- ---------------------------------------------------------------- 24-30 catalog pins
select ok(
  (select count(*)::int
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_proc p on p.oid = t.tgfoid
    where c.relname = 'source_acl_bindings'
      and p.proname = 'bump_policy_revision'
      and not t.tgisinternal) = 3,
  '24 source_acl_bindings carries insert/update/delete policy_revision triggers (#98)');

select is(has_function_privilege('authenticated', 'public.source_audience_allows(uuid)', 'execute'), false,
  '25 source_audience_allows stays an internal predicate (not on the allow-list)');

select ok(
  position('public.source_audience_allows(p_source_id)' in p.prosrc) > 0,
  '26 source_is_readable delegates project union to source_audience_allows')
  from pg_proc p
 where p.oid = 'public.source_is_readable(uuid)'::regprocedure;

select is(has_table_privilege('authenticated', 'public.source_acl_bindings', 'SELECT'), true,
  '27 authenticated may select bindings under RLS');
select is(has_table_privilege('authenticated', 'public.source_acl_bindings', 'INSERT'), false,
  '28 authenticated has no direct insert on bindings (§4.3)');
select is(has_table_privilege('authenticated', 'public.source_acl_bindings', 'UPDATE'), false,
  '29 authenticated has no direct update on bindings');
select is(has_table_privilege('authenticated', 'public.source_acl_bindings', 'DELETE'), false,
  '30 authenticated has no direct delete on bindings');

select * from finish();
rollback;