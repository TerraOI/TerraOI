-- T-003 tenancy core: RLS, membership, project audience and the transaction-local tenant scope.
-- Plan §4.1–§4.3, §6.2; F01–F03. Negative cases per AGENTS.md §4.2 and plan §20.4 item 5:
-- another tenant, another project, a deactivated member.
-- Fixtures are the synthetic ones in supabase/seed.sql, applied by `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

-- Helpers report an error as its SQLSTATE instead of aborting the test transaction.
-- SECURITY INVOKER on purpose: they run with the privileges of the role under test.
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

create function pg_temp.try_host(p_host text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.resolve_tenant_host(p_host);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_domain(p_organisation_id uuid, p_host text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.tenant_domains (organisation_id, host) values (p_organisation_id, p_host);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_project_membership(p_organisation_id uuid, p_project_id uuid, p_user_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    insert into public.project_memberships (organisation_id, project_id, user_id)
      values (p_organisation_id, p_project_id, p_user_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.call_clear_scope() returns text
language plpgsql security invoker as $fn$
begin
  perform public.clear_tenant_scope();
  return 'ok';
end;
$fn$;

-- Capture tables are created by the role that fills them, so grants and RLS apply to the reads
-- that populate them; the assertions then run as the migration owner.
set local role authenticated;
create temp table t_orgs (case_name text, id uuid);
create temp table t_projects (case_name text, id uuid);
create temp table t_domains (case_name text, host text);
create temp table t_profiles (case_name text, id uuid);
create temp table t_scoped (case_name text, org uuid);
create temp table t_out (case_name text, result text);
reset role;

-- ---------------------------------------------------------------- guardrails and grants
select is((select count(*)::int
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0::int, '1 every public table still has RLS enabled (guardrail 000)');

select is(has_table_privilege('anon', 'public.tenant_domains', 'select'), false,
  '2 an anonymous caller cannot enumerate tenants through the API');

select is(has_table_privilege('authenticated', 'public.organisations', 'insert'), false,
  '3 tenancy writes are not a member privilege: they go through a scoped RPC or a privileged path');

-- ---------------------------------------------------------------- F01 host resolution
set local role anon;
create temp table t_anon_hosts (case_name text, organisation_id uuid);
insert into t_anon_hosts select 'known', organisation_id from public.resolve_tenant_host('company1.terraoi.app');
insert into t_anon_hosts select 'staging', organisation_id from public.resolve_tenant_host('company1-staging.terraoi.app');
insert into t_anon_hosts select 'unknown', organisation_id from public.resolve_tenant_host('company3.terraoi.app');
insert into t_anon_hosts select 'lookalike', organisation_id from public.resolve_tenant_host('evil.terraoi.app');
reset role;

-- The resolver's normalization guard, checked by the owner (anon has no write access anywhere).
insert into t_out values
  ('host_upper', pg_temp.try_host('Company1.TerraOI.App')),
  ('host_port', pg_temp.try_host('company1.terraoi.app:8443'));

select is((select count(*)::int from t_anon_hosts where case_name = 'known'), 1::int,
  '4 an exact active host resolves to exactly one tenant row');
select is((select organisation_id from t_anon_hosts where case_name = 'known'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '5 the resolved host maps to the registered organization');
select is((select count(*)::int from t_anon_hosts where case_name = 'unknown'), 0::int,
  '6 an unregistered host resolves to nothing, never to a default tenant');
select is((select count(*)::int from t_anon_hosts where case_name = 'lookalike'), 0::int,
  '7 a look-alike host resolves to nothing: no suffix matching (§4.1 step 2)');
select is((select count(*)::int from t_anon_hosts where case_name = 'staging'), 1::int,
  '8 the staging origin is its own explicit host row, not an alias of production');
select is((select result from t_out where case_name = 'host_upper'), '22023',
  '9 the resolver refuses a host that is not normalized instead of guessing');
select is((select result from t_out where case_name = 'host_port'), '22023',
  '10 the resolver refuses a host carrying a port');

-- ---------------------------------------------------------------- tenant_domains constraints
insert into t_out values
  ('domain_upper', pg_temp.try_domain('11111111-1111-4111-8111-111111111111', 'Company1.TerraOI.App')),
  ('domain_port', pg_temp.try_domain('11111111-1111-4111-8111-111111111111', 'company1.terraoi.app:8443')),
  ('domain_deep', pg_temp.try_domain('11111111-1111-4111-8111-111111111111', 'deep.sub.company1.terraoi.app')),
  ('domain_dup', pg_temp.try_domain('22222222-2222-4222-8222-222222222222', 'company1.terraoi.app')),
  ('project_xtenant', pg_temp.try_project_membership(
      '11111111-1111-4111-8111-111111111111',
      '42000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-0000000000a1'));

select is((select result from t_out where case_name = 'domain_upper'), '23514',
  '11 a mixed-case host is rejected by the column check, not silently normalized somewhere else');
select is((select result from t_out where case_name = 'domain_port'), '23514',
  '12 a host with a port cannot be registered');
select is((select result from t_out where case_name = 'domain_deep'), '23514',
  '13 an extra subdomain level cannot be registered (§4.1 step 1)');
select is((select result from t_out where case_name = 'domain_dup'), '23505',
  '14 one host cannot be claimed by a second tenant (unique host)');
select is((select result from t_out where case_name = 'project_xtenant'), '23503',
  '15 the composite (project_id, organisation_id) FK makes a cross-tenant project reference impossible');

-- ---------------------------------------------------------------- F02/F03: company1 member
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('scope_c1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111')),
  ('scope_c2_forged', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_scoped select 'owner1', public.current_organisation_id();
insert into t_orgs select 'owner1', id from public.organisations;
insert into t_projects select 'owner1_scoped', id from public.projects;
insert into t_domains select 'owner1', host from public.tenant_domains;
insert into t_profiles select 'owner1', id from public.profiles;
reset role;

select is((select result from t_out where case_name = 'scope_c1'), 'ok',
  '16 an active member can set the tenant scope for their own tenant');
select is((select result from t_out where case_name = 'scope_c2_forged'), '28000',
  '17 a forged organization id argument grants nothing: membership decides, not the argument');
select is((select org from t_scoped where case_name = 'owner1'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '18 the rejected attempt set no scope, so the earlier one still stands');
select is((select count(*)::int from t_orgs where case_name = 'owner1'), 1::int,
  '19 a member sees their own organization row and no other tenant''s');
select is((select count(*)::int from t_projects where case_name = 'owner1_scoped'), 2::int,
  '20 scoped reads return only company1 projects: Site A (member) plus the tenant-visible one');
select is((select count(*)::int from t_domains where case_name = 'owner1'), 2::int,
  '21 a member sees only their own tenant''s hosts');
select is((select count(*)::int from t_profiles where case_name = 'owner1'), 1::int,
  '22 a member reads their own identity record only');

-- ---------------------------------------------------------------- project audience
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope_a2', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_projects select 'field2_scoped', id from public.projects;
reset role;

select is((select result from t_out where case_name = 'scope_a2'), 'ok',
  '23 a second company1 member can scope to the same tenant');
select is((select count(*)::int from t_projects where case_name = 'field2_scoped'), 1::int,
  '24 a member outside Site A sees only the tenant-visible project (project audience enforced)');

-- ---------------------------------------------------------------- deactivated membership
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_out values ('scope_left', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_orgs select 'left', id from public.organisations;
insert into t_profiles select 'left', id from public.profiles;
reset role;

select is((select result from t_out where case_name = 'scope_left'), '28000',
  '25 a suspended membership cannot scope, even holding the right organization id');
select is((select count(*)::int from t_orgs where case_name = 'left'), 0::int,
  '26 the deactivated member sees no tenant rows at all');
select is((select count(*)::int from t_profiles where case_name = 'left'), 1::int,
  '27 they keep their own identity record, which grants no tenant data');

-- ---------------------------------------------------------------- two memberships, one session
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
insert into t_out values ('multi_c1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_orgs select 'multi', id from public.organisations;
insert into t_projects select 'multi_c1', id from public.projects;
insert into t_out values ('multi_c2', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_projects select 'multi_c2', id from public.projects;
reset role;

select is((select result from t_out where case_name = 'multi_c1'), 'ok',
  '28 a member of two tenants can scope to the first');
select is((select result from t_out where case_name = 'multi_c2'), 'ok',
  '29 and re-scope to the second');
select is((select count(*)::int from t_orgs where case_name = 'multi'), 2::int,
  '30 they see exactly the two tenants they belong to, and no third');
select is((select count(*)::int from t_projects where case_name = 'multi_c1'), 2::int,
  '31 under the company1 scope they see company1 projects');
select is((select count(*)::int from t_projects where case_name = 'multi_c2'), 1::int,
  '32 after re-scoping they see company2 only: the first scope did not leak into the second read');

-- ---------------------------------------------------------------- scope hygiene
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('cleared', pg_temp.call_clear_scope());
insert into t_scoped select 'unscoped', public.current_organisation_id();
insert into t_projects select 'unscoped', id from public.projects;
reset role;

select ok((select org from t_scoped where case_name = 'unscoped') is null,
  '33 clearing the scope leaves no tenant context behind');
select is((select count(*)::int from t_projects where case_name = 'unscoped'), 0::int,
  '34 tenant reads without a scope return nothing (fail closed, §4.3)');

savepoint sp_scope_demo;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_scoped select 'in_txn', public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
insert into t_projects select 'in_txn', id from public.projects;
reset role;

select is((select org from t_scoped where case_name = 'in_txn'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '35 the scope holds for the rest of this transaction, so one RPC can scope then read (§4.3)');
select is((select count(*)::int from t_projects where case_name = 'in_txn'), 2::int,
  '36 and that same transaction sees the scoped tenant''s projects');

rollback to savepoint sp_scope_demo;

select ok(public.current_organisation_id() is null,
  '37 the scope is transaction-local, never session state a pooled connection could hand to the next request');

select * from finish();
rollback;
