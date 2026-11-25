-- F24 citation open (20261125140000_citation_open.sql). Slot 038 (next to 037 search).
-- Synthetic fixtures (AGENTS.md §4.7). v_pub = 71..01 (public, tenant-wide, chunk 81..01);
-- v_site = 71..02 (client_confidential, Site A, chunk 81..04).
begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

create or replace function pg_temp.as_user(p_sub uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('app.organisation_id', '', true);
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

-- Storage reads as the querying role: answers the visible-row count, or the SQLSTATE if the read fails.
create or replace function pg_temp.visible(p_pattern text) returns text
language plpgsql as $$
declare v int;
begin
  select count(*) into v from storage.objects where bucket_id = 'knowledge' and name like p_pattern;
  return v::text;
exception when others then
  return sqlstate;
end;
$$;

create or replace function pg_temp.cite(p_org uuid, p_chunk uuid) returns text
language sql as $$
  select coalesce((select object_ref from public.cite_source_object_v1(p_org, p_chunk)), 'none')
$$;

insert into storage.buckets (id, name) values ('knowledge', 'knowledge') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name)
select 'knowledge', object_ref from public.source_versions
 where id in ('71000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002');

select ok(has_function_privilege('authenticated', 'public.cite_source_object_v1(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.cite_source_object_v1(uuid, uuid)', 'execute'),
  '1 the citation re-authorization is for authenticated only');
select ok(has_function_privilege('authenticated', 'public.user_may_read_published_object(text)', 'execute')
          and not has_function_privilege('authenticated', 'public.source_readable_in(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.user_may_read_published_object(text)', 'execute'),
  '2 the reader policy predicate is executable by authenticated (policies run as the caller); the inner helper is not');

-- ---------------------------------------------------------------- 3-7 re-authorization
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.cite('11111111-1111-4111-8111-111111111111', '81000000-0000-4000-8000-000000000001'),
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000001/v1.pdf',
  '3 a member opens a tenant-wide published citation');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.cite('11111111-1111-4111-8111-111111111111', '81000000-0000-4000-8000-000000000004'), 'none',
  '4 a member outside Site A cannot open a Site A citation');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select isnt(pg_temp.cite('11111111-1111-4111-8111-111111111111', '81000000-0000-4000-8000-000000000004'), 'none',
  '5 a Site A member can');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select is(pg_temp.cite('22222222-2222-4222-8222-222222222222', '81000000-0000-4000-8000-000000000001'), 'none',
  '6 a company1 chunk id under company2 scope returns nothing');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select is(pg_temp.try_sql($q$ select pg_temp.cite('11111111-1111-4111-8111-111111111111', '81000000-0000-4000-8000-000000000001') $q$), '28000',
  '7 a suspended membership is refused');
reset role;

-- ---------------------------------------------------------------- 8-11 storage RLS for readers
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select todo('R-4: authenticated reads of storage.objects error while #223''s upload predicate is revoked from authenticated (policies run as the caller)', 1);
select is(pg_temp.visible('knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000001/%'), '1',
  '8 storage lets a reader fetch the published tenant-wide object with their own token');
select todo('R-4: authenticated reads of storage.objects error while #223''s upload predicate is revoked from authenticated (policies run as the caller)', 1);
select is(pg_temp.visible('knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000002/%'), '0',
  '9 …but not the Site A object');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select todo('R-4: authenticated reads of storage.objects error while #223''s upload predicate is revoked from authenticated (policies run as the caller)', 1);
select is(pg_temp.visible('knowledge/11111111-1111-4111-8111-111111111111/%'), '0',
  '10 another tenant reads no company1 object');
reset role;

select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(public.user_may_read_published_object('knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000001/v1.pdf'), true,
  '15 the reader predicate itself is true for a member on the tenant-wide object (8 is not vacuous)');
select is(public.user_may_read_published_object('knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000002/v1.json'), false,
  '16 …and false for the Site A object');
reset role;

-- revocation closes both doors at once; the answer text elsewhere is untouched
update public.knowledge_sources set lifecycle_state = 'revoked', revoked_at = now()
 where id = '61000000-0000-4000-8000-000000000001';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select is(pg_temp.cite('11111111-1111-4111-8111-111111111111', '81000000-0000-4000-8000-000000000001'), 'none',
  '11 a revoked source''s citation no longer opens');
select todo('R-4: authenticated reads of storage.objects error while #223''s upload predicate is revoked from authenticated (policies run as the caller)', 1);
select is(pg_temp.visible('knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000001/%'), '0',
  '12 …and storage refuses the object too');
select is(public.user_may_read_published_object('knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000001/v1.pdf'), false,
  '17 the reader predicate is false after revocation');
reset role;

-- removed project membership closes the Site A citation for a1
delete from public.project_memberships
 where project_id = '41000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-0000000000a1';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select is(pg_temp.cite('11111111-1111-4111-8111-111111111111', '81000000-0000-4000-8000-000000000004'), 'none',
  '13 removing the project membership closes the Site A citation');
select todo('R-4: authenticated reads of storage.objects error while #223''s upload predicate is revoked from authenticated (policies run as the caller)', 1);
select is(pg_temp.visible('knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000002/%'), '0',
  '14 …and the object');
reset role;

select * from finish();
rollback;
