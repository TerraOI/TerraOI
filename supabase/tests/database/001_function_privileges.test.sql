-- #60 (supervisor ruling 2026-11-09, option A + two additions): function EXECUTE privileges in
-- `public` are pinned to an explicit allow-list. `20261105070000_knowledge_core.sql` created 15
-- functions and granted EXECUTE to `authenticated` on only 7 of them (`:903-911`), but PostgreSQL
-- grants EXECUTE to PUBLIC on every new function, and that migration revoked per *table* (`:884-888`)
-- and never per function — so the other eight, and the 15 as seen by `anon`, were reachable through
-- the Data API. `20261105060000_tenancy_core.sql:341`'s blanket revoke reached only the functions that
-- existed then, which is why `20261105210000_intake_service_role.sql:10-11` made per-function
-- revoke-and-grant the standing rule.
--
-- This file asserts privileges; it changes nothing (the paired migration is revoke-and-grant only,
-- no table and no signature change). The two generic rules are the part that outlives this fix: a
-- function that is not on the allow-list is refused, whoever added it.
begin;
create extension if not exists pgtap with schema extensions;

select plan(39);

-- ---------------------------------------------------------------- 1-15 anon executes nothing here
-- §12.4/§4.1: knowledge is behind sign-in. The tenancy host resolver is the only `public` function
-- anon may reach, and `010_tenancy.test.sql` pins what it can do with it.
select is(has_function_privilege('anon', 'public.data_class_is_valid(text)', 'execute'), false,
  '1 anon cannot execute data_class_is_valid');
select is(has_function_privilege('anon', 'public.data_class_rank(text)', 'execute'), false,
  '2 anon cannot execute data_class_rank');
select is(has_function_privilege('anon', 'public.data_class_is_ingestible_in_m1(text)', 'execute'), false,
  '3 anon cannot execute data_class_is_ingestible_in_m1');
select is(has_function_privilege('anon', 'public.collection_is_readable(uuid)', 'execute'), false,
  '4 anon cannot execute collection_is_readable');
select is(has_function_privilege('anon', 'public.source_is_readable(uuid)', 'execute'), false,
  '5 anon cannot execute source_is_readable');
select is(has_function_privilege('anon', 'public.source_version_is_readable(uuid)', 'execute'), false,
  '6 anon cannot execute source_version_is_readable');
select is(has_function_privilege('anon', 'public.chunk_is_readable(uuid)', 'execute'), false,
  '7 anon cannot execute chunk_is_readable');
select is(has_function_privilege('anon', 'public.knowledge_collections_guard()', 'execute'), false,
  '8 anon cannot execute knowledge_collections_guard');
select is(has_function_privilege('anon', 'public.source_versions_collection_guard()', 'execute'), false,
  '9 anon cannot execute source_versions_collection_guard');
select is(has_function_privilege('anon', 'public.source_versions_immutable()', 'execute'), false,
  '10 anon cannot execute source_versions_immutable');
select is(has_function_privilege('anon', 'public.source_versions_no_resurrection()', 'execute'), false,
  '11 anon cannot execute source_versions_no_resurrection');
select is(has_function_privilege('anon', 'public.knowledge_sources_guard()', 'execute'), false,
  '12 anon cannot execute knowledge_sources_guard');
select is(has_function_privilege('anon', 'public.knowledge_chunks_guard()', 'execute'), false,
  '13 anon cannot execute knowledge_chunks_guard');
select is(has_function_privilege('anon', 'public.chunk_embeddings_guard()', 'execute'), false,
  '14 anon cannot execute chunk_embeddings_guard');
select is(has_function_privilege('anon', 'public.source_versions_outbox()', 'execute'), false,
  '15 anon cannot execute source_versions_outbox');

-- ---------------------------------------------------------------- 16-22 the seven, and only the seven
-- `knowledge_core.sql:903-911` granted these to `authenticated` on purpose (RLS policies and CHECK
-- constraints call them: `:101`, `:103`, `:827`, `:831`, and the same pattern on the other tables).
-- Revoking them would break the read path, so the hardening grants them back unchanged.
select is(has_function_privilege('authenticated', 'public.data_class_is_valid(text)', 'execute'), true,
  '16 data_class_is_valid stays executable: a CHECK constraint evaluates it as the writing role (§4.3)');
select is(has_function_privilege('authenticated', 'public.data_class_rank(text)', 'execute'), true,
  '17 data_class_rank stays executable for authenticated');
