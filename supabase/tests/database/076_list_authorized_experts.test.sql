-- T-311 PR-4 (#221 N1) — scoped `list_authorized_experts_v1` for Auto / routeExpert.
-- Depends on `075_experts_and_prompts` tables/seeds and company1/company2 fixtures.
-- Written with the migration (TDD); CI `database` job is the runner (FAQ-0009).
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

create function pg_temp.try_sql(p_sql text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_list(p_organisation_id uuid)
returns text language plpgsql security invoker as $fn$
declare
  v text;
begin
  begin
    select coalesce(
      string_agg(expert_key || '@' || expert_version || ':' || service_key || '/' || status, ','
                 order by service_key, expert_key),
      ''
    )
      into v
      from public.list_authorized_experts_v1(p_organisation_id);
    return v;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- ---------------------------------------------------------------- 1-5 shape, privileges, column surface
select has_function(
  'public', 'list_authorized_experts_v1', array['uuid'],
  '1 list_authorized_experts_v1(uuid) exists'
);

select is(
  (select prosecdef
     from pg_proc
    where oid = 'public.list_authorized_experts_v1(uuid)'::regprocedure),
  true,
  '2 list_authorized_experts_v1 is SECURITY DEFINER (expert_definitions has no request-role SELECT)'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.list_authorized_experts_v1(uuid)',
    'execute'
  ),
  true,
  '3 authenticated may execute list_authorized_experts_v1'
);

select is(
  (has_function_privilege('anon', 'public.list_authorized_experts_v1(uuid)', 'execute')
   or has_function_privilege('service_role', 'public.list_authorized_experts_v1(uuid)', 'execute')),
  false,
  '4 anon and service_role cannot execute list_authorized_experts_v1'
);

select is_empty(
  $$
    select p.proargnames[i] as col
      from pg_proc p
      cross join lateral generate_subscripts(p.proargnames, 1) as i
     where p.oid = 'public.list_authorized_experts_v1(uuid)'::regprocedure
       and p.proargmodes[i] = 't'
       and p.proargnames[i] in ('model_chains', 'collection_bindings', 'vocabulary_override',
                                'prompt_template_id', 'refusal_templates', 'limits')
  $$,
  '5 return columns never expose model_chains, collection_bindings or other definition secrets (#221 N1)'
);

-- Index-loop + string_agg (026 brand_config idiom). Avoid results_eq here: comparing name
-- columns from pg_proc trips "could not determine which collation to use" on CI.
select is(
  (select string_agg(p.proargnames[i], ',' order by i)
     from pg_proc p
     cross join lateral generate_subscripts(p.proargnames, 1) as i
    where p.oid = 'public.list_authorized_experts_v1(uuid)'::regprocedure
      and p.proargmodes[i] = 't'),
  'expert_key,expert_version,service_key,status',
  '6 return shape is exactly expert_key, expert_version, service_key, status'
);

-- ---------------------------------------------------------------- 7-12 entitle + scoped reads
-- Test-only grants (rolled back): pgTAP lives in `extensions`, which toi_control_plane has no
-- USAGE on — same pattern as 030_pilot_inquiries for inquiry_writer.
grant toi_control_plane to postgres;
grant usage on schema extensions to toi_control_plane;
set local role toi_control_plane;
select lives_ok(
  $sql$
    select 1 from toi_control.entitle_tenant_service_v1(
      '11111111-1111-4111-8111-111111111111',
      'uav-compliance', 'uav-expert', '1.0.0',
      array['51000000-0000-4000-8000-000000000001']::uuid[],
      '076 list read fixture', 'supervisor@terraoi.test'
    )
  $sql$::text,
  '7 control plane entitles company1 uav-expert with a collection binding'::text
);
select lives_ok(
  $sql$
    select 1 from toi_control.entitle_tenant_service_v1(
      '22222222-2222-4222-8222-222222222222',
      'gpr', 'gpr-expert', '1.0.0',
      '{}'::uuid[],
      '076 list read fixture company2', 'supervisor@terraoi.test'
    )
  $sql$::text,
  '8 control plane entitles company2 gpr-expert'::text
);
reset role;

create temp table t_list_probes (case_name text primary key, result text not null);
grant insert on t_list_probes to authenticated;

-- company1 owner sees uav only (registered seed), never company2
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_list_probes values
  ('c1', pg_temp.try_list('11111111-1111-4111-8111-111111111111'));
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_list_probes values
  ('c2', pg_temp.try_list('22222222-2222-4222-8222-222222222222'));
reset role;

-- company1 member cannot read company2 via forged organisation argument
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_list_probes values
  ('c1_forged_c2', pg_temp.try_list('22222222-2222-4222-8222-222222222222'));
reset role;

-- suspended company1 member (a3)
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_list_probes values
  ('suspended', pg_temp.try_list('11111111-1111-4111-8111-111111111111'));
reset role;

-- unentitled: company1 has no gpr; empty list (not an error) when only uav is entitled
-- (already covered by c1). Disabled binding: disable company1 expert and re-list.
update public.tenant_experts
   set enabled = false
 where organisation_id = '11111111-1111-4111-8111-111111111111'
   and expert_key = 'uav-expert';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_list_probes values
  ('c1_disabled', pg_temp.try_list('11111111-1111-4111-8111-111111111111'));
reset role;

-- restore for remaining assertions
update public.tenant_experts
   set enabled = true
 where organisation_id = '11111111-1111-4111-8111-111111111111'
   and expert_key = 'uav-expert';

select is((select result from t_list_probes where case_name = 'c1'),
  'uav-expert@1.0.0:uav-compliance/registered',
  '9 company1 member lists only the entitled uav-expert with status, never company2');

select is((select result from t_list_probes where case_name = 'c2'),
  'gpr-expert@1.0.0:gpr/registered',
  '10 company2 member lists only the entitled gpr-expert');

select is((select result from t_list_probes where case_name = 'c1_forged_c2'), '28000',
  '11 company1 member naming company2 as p_organisation_id is refused (28000)');

select is((select result from t_list_probes where case_name = 'suspended'), '28000',
  '12 suspended membership is refused by set_tenant_scope (28000), never an empty leak');

select is((select result from t_list_probes where case_name = 'c1_disabled'), '',
  '13 a disabled tenant_experts binding is omitted from the list');

-- ---------------------------------------------------------------- 14-16 no secret columns in the row payload itself
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(
  (select count(*)::integer
     from public.list_authorized_experts_v1('11111111-1111-4111-8111-111111111111') r
    where to_jsonb(r) ? 'collection_bindings'
       or to_jsonb(r) ? 'model_chains'
       or to_jsonb(r) ? 'vocabulary_override'),
  0,
  '14 live rows never carry collection_bindings, model_chains or vocabulary_override keys'
);
select is(
  (select status from public.list_authorized_experts_v1('11111111-1111-4111-8111-111111111111') limit 1),
  'registered',
  '15 listed status is read from expert_definitions via the definer (seed stays registered)'
);
reset role;

-- collection_bindings still exist on the table for control-plane use, but the RPC projection
-- is what ordinary members reach. Pin that the entitled row still stores the binding server-side.
select is(
  (select cardinality(collection_bindings)
     from public.tenant_experts
    where organisation_id = '11111111-1111-4111-8111-111111111111'
      and expert_key = 'uav-expert'),
  1,
  '16 server-side collection_bindings remain on tenant_experts; only the RPC omits them'
);

select * from finish();
rollback;
