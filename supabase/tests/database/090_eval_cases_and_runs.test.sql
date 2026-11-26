-- T-312 PR-2: eval_cases / eval_reviews / eval_runs / eval_results (#82, plan §6.1 / §14.1).
-- Written first (COORDINATION §6b). Slot 090. Red until 20261125100000_evals.sql lands.
begin;
create extension if not exists pgtap with schema extensions;

select plan(53);

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

-- ---------------------------------------------------------------- 9–10 seed: evals.review area + eval_reviewer
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

-- ---------------------------------------------------------------- 11–17 draft + approve happy path (non-author)
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

select ok((select case_id from t_draft) is not null, '11 create_eval_case_draft_v1 returns a case id');

select is(
  (select status from public.eval_cases where id = (select case_id from t_draft)),
  'drafted',
  '12 new case is drafted with approved_by null');

-- Author cannot approve their own draft (#82)
select is(
  pg_temp.try_sql(format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  )),
  '42501',
  '13 author cannot approve their own draft');

-- Non-reviewer (a4) cannot approve
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a4');
select is(
  pg_temp.try_sql(format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  )),
  '42501',
  '14 member without evals.review cannot approve');

-- a2 is also a reviewer in seed — approve as non-author
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a2');
select lives_ok(
  format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  ),
  '15 non-author with evals.review write can approve');

select is(
  (select status from public.eval_cases where id = (select case_id from t_draft)),
  'approved',
  '16 approved case status flips to approved');
select ok(
  (select approved_by from public.eval_cases where id = (select case_id from t_draft))
    = '00000000-0000-4000-8000-0000000000a2'
  and (select approved_at from public.eval_cases where id = (select case_id from t_draft)) is not null,
  '17 approval records reviewer and time (§14.1 step 3)');

-- ---------------------------------------------------------------- 18–19 cross-tenant isolation
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000b1');
select is(
  (select count(*)::int from public.list_eval_cases_v1('22222222-2222-4222-8222-222222222222', null)
    where id = (select case_id from t_draft)),
  0,
  '18 company2 list does not see company1 case id');

select is(
  pg_temp.try_sql(format(
    $$ select public.review_eval_case_v1('22222222-2222-4222-8222-222222222222', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_draft)
  )),
  '42501',
  '19 company2 cannot approve a company1 case');

-- ---------------------------------------------------------------- 20–22 pilot export refusal
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
  '20 pilot origin can still be approved as a row');

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select ok(
  not exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_pilot)
  ),
  '21 export_approved_eval_cases_v1 omits origin=pilot (#102)');

select ok(
  exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_draft)
  ),
  '22 export includes non-pilot approved cases');

-- ---------------------------------------------------------------- 23–26 runs/results shape + privileges
reset role;
select ok(
  not has_table_privilege('authenticated', 'public.eval_runs', 'insert')
  and not has_table_privilege('authenticated', 'public.eval_results', 'insert'),
  '23 authenticated has no direct insert on eval_runs/results');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'eval_runs'
      and column_name in ('expert_key', 'expert_version', 'chain_config', 'corpus_generation')) = 4,
  '24 eval_runs carries expert version, chain and corpus generation');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'eval_results'
      and column_name in ('run_id', 'case_id', 'failure_class', 'score')) = 4,
  '25 eval_results carries per-case score and failure class');

select ok(
  exists (
    select 1 from public.role_permissions
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and area = 'evals.review' and level = 'admin'
  ),
  '26 company1 admin role holds evals.review admin for export (#82)');

-- ---------------------------------------------------------------- 27–33 supervisor round 1 on #240
-- 27 a member without evals.review cannot draft (any member could otherwise seed the queue).
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a4');
select is(
  pg_temp.try_sql($$
    select public.create_eval_case_draft_v1('11111111-1111-4111-8111-111111111111', jsonb_build_object(
      'case_key', 'UAV-T090-A4', 'expert_key', 'uav-expert', 'origin', 'expert_written',
      'case_type', 'answerable', 'question', 'Synthetic question.', 'data_class', 'internal',
      'drafted_by', 'a4', 'drafted_on', '2026-11-21'))
  $$),
  '42501',
  '27 a member without evals.review cannot draft an eval case');