select is(has_function_privilege('authenticated', 'public.data_class_is_ingestible_in_m1(text)', 'execute'), true,
  '18 data_class_is_ingestible_in_m1 stays executable: it is a CHECK on four knowledge tables');
select is(has_function_privilege('authenticated', 'public.collection_is_readable(uuid)', 'execute'), true,
  '19 collection_is_readable stays executable: it is the read predicate RLS evaluates (§7.1)');
select is(has_function_privilege('authenticated', 'public.source_is_readable(uuid)', 'execute'), true,
  '20 source_is_readable stays executable (knowledge_core.sql:827)');
select is(has_function_privilege('authenticated', 'public.source_version_is_readable(uuid)', 'execute'), true,
  '21 source_version_is_readable stays executable (knowledge_core.sql:831)');
select is(has_function_privilege('authenticated', 'public.chunk_is_readable(uuid)', 'execute'), true,
  '22 chunk_is_readable stays executable: the retrieval path is policy-bound, not owner-bound');

-- 23-30 the eight this migration does not grant back. A trigger function needs no EXECUTE privilege
-- for the role that fires it — PostgreSQL runs the trigger because the table has it — so closing
-- these costs nothing and removes eight REST-reachable endpoints.
select is(has_function_privilege('authenticated', 'public.knowledge_collections_guard()', 'execute'), false,
  '23 knowledge_collections_guard is not a request-role endpoint');
select is(has_function_privilege('authenticated', 'public.source_versions_collection_guard()', 'execute'), false,
  '24 source_versions_collection_guard is not a request-role endpoint');
select is(has_function_privilege('authenticated', 'public.source_versions_immutable()', 'execute'), false,
  '25 source_versions_immutable is not a request-role endpoint');
select is(has_function_privilege('authenticated', 'public.source_versions_no_resurrection()', 'execute'), false,
  '26 source_versions_no_resurrection is not a request-role endpoint (F14)');
select is(has_function_privilege('authenticated', 'public.knowledge_sources_guard()', 'execute'), false,
  '27 knowledge_sources_guard is not a request-role endpoint');
select is(has_function_privilege('authenticated', 'public.knowledge_chunks_guard()', 'execute'), false,
  '28 knowledge_chunks_guard is not a request-role endpoint');
select is(has_function_privilege('authenticated', 'public.chunk_embeddings_guard()', 'execute'), false,
  '29 chunk_embeddings_guard is not a request-role endpoint (TOI-ADR-13)');
select is(has_function_privilege('authenticated', 'public.source_versions_outbox()', 'execute'), false,
  '30 source_versions_outbox is not a request-role endpoint (§7.4 outbox)');

-- ---------------------------------------------------------------- 31 the generic rule for anon
-- Allow-list in `public` for anon: exactly `resolve_tenant_host(text)`, granted on purpose at
-- `tenancy_core.sql:356` because sign-in must resolve the tenant before anyone is authenticated.
-- Anything else in `public` that anon can execute is a finding, whoever added it and whenever.
select is_empty($$
  select p.pronamespace::regnamespace || '.' || p.proname || '(' ||
         pg_get_function_identity_arguments(p.oid) || ')' as function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and p.oid <> 'public.resolve_tenant_host(text)'::regprocedure::oid
$$, '31 no function in public is executable by anon except resolve_tenant_host(text) (§4.1, #60)');

