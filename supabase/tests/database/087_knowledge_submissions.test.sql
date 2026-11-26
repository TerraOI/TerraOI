-- T-302b PR-1: knowledge_submissions + F15 RPCs. Slot 087 (COORDINATION.md §6b).
-- Consumes T-213 (#267). Does not consume T-104 agent_runs FK.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

-- ---------------------------------------------------------------- helpers
create function pg_temp.try_submit(
  p_organisation_id uuid,
  p_collection_id uuid,
  p_kind text,
  p_text text,
  p_context_class text,
  p_cited uuid[] default '{}'::uuid[],
  p_run uuid default null
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    return public.submit_employee_knowledge_v1(
      p_organisation_id, p_collection_id, p_kind, p_text, p_context_class, p_cited, p_run, null
    )::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_review(
  p_organisation_id uuid, p_submission_id uuid, p_decision text, p_reason text default null
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    return public.review_knowledge_submission_v1(
      p_organisation_id, p_submission_id, p_decision, p_reason
    )::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_withdraw(p_organisation_id uuid, p_submission_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    return public.withdraw_knowledge_submission_v1(p_organisation_id, p_submission_id)::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- ---------------------------------------------------------------- 1-6 shape and grants
select has_table('public', 'knowledge_submissions',
  '1 knowledge_submissions exists (F15 / #73)');
select has_function('public', 'submit_employee_knowledge_v1',
  array['uuid', 'uuid', 'text', 'text', 'text', 'uuid[]', 'uuid', 'timestamptz'],
  '2 submit_employee_knowledge_v1 takes p_organisation_id first (FAQ-0011)');
select has_function('public', 'review_knowledge_submission_v1',
  array['uuid', 'uuid', 'text', 'text'],
  '3 review_knowledge_submission_v1 is scoped');
select is((select provolatile from pg_proc
            where oid = 'public.submit_employee_knowledge_v1(uuid,uuid,text,text,text,uuid[],uuid,timestamptz)'::regprocedure),
  'v', '4 submit is volatile (sets tenant scope)');
select is(has_function_privilege('authenticated',
  'public.submit_employee_knowledge_v1(uuid,uuid,text,text,text,uuid[],uuid,timestamptz)', 'execute'), true,
  '5 authenticated may submit');
select is(has_function_privilege('anon',
  'public.review_knowledge_submission_v1(uuid,uuid,text,text)', 'execute'), false,
  '6 anon cannot review');

-- ---------------------------------------------------------------- 7-10 submit + approve happy path
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create temporary table sub_ids (id uuid);
insert into sub_ids (id)
select public.submit_employee_knowledge_v1(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'note',
  'Synthetic F15 note for approval path.',
  'public',
  array['71000000-0000-4000-8000-000000000001'::uuid],
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', null
);
select ok((select id is not null from sub_ids limit 1),
  '7 owner can submit into a readable public collection');
reset role;

-- ---------------------------------------------------------------- 8-10 FAQ-0015: knowledge.write is not review
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is((select count(*)::int from public.knowledge_submissions where id = (select id from sub_ids limit 1)),
  0, '8 a contributor (knowledge.write only) does not see another member''s open proposal');
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  (select id from sub_ids limit 1),
  'approve', null), '42501',
  '9 a contributor (knowledge.write only) cannot review a submission');
reset role;

-- Reviewer role for field member a2 (knowledge.review write, FAQ-0015) — same pattern as 050.
-- Granted only after 8-9 show that a2's seeded contributor role (knowledge.write) is not enough.
insert into public.organisation_roles (id, organisation_id, key, name) values
  ('31000000-0000-4000-8000-0000000000e1', '11111111-1111-4111-8111-111111111111', 'reviewer-302b', 'Knowledge reviewer 302b')
on conflict (organisation_id, key) do nothing;
insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-0000000000e1', 'knowledge.review', 'write')
on conflict (role_id, area) do nothing;
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, '31000000-0000-4000-8000-0000000000e1'::uuid
  from public.organisation_memberships m
 where m.user_id = '00000000-0000-4000-8000-0000000000a2'
   and m.organisation_id = '11111111-1111-4111-8111-111111111111'
  and not exists (
    select 1 from public.membership_roles mr
     where mr.membership_id = m.id
       and mr.role_id = '31000000-0000-4000-8000-0000000000e1'
  );

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is((select count(*)::int from public.knowledge_submissions where id = (select id from sub_ids limit 1)),
  1, '10 with knowledge.review the reviewer sees the open proposal');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  (select id from sub_ids limit 1),
  'approve', 'looks sound'),
  (select id::text from sub_ids limit 1),
  '11 non-author reviewer with knowledge.review can approve');
