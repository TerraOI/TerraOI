-- T-303 eval review view: server rules behind the review screens (20261125100000_eval_review_queue.sql).
-- Slot 091 (next to T-312's 090). Fixtures are synthetic (AGENTS.md §4.7) and inserted as the owner.
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

create or replace function pg_temp.as_user(p_sub uuid) returns void
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

-- ids
-- c1 = company1, a1 owner (Site A member, eval_reviewer), a2 field (eval_reviewer, NOT Site A),
-- a3 suspended, a4 multi-tenant (Site A member, no evals.review), b1 company2 owner.
-- v_pub = 71..01 (public, tenant-wide), v_site = 71..02 (client_confidential, Site A only).
insert into public.eval_cases (id, organisation_id, case_key, expert_key, status, origin, case_type, question,
                               data_class, payload, created_by, drafted_by, drafted_on)
values
  ('e3030000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'UAV-R001', 'uav-expert',
   'drafted', 'agent_drafted', 'answerable', 'Synthetic: what battery reserve triggers a second pass?', 'public',
   '{"expectedSource": "SYNTH-UAV-0001 p.3 sourceVersionId:71000000-0000-4000-8000-000000000001",
     "expectedAnswerPoints": ["A second pass is flown below the reserve threshold."]}'::jsonb,
   '00000000-0000-4000-8000-0000000000a1', 'agent (T-312 F34)', '2026-11-25'),
  ('e3030000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'UAV-R002', 'uav-expert',
   'drafted', 'agent_drafted', 'answerable', 'Synthetic: how many passes were flown over grid four?', 'client_confidential',
   '{"expectedSource": "SYNTH-UAV-0002 note sourceVersionId:71000000-0000-4000-8000-000000000002",
     "expectedAnswerPoints": ["Two passes."]}'::jsonb,
   '00000000-0000-4000-8000-0000000000a4', 'agent (T-312 F34)', '2026-11-25'),
  ('e3030000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'UAV-R003', 'uav-expert',
   'drafted', 'agent_drafted', 'answerable', 'Synthetic: which manual covers compass calibration?', 'public',
   '{"expectedSource": "SYNTH-UAV-0001 p.7 sourceVersionId:71000000-0000-4000-8000-000000000001",
     "expectedAnswerPoints": ["The reference manual."]}'::jsonb,
   '00000000-0000-4000-8000-0000000000a4', 'agent (T-312 F34)', '2026-11-25'),
  ('e3030000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'UAV-R004', 'uav-expert',
   'drafted', 'agent_drafted', 'answerable', 'Synthetic: what is the pre-flight tether check?', 'public',
   '{"expectedSource": "SYNTH-UAV-0001 p.9 sourceVersionId:71000000-0000-4000-8000-000000000001",
     "expectedAnswerPoints": ["Check tether, props and latches."]}'::jsonb,
   '00000000-0000-4000-8000-0000000000a4', 'agent (T-312 F34)', '2026-11-25');

create temporary table t_ts (k text primary key, ts timestamptz) on commit drop;
grant all on t_ts to authenticated;

-- ---------------------------------------------------------------- 1-3 privileges
select ok(has_function_privilege('authenticated', 'public.list_eval_review_queue_v1(uuid, text)', 'execute')
          and has_function_privilege('authenticated', 'public.get_eval_review_case_v1(uuid, uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.decide_eval_case_v1(uuid, uuid, text, jsonb, timestamptz)', 'execute'),
  '1 the three T-303 RPCs are granted to authenticated');
select ok(not has_function_privilege('anon', 'public.list_eval_review_queue_v1(uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.decide_eval_case_v1(uuid, uuid, text, jsonb, timestamptz)', 'execute')
          and not has_function_privilege('service_role', 'public.decide_eval_case_v1(uuid, uuid, text, jsonb, timestamptz)', 'execute'),
  '2 anon and service_role cannot execute them');
select ok(not has_function_privilege('authenticated', 'public.eval_case_sources_valid(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.eval_case_max_source_class(jsonb, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.eval_case_source_version_ids(jsonb)', 'execute'),
  '3 internal helpers are not callable by request roles');

-- ---------------------------------------------------------------- 4-9 visibility follows the source audience
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is((select count(*)::int from public.list_eval_review_queue_v1('11111111-1111-4111-8111-111111111111', null)
            where id::text like 'e3030000%'), 3,
  '4 a reviewer outside Site A sees the three tenant-wide cases');
select is((select count(*)::int from public.list_eval_review_queue_v1('11111111-1111-4111-8111-111111111111', null)
            where id = 'e3030000-0000-4000-8000-000000000002'), 0,
  '5 …and not the case citing a Site A client_confidential version');
select is((select count(*)::int from public.get_eval_review_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000002')), 0,
  '6 a guessed id of a hidden case returns no row');
select is((select count(*)::int from public.eval_cases where id = 'e3030000-0000-4000-8000-000000000002'), 0,
  '7 direct SELECT under RLS hides it too');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000002', 'approve', '{}'::jsonb, null) $q$), '42501',
  '8 deciding a hidden case is refused like an absent one');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select is((select count(*)::int from public.list_eval_review_queue_v1('11111111-1111-4111-8111-111111111111', null)
            where id = 'e3030000-0000-4000-8000-000000000002'), 1,
  '9 a Site A member with evals.review sees the Site A case');
reset role;