-- 28 and reads an empty list rather than an error or another reviewer's cases.
select is(
  (select count(*)::int from public.list_eval_cases_v1('11111111-1111-4111-8111-111111111111', null)),
  0,
  '28 a member without evals.review lists no eval cases');

-- 29 a malformed drafted_on is a 22023 argument refusal, not a raw cast error.
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select is(
  pg_temp.try_sql($$
    select public.create_eval_case_draft_v1('11111111-1111-4111-8111-111111111111', jsonb_build_object(
      'case_key', 'UAV-T090-DATE', 'expert_key', 'uav-expert', 'origin', 'expert_written',
      'case_type', 'answerable', 'question', 'Synthetic question.', 'data_class', 'internal',
      'drafted_by', 'a1', 'drafted_on', 'not-a-date'))
  $$),
  '22023',
  '29 a malformed drafted_on is refused as an argument (22023)');

-- 30 an approver who stays active but loses evals.review no longer validates their approvals:
-- take a2's eval_reviewer role away (a2 has no other evals.review grant) and the case leaves export.
reset role;
delete from public.membership_roles mr
 using public.organisation_memberships m, public.organisation_roles r
 where mr.membership_id = m.id
   and mr.role_id = r.id
   and m.organisation_id = '11111111-1111-4111-8111-111111111111'
   and m.user_id = '00000000-0000-4000-8000-0000000000a2'
   and r.key = 'eval_reviewer';
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select ok(
  not exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_draft)
  ),
  '30 a case approved by a member who lost evals.review drops out of the export');
-- Restore the role so 32-33 test suspension on its own.
reset role;
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, r.id
  from public.organisation_memberships m
  join public.organisation_roles r on r.organisation_id = m.organisation_id and r.key = 'eval_reviewer'
 where m.organisation_id = '11111111-1111-4111-8111-111111111111'
   and m.user_id = '00000000-0000-4000-8000-0000000000a2';
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select ok(
  exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_draft)
  ),
  '31 with the role restored the approval counts again');

-- 32–33 an approval by a member who is later suspended stops counting: export drops the case, and
-- the suspended member can no longer review at all.
reset role;
update public.organisation_memberships
   set status = 'suspended'
 where organisation_id = '11111111-1111-4111-8111-111111111111'
   and user_id = '00000000-0000-4000-8000-0000000000a2';
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select ok(
  not exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_draft)
  ),
  '32 a case approved by a now-suspended member drops out of the export');
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a2');
select is(
  pg_temp.try_sql(format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_pilot)
  )),
  '28000',
  '33 a suspended member cannot review');
reset role;

-- ---------------------------------------------------------------- 34–41 record_eval_run_v1 (append-only)
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
create temporary table t_run1 on commit drop as
  select public.record_eval_run_v1(
    '11111111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'expert_key', 'uav-expert',
      'expert_version', '1.0.0-test',
      'chain_config', jsonb_build_object('compose', jsonb_build_array('local_box')),
      'corpus_generation', 'synth-corpus-090-a',
      'status', 'completed'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'case_id', (select case_id from t_draft),
        'score', 1,
        'failure_class', null,
        'evidence', '[]'::jsonb
      )
    )
  ) as run_id;

select ok((select run_id from t_run1) is not null, '34 record_eval_run_v1 returns a run id');

select is(
  (select count(*)::int from public.eval_results
    where run_id = (select run_id from t_run1)
      and case_id = (select case_id from t_draft)
      and failure_class is null
      and score = 1),
  1,
  '35 one result per case carries score and null failure_class');

create temporary table t_run2 on commit drop as
  select public.record_eval_run_v1(
    '11111111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'expert_key', 'uav-expert',
      'expert_version', '1.0.0-test',
      'chain_config', '{}'::jsonb,
      'corpus_generation', 'synth-corpus-090-b',
      'status', 'completed'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'case_id', (select case_id from t_draft),
        'score', 0,
        'failure_class', 'wrong_answer_status',
        'evidence', '[]'::jsonb
      )
    )
  ) as run_id;

