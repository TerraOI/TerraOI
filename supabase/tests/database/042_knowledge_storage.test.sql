-- T-112d / U-1: find_upload_session_v1 privileges + private Storage bucket (#38).
-- Tests 1-10 pin the objects and the predicate as the owner. Tests 11-21 run the real path: an
-- `insert into storage.objects` / `select` **as `authenticated`**, so the policies, the EXECUTE
-- grant they depend on and the predicate are exercised together (supervisor review of #223, B2).
begin;
create extension if not exists pgtap with schema extensions;

select plan(21);

select has_function(
  'public', 'find_upload_session_v1', array['uuid', 'uuid'],
  '1 find_upload_session_v1(uuid, uuid) exists'
);

select ok(
  has_function_privilege('authenticated', 'public.find_upload_session_v1(uuid, uuid)', 'EXECUTE'),
  '2 authenticated may execute find_upload_session_v1'
);

select ok(
  not has_function_privilege('anon', 'public.find_upload_session_v1(uuid, uuid)', 'EXECUTE'),
  '3 anon cannot execute find_upload_session_v1'
);

select ok(
  has_function_privilege('authenticated', 'public.user_may_access_knowledge_object(text)', 'EXECUTE'),
  '4 authenticated holds EXECUTE on the Storage predicate, because RLS runs it as the querying role'
);

select ok(
  exists (select 1 from storage.buckets where id = 'knowledge' and coalesce(public, true) = false),
  '5 private knowledge bucket exists'
);

select ok(
  exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'knowledge_objects_insert'
  ),
  '6 storage insert policy is present'
);

select ok(
  exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'knowledge_objects_select'
  ),
  '7 storage select policy is present'
);