reset role;

select is((select state from public.knowledge_submissions where id = (select id from sub_ids limit 1)),
  'approved', '12 approved submission is marked approved');
select ok((select source_version_id is not null from public.knowledge_submissions
            where id = (select id from sub_ids limit 1)),
  '13 approval created a source version in the pipeline');
select is((select kind from public.knowledge_sources
            where id = (select source_id from public.knowledge_submissions
                         where id = (select id from sub_ids limit 1))),
  'note', '14 promoted source kind is note');

-- ---------------------------------------------------------------- 12 author cannot approve self
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create temporary table self_ids (id uuid);
insert into self_ids (id)
select public.submit_employee_knowledge_v1(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'correction',
  'Synthetic self-review refusal body.',
  'public', '{}'::uuid[], null, null
);
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  (select id from self_ids limit 1),
  'approve', null), '42501',
  '15 author cannot approve their own submission (#8)');
reset role;

-- ---------------------------------------------------------------- 13-15 RLS negatives
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
select is((select count(*)::int from public.knowledge_submissions
            where organisation_id = '11111111-1111-4111-8111-111111111111'),
  0, '16 company2 member sees zero company1 submissions (RLS)');
select is(pg_temp.try_submit(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'note', 'cross-tenant attempt', 'public'), '28000',
  '17 company2 cannot establish company1 scope to submit');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
select is(pg_temp.try_submit(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'note', 'deactivated attempt', 'public'), '28000',
  '18 deactivated member cannot submit');
reset role;

-- ---------------------------------------------------------------- 16 project audience
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
-- a2 is not a site-a project member in seed; confidential collection is project-scoped.
select is(pg_temp.try_submit(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000002',
  'note', 'project attempt', 'internal'), '42501',
  '19 member without project audience cannot submit into project collection');
reset role;

-- ---------------------------------------------------------------- 17-18 class rules
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_submit(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'note', 'too confidential for public collection', 'client_confidential'), '23514',
  '20 public collection refuses a client_confidential context class');
-- Cite the confidential project note version into a public collection — class must rise and refuse.
select is(pg_temp.try_submit(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'answer', 'citing confidential', 'public',
  array['71000000-0000-4000-8000-000000000002'::uuid]), '23514',
  '21 citing a higher-class version raises class and public collection refuses');
reset role;

-- ---------------------------------------------------------------- 19 duplicate review
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  (select id from sub_ids limit 1),
  'approve', null), '22023',
  '22 duplicate approve does not create a second source');
reset role;

-- ---------------------------------------------------------------- 20-21 withdraw
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create temporary table wd_ids (id uuid);
insert into wd_ids (id)
select public.submit_employee_knowledge_v1(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'note', 'withdraw me', 'public', '{}'::uuid[], null, null
);
select is(pg_temp.try_withdraw(
  '11111111-1111-4111-8111-111111111111',
  (select id from wd_ids limit 1)),
  (select id::text from wd_ids limit 1),
  '23 author can withdraw an open submission');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create temporary table wd2_ids (id uuid);
insert into wd2_ids (id)
select public.submit_employee_knowledge_v1(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'note', 'withdraw gate', 'public', '{}'::uuid[], null, null
);
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_withdraw(
  '11111111-1111-4111-8111-111111111111',
  (select id from wd2_ids limit 1)), '42501',
  '24 non-author cannot withdraw an open submission');
reset role;

-- ---------------------------------------------------------------- 22-24 table privileges
select is(has_table_privilege('authenticated', 'public.knowledge_submissions', 'select'), true,
  '25 authenticated may select through RLS');
select is(has_table_privilege('authenticated', 'public.knowledge_submissions', 'insert'), false,
  '26 authenticated has no direct insert — RPCs only');
select is(has_function_privilege('authenticated',
  'public.withdraw_knowledge_submission_v1(uuid,uuid)', 'execute'), true,
  '27 authenticated may withdraw via RPC');

select * from finish();
rollback;