select ok(
  (select run_id from t_run2) is distinct from (select run_id from t_run1),
  '36 a rerun writes a new run id');

select is(
  (select count(*)::int from public.eval_runs
    where id = (select run_id from t_run1)
      and corpus_generation = 'synth-corpus-090-a'
      and status = 'completed'),
  1,
  '37 the first run row is unchanged after a rerun');

select is(
  (select failure_class from public.eval_results
    where run_id = (select run_id from t_run1)
      and case_id = (select case_id from t_draft)),
  null,
  '38 the first run''s result row is not edited by a rerun');

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000b1');
select is(
  pg_temp.try_sql(format(
    $$ select public.record_eval_run_v1(
         '22222222-2222-4222-8222-222222222222',
         jsonb_build_object(
           'expert_key', 'uav-expert',
           'expert_version', '1.0.0-test',
           'chain_config', '{}'::jsonb,
           'corpus_generation', 'foreign',
           'status', 'completed'
         ),
         jsonb_build_array(
           jsonb_build_object('case_id', %L::uuid, 'score', 1, 'evidence', '[]'::jsonb)
         )
       ) $$,
    (select case_id from t_draft)
  )),
  '42501',
  '39 company2 cannot attach a company1 case id to an eval run');

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select is(
  pg_temp.try_sql(format(
    $$ select public.record_eval_run_v1('11111111-1111-4111-8111-111111111111',
         jsonb_build_object('expert_key', 'uav-expert', 'expert_version', '1', 'corpus_generation', 'g', 'status', 'completed'),
         jsonb_build_array(jsonb_build_object('case_id', %L::uuid, 'score', 7))) $$,
    (select case_id from t_draft)
  )),
  '22023',
  '40 a score outside 0..1 is refused as an argument');
select is(
  pg_temp.try_sql(format(
    $$ select public.record_eval_run_v1('11111111-1111-4111-8111-111111111111',
         jsonb_build_object('expert_key', 'gpr-expert', 'expert_version', '1', 'corpus_generation', 'g', 'status', 'completed'),
         jsonb_build_array(jsonb_build_object('case_id', %L::uuid, 'score', 1))) $$,
    (select case_id from t_draft)
  )),
  '22023',
  '41 a case from another expert is not a result of this run');

-- ---------------------------------------------------------------- 42–53 draft_eval_case_from_feedback_v1 (#102)
-- Fixture: a1's conversation with an internal question and a client_confidential answer of run R1,
-- plus a second answer (run R3) of a different expert. Seeded as postgres; the chat RPCs are T-104's.
reset role;
insert into public.conversations (id, organisation_id, user_id, expert_key)
values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a1', 'uav-expert');
insert into public.messages (id, organisation_id, conversation_id, role, body_text, data_class)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0', '11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'user',
        'Synthetic pilot question.', 'internal');
insert into public.agent_runs (id, organisation_id, conversation_id, requested_by, user_message_id,
                               idempotency_key, expert_key, status, data_class, policy_revision, completed_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '00000000-0000-4000-8000-0000000000a1',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0', 'idem-fb-1', 'uav-expert', 'answered', 'client_confidential', 1, now()),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '00000000-0000-4000-8000-0000000000a1',
        null, 'idem-fb-3', 'other-expert', 'answered', 'internal', 1, now());
insert into public.messages (id, organisation_id, conversation_id, role, body_text, data_class, run_id)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'assistant',
        'Synthetic answer.', 'client_confidential', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', '11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'assistant',
        'Synthetic answer from another expert.', 'internal', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3');

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select ok(
  has_function_privilege(
    'authenticated',
    'public.draft_eval_case_from_feedback_v1(uuid, jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.draft_eval_case_from_feedback_v1(uuid, jsonb)',
    'execute'
  ),
  '42 draft_eval_case_from_feedback_v1 is granted to authenticated only'
);

-- The caller labels it `internal`; the answer is client_confidential, so that is what is stored.
create temporary table t_fb on commit drop as
    select public.draft_eval_case_from_feedback_v1(
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'expert_key', 'uav-expert',
        'question', 'Synthetic pilot question used only for feedback-draft pgTAP.',
        'data_class', 'internal',
        'rating', 'incorrect',
        'derived_from_run_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'derived_from_message_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
      )
    ) as case_id;

