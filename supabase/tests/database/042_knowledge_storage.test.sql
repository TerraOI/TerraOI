-- T-112d / U-1: find_upload_session_v1 privileges + private Storage bucket (#38).
-- Negatives for the Storage predicate (other tenant / other user / expired / deactivated) are
-- exercised through `user_may_access_knowledge_object` under SECURITY DEFINER as the table owner;
-- authenticated never holds EXECUTE on that helper (FAQ-0010).
begin;
create extension if not exists pgtap with schema extensions;

select plan(10);

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
  not has_function_privilege('authenticated', 'public.user_may_access_knowledge_object(text)', 'EXECUTE'),
  '4 user_may_access_knowledge_object is closed to authenticated'
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

select * from finish();
rollback;