-- Predicate negatives without depending on a seeded publisher role: a path that matches no session
-- is always false, and a closed/expired session row for the jwt subject is false.
select is(
  public.user_may_access_knowledge_object('knowledge/11111111-1111-4111-8111-111111111111/uploads/00000000-0000-4000-8000-000000000099/object'),
  false,
  '8 unknown object path is refused'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

insert into public.knowledge_upload_sessions (
  id, organisation_id, collection_id, created_by, idempotency_key, filename, object_ref,
  max_size_bytes, state, expires_at
)
select
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  '11111111-1111-4111-8111-111111111111',
  c.id,
  '00000000-0000-4000-8000-0000000000a1',
  'idem-stor-01',
  'synth.pdf',
  'knowledge/11111111-1111-4111-8111-111111111111/uploads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/object',
  20971520,
  'expired',
  now() - interval '1 minute'
from public.knowledge_collections c
where c.organisation_id = '11111111-1111-4111-8111-111111111111'
order by c.created_at
limit 1;

select is(
  public.user_may_access_knowledge_object(
    'knowledge/11111111-1111-4111-8111-111111111111/uploads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/object'
  ),
  false,
  '9 expired session path is refused'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a2', true);

select is(
  public.user_may_access_knowledge_object(
    'knowledge/11111111-1111-4111-8111-111111111111/uploads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/object'
  ),
  false,
  '10 other user cannot use the owner''s object path'
);

-- ---------------------------------------------------------------- 11-21 the policies as authenticated
reset role;
select set_config('request.jwt.claim.sub', '', true);

-- A transaction-local `publisher` (knowledge.write) for …a2, so a non-admin writer exists without
-- touching seed.sql; rolled back with the file.
insert into public.organisation_roles (id, organisation_id, key, name)
  values ('31000000-0000-4000-8000-0000000000f2', '11111111-1111-4111-8111-111111111111',
          'publisher_042', 'Publisher (synthetic, 042)');
insert into public.role_permissions (organisation_id, role_id, area, level)
  values ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-0000000000f2',
          'knowledge.write', 'write');
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, '31000000-0000-4000-8000-0000000000f2'
  from public.organisation_memberships m
 where m.organisation_id = '11111111-1111-4111-8111-111111111111'
   and m.user_id = '00000000-0000-4000-8000-0000000000a2';

-- Open sessions, one per case. Paths are object_refs exactly as begin_upload_session_v1 issues them.
insert into public.knowledge_upload_sessions (
  organisation_id, collection_id, created_by, idempotency_key, filename, object_ref,
  max_size_bytes, state, expires_at
) values
  ('11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000a1', 'stor-a1-pub-01', 'a1.pdf',
   'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000001/object',
   1024, 'awaiting_upload', now() + interval '1 hour'),
  ('11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000a1', 'stor-a1-pub-02', 'a1b.pdf',
   'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000007/object',
   1024, 'awaiting_upload', now() + interval '1 hour'),
  ('11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000a2', 'stor-a2-pub-01', 'a2.pdf',
   'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000002/object',
   1024, 'awaiting_upload', now() + interval '1 hour'),
  ('11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-0000000000a2', 'stor-a2-site-01', 'a2site.pdf',
   'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000003/object',
   1024, 'awaiting_upload', now() + interval '1 hour'),
  ('11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000a3', 'stor-a3-pub-01', 'a3.pdf',
   'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000004/object',
   1024, 'awaiting_upload', now() + interval '1 hour'),
  ('11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000a4', 'stor-a4-pub-01', 'a4.pdf',
   'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000005/object',
   1024, 'awaiting_upload', now() + interval '1 hour'),
  ('22222222-2222-4222-8222-222222222222', '52000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000b1', 'stor-b1-c2-01', 'b1.pdf',
   'knowledge/22222222-2222-4222-8222-222222222222/uploads/c0000000-0000-4000-8000-000000000006/object',
   1024, 'awaiting_upload', now() + interval '1 hour');

create function pg_temp.try_store(p_name text) returns text
language plpgsql security invoker as $fn$
begin
  insert into storage.objects (bucket_id, name) values ('knowledge', p_name);
  return 'ok';
exception when others then
  return sqlstate::text;
end;
$fn$;

set local role authenticated;
create temp table t_store (case_name text, result text);
create temp table t_seen (case_name text, n int);

set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_store values
  ('a1_own', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000001/object')),
  ('a1_foreign_tenant', pg_temp.try_store('knowledge/22222222-2222-4222-8222-222222222222/uploads/c0000000-0000-4000-8000-000000000006/object')),
  ('a1_no_session', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-0000000000ff/object')),
  ('a1_expired', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/object'));
insert into t_seen select 'a1_reads_own', count(*)::int from storage.objects
 where bucket_id = 'knowledge'
   and name = 'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000001/object';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_store values
  ('a2_writer', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000002/object')),
  ('a2_not_site_a', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000003/object')),
  ('a2_others_session', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000007/object'));
insert into t_seen select 'a2_reads_a1', count(*)::int from storage.objects
 where bucket_id = 'knowledge'
   and name = 'knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000001/object';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_store values
  ('a3_suspended', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000004/object'));

set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
insert into t_store values
  ('a4_read_only', pg_temp.try_store('knowledge/11111111-1111-4111-8111-111111111111/uploads/c0000000-0000-4000-8000-000000000005/object'));
reset role;

select is((select result from t_store where case_name = 'a1_own'), 'ok',
  '11 an admin with an open session for exactly this path may upload the object');
select is((select result from t_store where case_name = 'a2_writer'), 'ok',
  '12 a knowledge.write holder with an open session for exactly this path may upload the object');
select is((select result from t_store where case_name = 'a2_not_site_a'), '42501',
  '13 a writer outside the collection''s project is refused even with a session row (§6.2)');
select is((select result from t_store where case_name = 'a3_suspended'), '42501',
  '14 a suspended member is refused (§4.2)');
select is((select result from t_store where case_name = 'a4_read_only'), '42501',
  '15 a member with only knowledge.read is refused: capture needs the publish predicate (#39)');
select is((select result from t_store where case_name = 'a1_foreign_tenant'), '42501',
  '16 another tenant''s object path is refused');
select is((select result from t_store where case_name = 'a2_others_session'), '42501',
  '17 another user''s open session does not admit this caller');
select is((select result from t_store where case_name = 'a1_no_session'), '42501',
  '18 a path no session issued is refused');
select is((select result from t_store where case_name = 'a1_expired'), '42501',
  '19 an expired session admits nothing');
select is((select n from t_seen where case_name = 'a1_reads_own'), 1,
  '20 the uploader can read back the object of their open session');
select is((select n from t_seen where case_name = 'a2_reads_a1'), 0,
  '21 another member cannot read it');

select * from finish();
rollback;