-- ---------------------------------------------------------------- 32 the generic rule for authenticated
-- Additions 2. The allow-list is the set granted on purpose today, by name:
--   tenancy (`tenancy_core.sql:349-356`): current_organisation_id, set_tenant_scope,
--     clear_tenant_scope, is_active_member, is_project_member, resolve_tenant_host
--   knowledge (`knowledge_core.sql:903-911`): the seven pinned by 16-22 above
--   capture RPCs (`knowledge_uploads.sql:608-612`): begin_upload_session_v1,
--     register_source_version_v1, record_upload_outcome_v1
-- The session functions the ruling also lists live in `toi_identity`, not `public`
-- (`20261107024000_session_store.sql:122-219`), and that migration grants them to **no role** at all
-- pending #75 — so they cannot appear in a `public` allow-list; test 33 pins them closed instead.
-- `user_may_publish_into(uuid)` and every trigger function are deliberately absent: a function that
-- wants in must be added here on purpose, in review.
select is_empty($$
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and p.oid not in (
       select allowed.proc::oid
         from (values
           ('public.current_organisation_id()'::regprocedure),
           ('public.set_tenant_scope(uuid)'::regprocedure),
           ('public.clear_tenant_scope()'::regprocedure),
           ('public.is_active_member(uuid)'::regprocedure),
           ('public.is_project_member(uuid)'::regprocedure),
           ('public.resolve_tenant_host(text)'::regprocedure),
           ('public.data_class_is_valid(text)'::regprocedure),
           ('public.data_class_rank(text)'::regprocedure),
           ('public.data_class_is_ingestible_in_m1(text)'::regprocedure),
           ('public.collection_is_readable(uuid)'::regprocedure),
           ('public.source_is_readable(uuid)'::regprocedure),
           ('public.source_version_is_readable(uuid)'::regprocedure),
           ('public.chunk_is_readable(uuid)'::regprocedure),
           ('public.begin_upload_session_v1(uuid, text, text, bigint)'::regprocedure),
           ('public.register_source_version_v1(uuid, text, bigint, text)'::regprocedure),
           ('public.record_upload_outcome_v1(uuid, text, text)'::regprocedure)
         ) as allowed(proc)
     )
$$, '32 no function in public is executable by authenticated beyond the named allow-list (§4.3, #60)');

-- 33 the other schemas stay shut to both request roles: `toi_identity` (session functions, #75
-- pending) and `intake` (pilot inquiries, granted only to `inquiry_writer`).
select is_empty($$
  select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('toi_identity', 'intake')
     and p.prokind = 'f'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
$$, '33 neither anon nor authenticated can execute anything in toi_identity or intake (§4.3)');

-- ---------------------------------------------------------------- 34-36 Addition 1: close the default
-- `alter default privileges … revoke execute on functions from public, anon, authenticated` is the
-- part that stops the class instead of this instance. It is per-role, so first pin which role the
-- migrations actually ran as: that is the role the statement must target, and if the hosted roles
-- differ the supervisor's ruling is to drop the line and say so on the PR.
select is((
  select pg_get_userbyid(p.proowner)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolve_tenant_host'
), 'postgres',
  '34 the migration role that owns the public functions is postgres, so the default-privileges '
  || 'statement targets the role that creates them (#60 Addition 1)');

select ok((select count(*) > 0
  from pg_default_acl da
  join pg_namespace n on n.oid = da.defaclnamespace
  join pg_roles r on r.oid = da.defaclrole
  where n.nspname = 'public' and da.defaclobjtype = 'f'
    and r.rolname = (select pg_get_userbyid(p.proowner)
                       from pg_proc p
                       join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname = 'resolve_tenant_host')),
  '35 a default-privilege row for functions in public exists for that role (#60 Addition 1)');

select is_empty($$
  select a.grantee::text as grantee, a.privilege_type
    from pg_default_acl da
    join pg_namespace n on n.oid = da.defaclnamespace
   cross join lateral aclexplode(da.defacl) a
   where n.nspname = 'public' and da.defaclobjtype = 'f'
     and a.privilege_type = 'EXECUTE'
     and (a.grantee is null or a.grantee::regrole::text in ('public', 'anon', 'authenticated'))
$$, '36 no default-privilege row in public hands EXECUTE on future functions to public, anon or '
   || 'authenticated (grantee is null for PUBLIC in aclexplode)');

-- ---------------------------------------------------------------- 37-38 the default in behaviour, not catalog
-- A function created by that role after the hardening is unreachable to both request roles. This is
-- the assertion that catches a hosted role the ALTER DEFAULT PRIVILEGES statement does not cover:
-- if it fails, the statement is targeting the wrong role and gets dropped, not this test.
set local role postgres;
create function public.probe_001_default_privileges() returns boolean
  language sql as $$ select true $$;
select is(has_function_privilege('anon', 'public.probe_001_default_privileges()', 'execute'), false,
  '37 a function added after the hardening is not executable by anon by default (#60 Addition 1)');
select is(has_function_privilege('authenticated', 'public.probe_001_default_privileges()', 'execute'), false,
  '38 and not by authenticated either: the default is closed at the source, not per migration');
drop function public.probe_001_default_privileges();
reset role;

-- 39 the guardrails file stays small: this suite is the one that carries the privilege rules (§6b).
select ok((select count(*) = 2
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('data_class_rank', 'data_class_is_valid')),
  '39 sanity: the two knowledge helpers this file names really exist, so 1-22 are not vacuous');

select * from finish();
rollback;
