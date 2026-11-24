-- T-213 PR-3: review_reclass_v1 cascade (#21). Slot 051 (COORDINATION.md §6b).
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

create function pg_temp.try_reclass(
  p_organisation_id uuid, p_collection_id uuid, p_new_class text
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    return public.review_reclass_v1(p_organisation_id, p_collection_id, p_new_class)::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Publisher role for a2 (write) — same pattern as 050.
insert into public.organisation_roles (id, organisation_id, key, name) values
  ('31000000-0000-4000-8000-0000000000f1', '11111111-1111-4111-8111-111111111111', 'publisher-reclass', 'Knowledge publisher reclass')
on conflict (organisation_id, key) do nothing;
insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-0000000000f1', 'knowledge.write', 'write')
on conflict (role_id, area) do nothing;
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, '31000000-0000-4000-8000-0000000000f1'::uuid
  from public.organisation_memberships m
 where m.user_id = '00000000-0000-4000-8000-0000000000a2'
   and m.organisation_id = '11111111-1111-4111-8111-111111111111'
  and not exists (
    select 1 from public.membership_roles mr
     where mr.membership_id = m.id
       and mr.role_id = '31000000-0000-4000-8000-0000000000f1'
  );

-- Public collection dedicated to reclass cascade (tenant-wide).
insert into public.knowledge_collections (
  id, organisation_id, key, service_key, project_id, name, data_class
) values (
  '51000000-0000-4000-8000-0000000000b1',
  '11111111-1111-4111-8111-111111111111',
  'reclass-public', 'uav', null, 'Reclass public', 'public'
);

insert into public.knowledge_sources (
  id, organisation_id, collection_id, kind, external_id, owner_user_id
) values (
  '61000000-0000-4000-8000-0000000000b1',
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000b1',
  'upload', 'synthetic-reclass-0001', '00000000-0000-4000-8000-0000000000a1'
);

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text
) values (
  '71000000-0000-4000-8000-0000000000b1',
  '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-0000000000b1',
  '51000000-0000-4000-8000-0000000000b1',
  1,
  '00000000-0000-4000-8000-0000000000a1',
  'public',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-0000000000b1/v1.pdf',
  'published', 'v1', null
);

insert into public.knowledge_chunks (
  id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
) values (
  '81000000-0000-4000-8000-0000000000b1',
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000b1',
  0,
  '{"page": 1}',
  'Synthetic reclass fixture chunk.',
  'public', 8
);

-- E2-style index: cleared for public only. A raise to internal must drop its vectors (#21).
insert into public.embedding_indexes (
  id, organisation_id, index_key, provider_key, model, dimensions, metric, generation, status, cleared_for
) values (
  '91000000-0000-4000-8000-0000000000e2',
  '11111111-1111-4111-8111-111111111111',
  'corpus-e2', 'workers_ai', 'synthetic-e2', 1024, 'cosine', 1, 'active',
  array['public']::text[]
);

-- Zero vector of the index's dimensions (same shape helper as 037).
create function pg_temp.zero_vector(p_dims integer) returns text
language sql immutable as $fn$
  select '[' || string_agg('0', ',' order by g) || ']'
    from generate_series(1, p_dims) as g;
$fn$;

insert into public.chunk_embeddings (
  id, organisation_id, chunk_id, index_id, index_generation, embedding
) values (
  'a1000000-0000-4000-8000-0000000000b1',
  '11111111-1111-4111-8111-111111111111',
  '81000000-0000-4000-8000-0000000000b1',
  '91000000-0000-4000-8000-0000000000e2',
  1,
  pg_temp.zero_vector(1024)::extensions.vector
);

-- ---------------------------------------------------------------- 1-3 shape / grants
select has_function('public', 'review_reclass_v1', array['uuid', 'uuid', 'text'],
  '1 review_reclass_v1(uuid,uuid,text) exists');
select is((select provolatile from pg_proc
            where oid = 'public.review_reclass_v1(uuid,uuid,text)'::regprocedure),
  'v', '2 review_reclass_v1 is volatile (sets tenant scope)');
select is(has_function_privilege('authenticated',
  'public.review_reclass_v1(uuid,uuid,text)', 'execute'), true,
  '3 authenticated may execute review_reclass_v1');

-- ---------------------------------------------------------------- 4-6 refusals
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_reclass(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000b1',
  'restricted'), '23514',
  '4 raising to restricted is refused (#21)');
select is(pg_temp.try_reclass(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000b1',
  'client_confidential'), '23514',
  '5 tenant-wide raise to client_confidential is refused (#21)');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
select is(pg_temp.try_reclass(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000b1',
  'internal'), '28000',
  '6 company2 cannot establish company1 scope to reclass');
reset role;

-- ---------------------------------------------------------------- 7-12 cascade + E2 vector removal
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
create temporary table reclass_ids (id uuid);
insert into reclass_ids (id)
select public.review_reclass_v1(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000b1',
  'internal'
);
select ok((select id is not null from reclass_ids limit 1),
  '7 reviewer with knowledge.write can raise public → internal');
reset role;

select is((select data_class from public.knowledge_collections
            where id = '51000000-0000-4000-8000-0000000000b1'), 'internal',
  '8 collection class is raised');
select is((select data_class from public.source_versions
            where id = '71000000-0000-4000-8000-0000000000b1'), 'internal',
  '9 source version class is raised with the collection');
select is((select data_class from public.knowledge_chunks
            where id = '81000000-0000-4000-8000-0000000000b1'), 'internal',
  '10 chunk class is raised and never left below the collection');
select is((select count(*)::int from public.chunk_embeddings
            where chunk_id = '81000000-0000-4000-8000-0000000000b1'), 0,
  '11 E2 index without internal clearance loses the vector (#21)');
select is((select embeddings_removed from public.knowledge_reclass_audits
            where id = (select id from reclass_ids limit 1)), 1,
  '12 audit row records embeddings_removed = 1');

-- ---------------------------------------------------------------- 13-16 more refusals + privileges
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_reclass(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000b1',
  'public'), '23514',
  '13 lowering the class is refused');
select is(pg_temp.try_reclass(
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000b1',
  'internal'), '22023',
  '14 same-class reclass is a no-op refusal');
reset role;

select is(has_function_privilege('anon',
  'public.review_reclass_v1(uuid,uuid,text)', 'execute'), false,
  '15 anon cannot execute review_reclass_v1');
select is(has_table_privilege('authenticated', 'public.knowledge_reclass_audits', 'insert'), false,
  '16 authenticated has no direct insert on reclass audits');

select * from finish();
rollback;