select ok((select case_id from t_fb) is not null, '43 feedback RPC returns a case id');

select is(
  (select origin || ':' || status || ':' || data_class
     from public.eval_cases where id = (select case_id from t_fb)),
  'pilot:drafted:client_confidential',
  '44 feedback draft is origin=pilot, drafted, and never classed below the rated answer (§6.2)'
);

select ok(
  (select derived_from_run_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      and derived_from_message_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'::uuid
     from public.eval_cases where id = (select case_id from t_fb)),
  '45 provenance columns are set from the rating event'
);

select is(
  pg_temp.try_sql($$
    select public.draft_eval_case_from_feedback_v1(
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'expert_key', 'uav-expert',
        'question', 'Duplicate rating should not create a second pilot draft.',
        'data_class', 'internal',
        'rating', 'suggest_correction',
        'derived_from_run_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'derived_from_message_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
      )
    )
  $$),
  '23505',
  '46 duplicate derived_from_message_id is refused'
);

select is(
  pg_temp.try_sql($$
    select public.draft_eval_case_from_feedback_v1(
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'expert_key', 'uav-expert',
        'question', 'Missing provenance must fail closed.',
        'data_class', 'internal',
        'rating', 'incorrect'
      )
    )
  $$),
  '22023',
  '47 missing derived_from ids are refused'
);

select is(
  pg_temp.try_sql($$
    select public.draft_eval_case_from_feedback_v1(
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'expert_key', 'uav-expert',
        'question', 'A run id that did not produce this message.',
        'data_class', 'internal',
        'rating', 'incorrect',
        'derived_from_run_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        'derived_from_message_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
      )
    )
  $$),
  '42501',
  '48 a message that the named run did not produce is refused'
);

select is(
  pg_temp.try_sql($$
    select public.draft_eval_case_from_feedback_v1(
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'expert_key', 'uav-expert',
        'question', 'Expert key must match the rated run.',
        'data_class', 'internal',
        'rating', 'incorrect',
        'derived_from_run_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        'derived_from_message_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'
      )
    )
  $$),
  '22023',
  '49 an expert_key other than the rated run''s is refused'
);

-- a2 is an active member of the same organization but does not own the conversation.
reset role;
update public.organisation_memberships
   set status = 'active'
 where organisation_id = '11111111-1111-4111-8111-111111111111'
   and user_id = '00000000-0000-4000-8000-0000000000a2';
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a2');
select is(
  pg_temp.try_sql($$
    select public.draft_eval_case_from_feedback_v1(
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'expert_key', 'other-expert',
        'question', 'Another members answer.',
        'data_class', 'internal',
        'rating', 'incorrect',
        'derived_from_run_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        'derived_from_message_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'
      )
    )
  $$),
  '42501',
  '50 a member cannot draft a case from another member''s conversation'
);

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000b1');
select is(
  pg_temp.try_sql($$
    select public.draft_eval_case_from_feedback_v1(
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'expert_key', 'uav-expert',
        'question', 'Cross-tenant feedback draft must not land.',
        'data_class', 'internal',
        'rating', 'incorrect',
        'derived_from_run_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'derived_from_message_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
      )
    )
  $$),
  '28000',
  '51 company2 member cannot draft into company1'
);

-- a2 was suspended for 32-33 and reactivated above for 50; still holds eval_reviewer from 31.
select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a2');
select lives_ok(
  format(
    $$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111', %L::uuid, 'approve', '{}'::jsonb) $$,
    (select case_id from t_fb)
  ),
  '52 feedback pilot draft can be approved by a non-author reviewer'
);

select pg_temp.set_jwt('00000000-0000-4000-8000-0000000000a1');
select ok(
  not exists (
    select 1 from public.export_approved_eval_cases_v1('11111111-1111-4111-8111-111111111111')
     where id = (select case_id from t_fb)
  ),
  '53 export still omits approved origin=pilot feedback drafts (#102)'
);

select * from finish();
rollback;