-- ---------------------------------------------------------------- 10-14 approve: concurrency, author, recorded identity
insert into t_ts select 'r001', updated_at from public.eval_cases where id = 'e3030000-0000-4000-8000-000000000001';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000001', 'approve', '{}'::jsonb, null) $q$), '42501',
  '10 the author cannot approve their own draft');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000001', 'approve', '{}'::jsonb, '2000-01-01T00:00:00Z') $q$), '40001',
  '11 a decision on a stale read is a conflict, not an overwrite');
select is(pg_temp.try_sql(format($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000001', 'approve', '{}'::jsonb, %L) $q$,
            (select ts from t_ts where k = 'r001'))), 'ok',
  '12 a non-author reviewer approves with the current version token');
reset role;
select is((select status || ':' || (approved_by = '00000000-0000-4000-8000-0000000000a2')::text || ':' || (approved_at is not null)::text
             from public.eval_cases where id = 'e3030000-0000-4000-8000-000000000001'),
  'approved:true:true',
  '13 approval records the reviewer from auth.uid() and the time server-side');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000001', 'approve', '{}'::jsonb, null) $q$), '40001',
  '14 a second approval is a conflict');
reset role;

-- ---------------------------------------------------------------- 15-21 edit
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000001', 'edit',
            '{"question": "Synthetic: below what battery reserve is a second pass flown?"}'::jsonb, null) $q$), 'ok',
  '15 an edit is accepted');
reset role;
select is((select status || ':' || coalesce(approved_by::text, 'null') || ':' || question
             from public.eval_cases where id = 'e3030000-0000-4000-8000-000000000001'),
  'drafted:null:Synthetic: below what battery reserve is a second pass flown?',
  '16 the edit returns the approved case to pending with the new text, never approving it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000003', 'edit', '{"approvedBy": "x"}'::jsonb, null) $q$), '22023',
  '17 a field outside the whitelist (a forged reviewer) is a validation error');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000003', 'edit', '{"caseType": "trivia"}'::jsonb, null) $q$), '22023',
  '18 an unknown case type is a validation error');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000003', 'edit',
            '{"expectedSource": "SYNTH-UAV-0001 somewhere", "expectedAnswerPoints": ["x"]}'::jsonb, null) $q$), '22023',
  '19 an answerable case whose edit names no source version is a validation error');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000003', 'edit',
            '{"expectedSource": "SYNTH-UAV-0002 sourceVersionId:71000000-0000-4000-8000-000000000002"}'::jsonb, null) $q$), '42501',
  '20 a reviewer cannot attach a source version they may not read');
reset role;
select is((select question || '|' || status from public.eval_cases where id = 'e3030000-0000-4000-8000-000000000003'),
  'Synthetic: which manual covers compass calibration?|drafted',
  '21 refused edits leave the case exactly as it was');

-- ---------------------------------------------------------------- 22-23 data class propagation on edit
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000003', 'edit',
            '{"expectedEvidence": [{"kind": "chunk", "sourceVersionId": "71000000-0000-4000-8000-000000000002", "chunkId": "c-1", "span": {"startChar": 0, "endChar": 10}}]}'::jsonb, null) $q$), 'ok',
  '22 a Site A member may attach a Site A version');
reset role;
select is((select data_class from public.eval_cases where id = 'e3030000-0000-4000-8000-000000000003'),
  'client_confidential',
  '23 the case data class rises to the highest class it cites (§6.2)');

-- ---------------------------------------------------------------- 24-25 revoked source blocks approval (both paths)
update public.knowledge_sources set lifecycle_state = 'revoked', revoked_at = now()
 where id = '61000000-0000-4000-8000-000000000001';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000004', 'approve', '{}'::jsonb, null) $q$), '55000',
  '24 approving a case whose expected source was revoked is refused');
select is(pg_temp.try_sql($q$ select public.review_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000004', 'approve', '{}'::jsonb) $q$), '55000',
  '25 review_eval_case_v1 goes through the same rule');
select is((select sources_valid::text from public.get_eval_review_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000004')), 'false',
  '26 the queue marks the case invalid rather than hiding the reviewer''s work');
reset role;

-- ---------------------------------------------------------------- 27-30 other tenant, suspended, unentitled
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select is((select count(*)::int from public.list_eval_review_queue_v1('22222222-2222-4222-8222-222222222222', null)
            where id::text like 'e3030000%'), 0,
  '27 a company2 reviewer sees no company1 case');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('22222222-2222-4222-8222-222222222222',
            'e3030000-0000-4000-8000-000000000003', 'reject', '{}'::jsonb, null) $q$), '42501',
  '28 a company1 case id decided under company2 scope returns the same refusal as an absent one');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select is(pg_temp.try_sql($q$ select count(*) from public.list_eval_review_queue_v1('11111111-1111-4111-8111-111111111111', null) $q$), '28000',
  '29 a suspended membership sees nothing');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select is(pg_temp.try_sql($q$ select public.decide_eval_case_v1('11111111-1111-4111-8111-111111111111',
            'e3030000-0000-4000-8000-000000000001', 'reject', '{}'::jsonb, null) $q$)
          || ':' || (select count(*)::text from public.list_eval_review_queue_v1('11111111-1111-4111-8111-111111111111', null)),
  '42501:0',
  '30 a member without evals.review lists nothing and cannot decide');
reset role;

select * from finish();
rollback;
