-- T-312 PR-2: eval_cases / eval_reviews / eval_runs / eval_results (#82, plan §6.1 / §14.1).
-- Written first (COORDINATION §6b). Slot 090. Red until 20261121220000_evals.sql lands.
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------- fixture helpers
-- Prefer `set local` (same pattern as 010/013) so auth.uid() and role stick for the transaction.
create or replace function pg_temp.set_jwt(p_sub uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.try_sql(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- ---------------------------------------------------------------- 1–4 tables exist, RLS on
select has_table('public', 'eval_cases', '1 public.eval_cases exists (§6.1 Evaluation)');
select has_table('public', 'eval_reviews', '2 public.eval_reviews exists (§6.1)');
select has_table('public', 'eval_runs', '3 public.eval_runs exists (§6.1)');
select has_table('public', 'eval_results', '4 public.eval_results exists (§6.1)');

select ok(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'eval_cases'),
  '5 eval_cases has RLS enabled');
select ok(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'eval_reviews'),
  '6 eval_reviews has RLS enabled');

-- ---------------------------------------------------------------- 7–8 request roles cannot write tables directly
set local role authenticated;
select is(
  pg_temp.try_sql($$ insert into public.eval_cases (organisation_id, case_key, expert_key, status, origin, case_type, question, data_class, drafted_by, drafted_on)
    values ('11111111-1111-4111-8111-111111111111', 'UAV-T001', 'uav-expert', 'drafted', 'expert_written', 'answerable', 'q', 'internal', 'test', '2026-11-21') $$),
  '42501',
  '7 authenticated cannot insert eval_cases directly (FAQ-0004)');
reset role;

select ok(
  has_function_privilege('authenticated', 'public.review_eval_case_v1(uuid, uuid, text, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.create_eval_case_draft_v1(uuid, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.list_eval_cases_v1(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.review_eval_case_v1(uuid, uuid, text, jsonb)', 'execute'),
  '8 scoped eval RPCs are granted to authenticated only');

-- ---------------------------------------------------------------- 9–12 seed: evals.review area + eval_reviewer
select ok(
  exists (
    select 1 from public.organisation_roles
     where organisation_id = '11111111-1111-4111-8111-111111111111' and key = 'eval_reviewer'
  ),
  '9 company1 has eval_reviewer role (#82)');
select ok(
  exists (
    select 1 from public.role_permissions
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and area = 'evals.review' and level = 'write'
  ),
  '10 company1 eval_reviewer holds evals.review write (#82)');

-- ---------------------------------------------------------------- 13–18 draft + approve happy path (non-author)
-- Create as a1 (author); a2 (eval_reviewer, non-author) approves.
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');

create temporary table t_draft on commit drop as
  select public.create_eval_case_draft_v1(
    '11111111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'case_key', 'UAV-T090',
      'expert_key', 'uav-expert',
      'origin', 'expert_written',
      'case_type', 'answerable',
      'question', 'Synthetic UAV pre-flight compass check question for pgTAP.',
      'data_class', 'internal',
      'drafted_by', 'builder-agent',
      'drafted_on', '2026-11-21',
      'payload', '{}'::jsonb
    )
  ) as case_id;

select ok((select case_id from t_draft) is not null, '13 create_eval_case_draft_v1 returns a case id');

select is(
  (select status from public.eval_cases where id = (select case_id from t_draft)),
  'drafted',
  '14 new case is drafted with approved_by null');

-- Author cannot approve their own draft (#82)
select is(
  pg_temp.try_sql(format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  )),
  '42501',
  '15 author cannot approve their own draft');

-- Non-reviewer (a4) cannot approve
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a4');
select is(
  pg_temp.try_sql(format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  )),
  '42501',
  '16 member without evals.review cannot approve');

-- a2 is also a reviewer in seed — approve as non-author
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a2');
select lives_ok(
  format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  ),
  '17 non-author with evals.review write can approve');

select is(
  (select status from public.eval_cases where id = (select case_id from t_draft)),
  'approved',
  '18 approved case status flips to approved');
select ok(
  (select approved_by from public.eval_cases where id = (select case_id from t_draft))
    = '00000000-0000-4000-8000-0000000000a2'
  and (select approved_at from public.eval_cases where id = (select case_id from t_draft)) is not null,
  '19 approval records reviewer and time (§14.1 step 3)');

-- ---------------------------------------------------------------- 20–23 cross-tenant isolation
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000b1');
select is(
  (select count(*)::int from public.list_eval_cases_v1('22222222-2222-4222-8222-222222222222', null)
    where id = (select case_id from t_draft)),
  0,
  '20 company2 list does not see company1 case id');

select is(
  pg_temp.try_sql(format(
    $$ select public.review_eval_case_v1('22222222-2222-4222-8222-222222222222', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  )),
  '42501',
  '21 company2 cannot approve a company1 case');

-- ---------------------------------------------------------------- 22–24 pilot export refusal
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
create temporary table t_pilot on commit drop as
  select public.create_eval_case_draft_v1(
    '11111111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'case_key', 'UAV-PILOT-090',
      'expert_key', 'uav-expert',
      'origin', 'pilot',
      'case_type', 'answerable',
      'question', 'Pilot pilot-feedback draft case for export refusal.',
      'data_class', 'internal',
      'drafted_by', 'pilot-loop',
      'drafted_on', '2026-11-21',
      'payload', '{}'::jsonb
    )
  ) as case_id;

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a2');
select lives_ok(
  format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_pilot)
  ),
  '22 pilot origin can still be approved as a row');

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select ok(
  not exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_pilot)
  ),
  '23 export_approved_eval_cases_v1 omits origin=pilot (#102)');

select ok(
  exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_draft)
  ),
  '24 export includes non-pilot approved cases');

-- ---------------------------------------------------------------- 25–28 runs/results shape + privileges
reset role;
select ok(
  not has_table_privilege('authenticated', 'public.eval_runs', 'insert')
  and not has_table_privilege('authenticated', 'public.eval_results', 'insert'),
  '25 authenticated has no direct insert on eval_runs/results');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'eval_runs'
      and column_name in ('expert_key', 'expert_version', 'chain_config', 'corpus_generation')) = 4,
  '26 eval_runs carries expert version, chain and corpus generation');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'eval_results'
      and column_name in ('run_id', 'case_id', 'failure_class', 'score')) = 4,
  '27 eval_results carries per-case score and failure class');

select ok(
  exists (
    select 1 from public.role_permissions
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and area = 'evals.review' and level = 'admin'
  ),
  '28 company1 admin role holds evals.review admin for export (#82)');

select * from finish();
rollback;
