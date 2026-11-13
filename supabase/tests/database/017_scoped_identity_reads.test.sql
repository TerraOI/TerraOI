-- T-102h / PR #171 review B2: the sign-in bootstrap reads are RPCs, not direct table SELECTs.
-- Two shapes, both pinned here. `current_policy_revision_v1` follows FAQ-0011 exactly (the tenant
-- argument first, `set_tenant_scope` as its first statement, the scope live for the work in the same
-- transaction). `current_membership_v1` is the named carve-out of ADR-0003 §3b: it reads only the
-- caller's own row and sets no scope, because set_tenant_scope refuses any non-active member
-- (20261105060000_tenancy_core.sql:214) and the invited claim in F05 must see its own row first.
-- Negative cases per AGENTS.md §4.2: another tenant, a deactivated member, an anonymous caller.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

-- Fixtures for the carve-out and for the self-row ceiling, in this test transaction only: the
-- Company1 owner holds an *invited* membership in Company2, so "invited" is a row that exists here
-- and not a status the code merely imagines.
insert into public.organisation_memberships (organisation_id, user_id, status)
values ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a1', 'invited')
on conflict (organisation_id, user_id) do nothing;

-- Helpers report a refusal as its SQLSTATE instead of aborting the test transaction, and run with the
-- privileges of the role under test — the 010 pattern.
create function pg_temp.try_policy(p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.current_policy_revision_v1(p_organisation_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- FAQ-0011 is about the scope being live for the work in the SAME transaction, so these helpers read
-- the scope immediately after the call rather than in a later request. Order matters in this file:
-- the "none" assertion (11) runs before any scoped read, because set_config(is_local => true) lives
-- to the end of the transaction.
create function pg_temp.scope_after_membership(p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
declare v_count int;
begin
  select count(*) into v_count from public.current_membership_v1(p_organisation_id);
  return coalesce(public.current_organisation_id()::text, 'none');
end;
$fn$;

create function pg_temp.policy_and_scope(p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
declare v_revision bigint;
begin
  select public.current_policy_revision_v1(p_organisation_id) into v_revision;
  return coalesce(v_revision::text || '|' || coalesce(public.current_organisation_id()::text, 'none'), 'none');
exception when others then
  return 'refused:' || sqlstate::text;
end;
$fn$;

-- ---------------------------------------------------------------- privileges and shape (FAQ-0010)
select is(has_function_privilege('anon', 'public.current_membership_v1(uuid)', 'execute'), false,
  '1 anon cannot execute the membership read: it is keyed to auth.uid()');
select is(has_function_privilege('anon', 'public.current_policy_revision_v1(uuid)', 'execute'), false,
  '2 anon cannot execute the policy read');
select is(has_function_privilege('service_role', 'public.current_policy_revision_v1(uuid)', 'execute'), false,
  '3 service_role holds no grant here either: nothing reads tenancy through a privileged path');
select ok(has_function_privilege('authenticated', 'public.current_membership_v1(uuid)', 'execute'),
  '4 authenticated can execute the membership read');
select ok(has_function_privilege('authenticated', 'public.current_policy_revision_v1(uuid)', 'execute'),
  '5 authenticated can execute the policy read');

select is(
  pg_get_function_identity_arguments('public.current_membership_v1(uuid)'::regprocedure),
  'p_organisation_id uuid',
  '6 the membership read takes only the organization: no argument can name another user');

select is_empty($$
  select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('current_membership_v1', 'current_policy_revision_v1')
     and p.prosecdef
  $$,
  '7 both reads are SECURITY INVOKER: a definer version would see rows the caller''s RLS forbids');

-- ---------------------------------------------------------------- the bootstrap read, as its own user
-- Capture tables are created by the role that fills them and asserted by the migration owner (010).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

create temp table t_mem_a1 (case_name text, membership_id uuid, organisation_id uuid, status text);
insert into t_mem_a1
  select 'org1', m.* from public.current_membership_v1('11111111-1111-4111-8111-111111111111') m;
insert into t_mem_a1
  select 'org2_invited', m.* from public.current_membership_v1('22222222-2222-4222-8222-222222222222') m;

create temp table t_out_a1 (case_name text, result text);
insert into t_out_a1 values
  ('scope_from_membership', pg_temp.scope_after_membership('11111111-1111-4111-8111-111111111111')),
  ('policy_and_scope', pg_temp.policy_and_scope('11111111-1111-4111-8111-111111111111')),
  ('policy_in_other_tenant', pg_temp.try_policy('22222222-2222-4222-8222-222222222222'));

reset role;

select is((select count(*)::int from t_mem_a1 where case_name = 'org1'), 1::int,
  '8 an active member reading their own tenant gets exactly one row');
select is((select membership_id from t_mem_a1 where case_name = 'org1'),
  (select m.id from public.organisation_memberships m
    where m.organisation_id = '11111111-1111-4111-8111-111111111111'::uuid
      and m.user_id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  '9 the row returned is the caller''s own membership id, not another member''s');
select is((select count(*)::int from public.organisation_memberships
            where organisation_id = '11111111-1111-4111-8111-111111111111'), 4::int,
  '10 (fixture) this tenant does hold several memberships, so test 9 has something to fail against');
select is((select status from t_mem_a1 where case_name = 'org2_invited'), 'invited',
  '11 the invited claim path can read its own invited row before any scope exists (F05, ADR-0003 §3b)');
select is((select result from t_out_a1 where case_name = 'scope_from_membership'), 'none',
  '12 the bootstrap read leaves no tenant scope set: it cannot activate an unauthorized session');
select is((select result from t_out_a1 where case_name = 'policy_and_scope'),
  (select policy_revision::text from public.organisations
    where id = '11111111-1111-4111-8111-111111111111') || '|11111111-1111-4111-8111-111111111111',
  '13 the scoped read returns the row value and holds the scope in its own transaction (FAQ-0011)');
select is((select result from t_out_a1 where case_name = 'policy_in_other_tenant'), '28000',
  '14 the invited user cannot get a scoped read in that tenant: invited is not active');

-- ---------------------------------------------------------------- another tenant
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';

create temp table t_mem_b1 (case_name text, membership_id uuid, organisation_id uuid, status text);
insert into t_mem_b1
  select 'as_org1', m.* from public.current_membership_v1('11111111-1111-4111-8111-111111111111') m;
create temp table t_out_b1 (case_name text, result text);
insert into t_out_b1 values
  ('policy_org1', pg_temp.try_policy('11111111-1111-4111-8111-111111111111'));

reset role;

select is((select count(*)::int from t_mem_b1 where case_name = 'as_org1'), 0::int,
  '15 a Company2 member reading Company1 gets no membership row: the read is own-row bounded (§4.3)');
select is((select result from t_out_b1 where case_name = 'policy_org1'), '28000',
  '16 another tenant''s member is refused outright, never answered with an empty value (§4.2)');

-- ---------------------------------------------------------------- a deactivated member
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';

create temp table t_mem_a3 (case_name text, membership_id uuid, organisation_id uuid, status text);
insert into t_mem_a3
  select 'suspended', m.* from public.current_membership_v1('11111111-1111-4111-8111-111111111111') m;
create temp table t_out_a3 (case_name text, result text);
insert into t_out_a3 values
  ('policy_org1', pg_temp.try_policy('11111111-1111-4111-8111-111111111111'));

reset role;

select is((select status from t_mem_a3 where case_name = 'suspended'), 'suspended',
  '17 a suspended membership is still visible to its own user, so sign-in can name what ended it');
select is((select result from t_out_a3 where case_name = 'policy_org1'), '28000',
  '18 a deactivated member gets no scoped read: a suspended membership grants nothing (§4.2)');

-- ---------------------------------------------------------------- the direct reads stay gone
select is_empty($$
  select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('organisation_memberships', 'organisations')
     and has_table_privilege('anon', c.oid, 'SELECT')
  $$,
  '19 neither table is selectable anonymously: the bootstrap path cannot be a direct read');

select * from finish();
rollback;
