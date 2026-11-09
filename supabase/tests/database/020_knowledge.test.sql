-- T-111 knowledge core: tenant isolation of collections, sources, chunks and vectors; the
-- data-class rules of plan §6.2/§12.4; source-version immutability (§7.2); the visible state
-- set; the transactional outbox (§7.2 step 1); pinned index generations (§8.3, TOI-ADR-13);
-- and the job idempotency key (§7.5).
--
-- Structure follows the supervisor's review of PR #12 (B5): every mutation a *member* must not
-- be able to make is asserted as `authenticated` inside a tenant scope, so removing the
-- select-only grants (B1) or the audience guard (B2) fails a test rather than quietly passing.
-- The same mutations on the privileged path are asserted separately, so the guard triggers are
-- pinned too: a reviewer RPC that writes with owner privileges still cannot clear a project,
-- lower a class, rewrite a captured version or resurrect a revoked one (§20.4 item 2).
-- Fixtures are the synthetic ones in supabase/seed.sql, applied by `supabase db reset`.
-- pg_temp.try_* helpers are SECURITY INVOKER and return the SQLSTATE instead of aborting the
-- test transaction. Probe chunks use chunk_index >= 900 so the visibility counts, which filter
-- on chunk_index < 900, always measure the fixture corpus.
begin;
create extension if not exists pgtap with schema extensions;

select plan(79);

-- ---------------------------------------------------------------- helpers
create function pg_temp.try_scope(p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.set_tenant_scope(p_organisation_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_collection(p_organisation_id uuid, p_key text, p_service_key text,
                                       p_project_id uuid, p_data_class text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.knowledge_collections (organisation_id, key, service_key, project_id, name, data_class)
      values (p_organisation_id, p_key, p_service_key, p_project_id, 'Probe ' || p_key, p_data_class);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_collection_project_null(p_collection_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.knowledge_collections set project_id = null where id = p_collection_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_collection_org(p_collection_id uuid, p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.knowledge_collections set organisation_id = p_organisation_id where id = p_collection_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_collection_class(p_collection_id uuid, p_data_class text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.knowledge_collections set data_class = p_data_class where id = p_collection_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_source_owner(p_source_id uuid, p_user_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.knowledge_sources set owner_user_id = p_user_id where id = p_source_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_version_uploader(p_source_version_id uuid, p_user_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.source_versions set uploaded_by = p_user_id where id = p_source_version_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_chunk(p_organisation_id uuid, p_source_version_id uuid,
                                  p_data_class text, p_chunk_index int, p_locator jsonb) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.knowledge_chunks (organisation_id, source_version_id, chunk_index, locator, body_text, data_class)
      values (p_organisation_id, p_source_version_id, p_chunk_index, p_locator,
              'Probe chunk text written only by the knowledge guardrail tests.', p_data_class);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_chunk_text(p_chunk_id uuid, p_body_text text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.knowledge_chunks set body_text = p_body_text where id = p_chunk_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_version_text(p_source_version_id uuid, p_body_text text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.source_versions set body_text = p_body_text where id = p_source_version_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_version_hash(p_source_version_id uuid, p_content_hash text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.source_versions set content_hash = p_content_hash where id = p_source_version_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_version_class(p_source_version_id uuid, p_data_class text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.source_versions set data_class = p_data_class where id = p_source_version_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_version_state(p_source_version_id uuid, p_state text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.source_versions set state = p_state where id = p_source_version_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_version_insert(p_organisation_id uuid, p_source_id uuid,
                                           p_collection_id uuid, p_version_number int,
                                           p_uploaded_by uuid, p_content_hash text,
                                           p_data_class text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.source_versions (organisation_id, source_id, collection_id, version_number,
                                        uploaded_by, data_class, content_hash, object_ref)
      values (p_organisation_id, p_source_id, p_collection_id, p_version_number,
              p_uploaded_by, p_data_class, p_content_hash,
              'knowledge/fixture/probe-source/v1.bin');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Same insert, but the capture identity is left out: provenance cannot be defaulted.
create function pg_temp.try_version_insert_no_uploader(p_organisation_id uuid, p_source_id uuid,
                                                       p_collection_id uuid, p_version_number int,
                                                       p_content_hash text, p_data_class text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.source_versions (organisation_id, source_id, collection_id, version_number,
                                        data_class, content_hash, object_ref)
      values (p_organisation_id, p_source_id, p_collection_id, p_version_number,
              p_data_class, p_content_hash, 'knowledge/fixture/probe-source/v2.bin');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_current_version(p_source_id uuid, p_version_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.knowledge_sources set current_version_id = p_version_id where id = p_source_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_index(p_organisation_id uuid, p_index_key text, p_generation int,
                                  p_status text, p_dimensions int) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.embedding_indexes (organisation_id, index_key, provider_key, model,
                                          dimensions, metric, generation, status, cleared_for)
      values (p_organisation_id, p_index_key, 'workers_ai', 'synthetic-probe-model',
              p_dimensions, 'cosine', p_generation, p_status, array['public']::text[]);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_embedding(p_organisation_id uuid, p_index_id uuid, p_chunk_id uuid,
                                      p_index_generation int, p_vector text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.chunk_embeddings (organisation_id, index_id, chunk_id, index_generation, embedding)
      values (p_organisation_id, p_index_id, p_chunk_id, p_index_generation, p_vector::extensions.vector);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_embedding_rewrite(p_organisation_id uuid, p_index_id uuid,
                                              p_chunk_id uuid, p_vector text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.chunk_embeddings
       set embedding = p_vector::extensions.vector
     where organisation_id = p_organisation_id and index_id = p_index_id and chunk_id = p_chunk_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_job(p_organisation_id uuid, p_source_version_id uuid, p_stage text,
                                p_executor text, p_data_class text, p_index_generation int) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.ingestion_jobs (organisation_id, source_version_id, stage, executor,
                                       data_class, index_generation)
      values (p_organisation_id, p_source_version_id, p_stage, p_executor, p_data_class, p_index_generation);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- A 1024-component vector, matching the dimensions the fixture index pins (§12.4).
create function pg_temp.pinned_vector() returns text language plpgsql security invoker as $fn$
begin
  return (select '[' || string_agg('0.25', ',') || ']' from generate_series(1, 1024));
end;
$fn$;

-- Capture tables: created by the role that will fill them, so grants and RLS apply to the reads.
set local role authenticated;
create temp table t_coll (case_name text, id uuid, organisation_id uuid);
create temp table t_src (case_name text, id uuid, organisation_id uuid);
create temp table t_chunk (case_name text, id uuid, organisation_id uuid);
create temp table t_out (case_name text, result text);
create temp table t_count (case_name text, n int);
reset role;

-- ---------------------------------------------------------------- 1-10 schema shape and guardrails
select is((select count(*)::int
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0::int, '1 every public table still has RLS enabled (guardrail 000 carry-over)');

select is((select count(*)::int
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                               where cfg like 'search_path=%')),
  0::int, '2 every public SECURITY DEFINER function still pins search_path (guardrail 000 carry-over)');

select is((select count(*)::int
             from (values ('knowledge_collections'), ('knowledge_sources'), ('source_versions'),
                          ('knowledge_chunks'), ('embedding_indexes'), ('chunk_embeddings'),
                          ('ingestion_jobs'), ('outbox_events')) t(tbl)
            where exists (
              select 1
                from pg_constraint con
                join pg_class c on c.oid = con.conrelid
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = t.tbl and con.contype = 'u'
                 and (select array_agg(a.attname::text order by a.attname)
                        from unnest(con.conkey) k
                        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k)
                     = array['id', 'organisation_id'])),
  8::int, '3 all eight knowledge tables carry the composite (id, organisation_id) unique key');

select is((select count(*)::int
             from pg_constraint con
             join pg_class c on c.oid = con.conrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relname in ('knowledge_collections', 'knowledge_sources', 'source_versions',
                                'knowledge_chunks', 'embedding_indexes', 'chunk_embeddings',
                                'ingestion_jobs', 'outbox_events')
              and con.contype = 'f'
              and (select array_agg(a.attname::text order by a.attname)
                     from unnest(con.confkey) k
                     join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k)
                  = array['id', 'organisation_id']),
  9::int, '4 knowledge children reach their parents only through composite (id, organisation_id) foreign keys, including a version''s collection (§6.2)');

select is((select has_table_privilege('anon', 'public.knowledge_collections', 'select')
             or has_table_privilege('anon', 'public.knowledge_chunks', 'select')
             or has_table_privilege('anon', 'public.outbox_events', 'select')),
  false, '5 the anonymous role reaches no knowledge table, although Supabase exposes new tables by default');

select is((select has_table_privilege('authenticated', 'public.source_versions', 'delete')
             or has_table_privilege('authenticated', 'public.knowledge_chunks', 'delete')),
  false, '6 a member cannot hard-delete knowledge rows: the state machines and a retention job do (§7.5)');

select is((select has_table_privilege('authenticated', 'public.knowledge_collections', 'insert')
             or has_table_privilege('authenticated', 'public.knowledge_sources', 'insert')
             or has_table_privilege('authenticated', 'public.source_versions', 'insert')
             or has_table_privilege('authenticated', 'public.knowledge_chunks', 'insert')
             or has_table_privilege('authenticated', 'public.knowledge_collections', 'update')
             or has_table_privilege('authenticated', 'public.source_versions', 'update')
             or has_table_privilege('authenticated', 'public.knowledge_chunks', 'update')),
  false, '7 B1: a member holds no INSERT or UPDATE on any knowledge table; capture and the pipeline write through privileged paths (§4.3, §7.2)');

select is((select count(*)::int
             from pg_class ic
             join pg_am am on am.oid = ic.relam
             join pg_index i on i.indexrelid = ic.oid
             join pg_class t on t.oid = i.indrelid
             join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = 'public' and t.relname = 'knowledge_chunks'
              and am.amname = 'gin' and pg_get_indexdef(ic.oid) like '%search_vector%'),
  1::int, '8 the lexical lane is indexed: GIN over the generated search_vector column (§8.1)');

select ok((select search_vector @@ to_tsquery('simple', 'synthetic & manual')
             from public.knowledge_chunks
            where id = '81000000-0000-4000-8000-000000000001'),
  '9 the fixture chunk is findable through full-text search, so lexical retrieval works when the embedding route is down (§8.1)');

select is((select count(*)::int
             from pg_attribute a
             join pg_class c on c.oid = a.attrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'source_versions'
              and a.attname in ('collection_id', 'uploaded_by') and a.attnum > 0
              and not a.attisdropped and a.attnotnull),
  2::int, '10 B3/B4: a version names the collection it lives in and the identity that captured it, and neither may be left null');

-- ---------------------------------------------------------------- 11-15 content identity, per collection
-- The hashes below are the fixture hashes: 0f1e... is company1's public manual, 1a2b... its
-- Site A note, 9f8e... company2's log. All are made-up 64-hex strings, not digests of anything.
insert into t_out values
  ('hash_other_tenant', pg_temp.try_version_insert('22222222-2222-4222-8222-222222222222',
      '62000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000002', 2,
      '00000000-0000-4000-8000-0000000000b1',
      '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', 'client_confidential')),
  ('hash_other_collection', pg_temp.try_version_insert('11111111-1111-4111-8111-111111111111',
      '61000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 2,
      '00000000-0000-4000-8000-0000000000a1',
      '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809', 'public')),
  ('hash_same_collection', pg_temp.try_version_insert('11111111-1111-4111-8111-111111111111',
      '61000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 3,
      '00000000-0000-4000-8000-0000000000a1',
      '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', 'public')),
  ('version_wrong_collection', pg_temp.try_version_insert('11111111-1111-4111-8111-111111111111',
      '61000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', 4,
      '00000000-0000-4000-8000-0000000000a1',
      '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0', 'public')),
  ('version_no_uploader', pg_temp.try_version_insert_no_uploader('11111111-1111-4111-8111-111111111111',
      '61000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 5,
      '7c1d2e3f4a5b69708192a3b4c5d6e7f87c1d2e3f4a5b69708192a3b4c5d6e7f8', 'public'));

select is((select result from t_out where case_name = 'hash_other_tenant'), 'ok',
  '11 one tenant may hold the same content hash as another: content identity is never global (§6.2)');
select is((select result from t_out where case_name = 'hash_other_collection'), 'ok',
  '12 B3: the same bytes may exist in two collections of one tenant, so a collision cannot reveal that a project corpus holds a document the uploader cannot read (§1.1)');
select is((select result from t_out where case_name = 'hash_same_collection'), '23505',
  '13 B3: within one collection the same content is still deduplicated rather than indexed twice (§7.2 step 4)');
select is((select result from t_out where case_name = 'version_wrong_collection'), '23514',
  '14 B3: a version cannot claim a collection other than its source''s, which is what makes the collection-scoped dedup key safe (§6.2)');
select is((select result from t_out where case_name = 'version_no_uploader'), '23502',
  '15 B4: a version with no capture identity is refused outright; provenance cannot be defaulted (issue #8)');

-- ---------------------------------------------------------------- 16-29 company1 member (Site A member)
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_coll select 'a1', id, organisation_id from public.knowledge_collections;
insert into t_src select 'a1', id, organisation_id from public.knowledge_sources;
insert into t_chunk select 'a1', id, organisation_id from public.knowledge_chunks where chunk_index < 900;
-- B5: these five mutations were reachable through the member policies in the first draft.
insert into t_out values
  ('member_publish_state', pg_temp.try_version_state('71000000-0000-4000-8000-000000000001', 'published')),
  ('member_chunk_own_project', pg_temp.try_chunk('11111111-1111-4111-8111-111111111111',
      '71000000-0000-4000-8000-000000000002', 'client_confidential', 901, '{"page": 1}'::jsonb)),
  ('member_clear_project', pg_temp.try_collection_project_null('51000000-0000-4000-8000-000000000002')),
  ('member_lower_class', pg_temp.try_collection_class('51000000-0000-4000-8000-000000000002', 'public')),
  ('member_set_owner', pg_temp.try_source_owner('61000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-0000000000a2')),
  ('member_set_uploader', pg_temp.try_version_uploader('71000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-0000000000a2')),
  ('member_create_collection', pg_temp.try_collection('11111111-1111-4111-8111-111111111111',
      'probe-member-create', 'uav-compliance', '41000000-0000-4000-8000-000000000001', 'internal'));
reset role;

select is((select result from t_out where case_name = 'scope_a1'), 'ok',
  '16 an active company1 member can scope to company1 (F03)');
select is((select count(*)::int from t_coll where case_name = 'a1'), 2::int,
  '17 a company1 member sees exactly the two collections of their own tenant');
select is((select count(*)::int from t_coll where case_name = 'a1'
             and organisation_id = '22222222-2222-4222-8222-222222222222'), 0::int,
  '18 company2 collections are invisible to a company1 member, by id as well as by count (AGENTS.md §4.2)');
select is((select count(*)::int from t_src where case_name = 'a1'), 2::int,
  '19 the same member sees the two company1 sources');
select is((select count(*)::int from t_src where case_name = 'a1'
             and organisation_id = '22222222-2222-4222-8222-222222222222'), 0::int,
  '20 and no company2 source at all');
select is((select count(*)::int from t_chunk where case_name = 'a1'), 5::int,
  '21 a Site A member sees all five company1 chunks: the tenant-wide corpus plus their project corpus');
select is((select count(*)::int from t_chunk where case_name = 'a1'
             and organisation_id = '22222222-2222-4222-8222-222222222222'), 0::int,
  '22 and none of company2''s chunks');
select is((select result from t_out where case_name = 'member_publish_state'), '42501',
  '23 B5: a member cannot publish their own version with update source_versions set state = published (F13, §7.2 step 7)');
select is((select result from t_out where case_name = 'member_chunk_own_project'), '42501',
  '24 B5: even inside a project they belong to, a member cannot attach a chunk to a published version: chunks are written by the pipeline, not by people (§7.2 step 4)');
select is((select result from t_out where case_name = 'member_clear_project'), '42501',
  '25 B5: a Site A member cannot clear a project collection''s project_id and widen it to the whole tenant (§6.2, §7.2 step 5)');
select is((select result from t_out where case_name = 'member_lower_class'), '42501',
  '26 B5: a member cannot lower a collection''s data class to make a confidential corpus easier to reach (§6.2)');
select is((select result from t_out where case_name = 'member_set_owner'), '42501',
  '27 B5: a member cannot re-point owner_user_id, so provenance labels are not client-writable (§4.1)');
select is((select result from t_out where case_name = 'member_set_uploader'), '42501',
  '28 B4: a member cannot set uploaded_by either: only the capture path, reading auth.uid(), writes it (issue #8)');
select is((select result from t_out where case_name = 'member_create_collection'), '42501',
  '29 a member cannot create a collection at all: standing up a corpus is a tenant-admin action on a reviewed path (§4.3)');

-- ---------------------------------------------------------------- 30-33 company1 member outside Site A
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope_a2', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_coll select 'a2', id, organisation_id from public.knowledge_collections;
insert into t_chunk select 'a2', id, organisation_id from public.knowledge_chunks where chunk_index < 900;
insert into t_out values ('member_chunk_other_project', pg_temp.try_chunk(
    '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000002',
    'client_confidential', 902, '{"page": 1}'::jsonb));
reset role;

select is((select result from t_out where case_name = 'scope_a2'), 'ok',
  '30 a second company1 member can scope to the same tenant');
select is((select count(*)::int from t_coll where case_name = 'a2'), 1::int,
  '31 a member outside Site A sees only the tenant-wide collection (project audience, §6.2)');
select is((select count(*)::int from t_chunk where case_name = 'a2'), 3::int,
  '32 they read exactly the three public chunks: the two Site A chunks are hidden by audience, not by absence (§4.2)');
select is((select result from t_out where case_name = 'member_chunk_other_project'), '42501',
  '33 B5: a member of the same tenant but not of Site A cannot insert a chunk into a Site A version (another project, AGENTS.md §4.2)');

-- ---------------------------------------------------------------- 34-37 company2 member
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('scope_b1', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_coll select 'b1', id, organisation_id from public.knowledge_collections;
insert into t_chunk select 'b1', id, organisation_id from public.knowledge_chunks where chunk_index < 900;
insert into t_count select 'b1_c1_chunks', (select count(*)::int from public.knowledge_chunks
                                             where organisation_id = '11111111-1111-4111-8111-111111111111');
reset role;

select is((select result from t_out where case_name = 'scope_b1'), 'ok',
  '34 the company2 owner can scope to company2');
select is((select count(*)::int from t_coll where case_name = 'b1'), 2::int,
  '35 they see company2''s two collections, including the project-scoped one they are a member of');
select is((select count(*)::int from t_chunk where case_name = 'b1'), 2::int,
  '36 and exactly company2''s two chunks');
select is((select n from t_count where case_name = 'b1_c1_chunks'), 0::int,
  '37 a company2 member reads zero company1 chunks: the same predicate, run in the other direction (§4.2)');

-- ---------------------------------------------------------------- 38-42 two memberships, one session
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
insert into t_out values ('scope_a4_c1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_chunk select 'a4_c1', id, organisation_id from public.knowledge_chunks where chunk_index < 900;
insert into t_out values ('scope_a4_c2', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_chunk select 'a4_c2', id, organisation_id from public.knowledge_chunks where chunk_index < 900;
insert into t_coll select 'a4_c2', id, organisation_id from public.knowledge_collections;
reset role;

select is((select count(*)::int from t_chunk where case_name = 'a4_c1'), 5::int,
  '38 under the company1 scope a dual member sees the five company1 chunks (they are a Site A member)');
select is((select count(*)::int from t_chunk where case_name = 'a4_c2'), 0::int,
  '39 after re-scoping to company2 they see no chunks at all: company2''s corpus is project-scoped and they are not a member of that project, and no company1 row followed them across the switch (§4.2, §4.3)');
-- CI run 42063192297 reported "have: 1, want: 0" for the old assertion 40, and CI is right:
-- company2's 52…0001 (gpr-reference) is tenant-wide — project_id is null, class public — so an
-- active company2 member must see it in the company2 scope. That is plan §1.1/§6.2 audience
-- working, not a leak: membership in the tenant is what opens a tenant-wide corpus. The rules
-- with teeth here are (a) exactly one collection, (b) it is the tenant-wide one of the tenant
-- they are scoped to, which by arithmetic means no company1 row crossed the switch, and
-- (c) the project-scoped corpus stays hidden because they are not a member of that project.
select is((select count(*)::int from t_coll where case_name = 'a4_c2'), 1::int,
  '40 in the company2 scope a dual member sees exactly one collection: the tenant-wide corpus of the tenant they are scoped to now (§4.3)');
select is((select count(*)::int from t_coll where case_name = 'a4_c2'
             and id = '52000000-0000-4000-8000-000000000001'
             and organisation_id = '22222222-2222-4222-8222-222222222222'), 1::int,
  '41 that single row is company2''s tenant-wide gpr-reference collection, which together with 40 means no company1 collection crossed the scope switch with them (§4.2)');
select is((select count(*)::int from t_coll where case_name = 'a4_c2'
             and id = '52000000-0000-4000-8000-000000000002'), 0::int,
  '42 but company2''s project-scoped xray-site-data collection stays hidden: they are a member of the tenant, not of that project, and tenant membership is not project membership (§1.1, §6.2)');

-- ---------------------------------------------------------------- 43-44 suspended membership
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_out values ('scope_a3', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_count select 'a3_all',
  (select count(*)::int from public.knowledge_collections)
  + (select count(*)::int from public.knowledge_sources)
  + (select count(*)::int from public.source_versions)
  + (select count(*)::int from public.knowledge_chunks)
  + (select count(*)::int from public.chunk_embeddings)
  + (select count(*)::int from public.embedding_indexes)
  + (select count(*)::int from public.ingestion_jobs)
  + (select count(*)::int from public.outbox_events);
reset role;

select is((select result from t_out where case_name = 'scope_a3'), '28000',
  '43 a suspended membership cannot scope, even holding a real organization id (§4.2)');
select is((select n from t_count where case_name = 'a3_all'), 0::int,
  '44 the deactivated member sees nothing in any knowledge table, including the job and outbox queues');

-- ---------------------------------------------------------------- 45-48 outbox atomicity (§7.2 step 1)
savepoint sp_outbox;
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, owner_user_id)
  values ('69000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
          '51000000-0000-4000-8000-000000000001', 'note', '00000000-0000-4000-8000-0000000000a1');
insert into public.source_versions (id, organisation_id, source_id, collection_id, version_number,
                                    uploaded_by, data_class, content_hash, object_ref, state)
  values ('79000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
          '69000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 1,
          '00000000-0000-4000-8000-0000000000a1', 'public',
          '7c1d2e3f4a5b69708192a3b4c5d6e7f87c1d2e3f4a5b69708192a3b4c5d6e7f8',
          'knowledge/fixture/probe-outbox/v1.bin', 'received');

select is((select count(*)::int from public.outbox_events
            where aggregate_type = 'source_version'
              and aggregate_id = '79000000-0000-4000-8000-000000000001'), 1::int,
  '45 capture writes the source version and exactly one outbox event in the same transaction (§7.2 step 1)');
select is((select event_type from public.outbox_events
            where aggregate_id = '79000000-0000-4000-8000-000000000001'),
  'knowledge.source_version.received',
  '46 the event names the stage to start from and carries scope rather than object access (§13)');

update public.source_versions set state = 'validating'
 where id = '79000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.outbox_events
            where aggregate_id = '79000000-0000-4000-8000-000000000001'), 1::int,
  '47 a state update appends no second capture event: the outbox cannot double-dispatch one version (§7.5)');
rollback to savepoint sp_outbox;

select is((select count(*)::int from public.outbox_events
            where aggregate_id = '79000000-0000-4000-8000-000000000001'), 0::int,
  '48 a rolled-back capture leaves no event behind, so a queue message can never outrun the data (§7.2)');

-- ---------------------------------------------------------------- 49-70 the privileged write path
-- These run as the migration owner, which is how the scoped RPCs and the pipeline write (plan
-- §4.3, §13). Removing a guard trigger would fail them even though members already hold no
-- write grant: the rule has to hold for the privileged path as well (§20.4 item 2).
-- Content and class probes come before the state probes: revoking the company1 public version
-- below is itself a state change, and after that only deletion may follow (§7.3).
insert into t_out values
  ('collection_clear_project', pg_temp.try_collection_project_null('51000000-0000-4000-8000-000000000002')),
  ('collection_move_org', pg_temp.try_collection_org('51000000-0000-4000-8000-000000000001',
      '22222222-2222-4222-8222-222222222222')),
  ('collection_lower_class', pg_temp.try_collection_class('51000000-0000-4000-8000-000000000002', 'public')),
  ('collection_raise_class', pg_temp.try_collection_class('51000000-0000-4000-8000-000000000001', 'internal')),
  ('collection_restricted', pg_temp.try_collection('11111111-1111-4111-8111-111111111111',
      'probe-restricted', 'uav-compliance', null, 'restricted')),
  ('collection_no_project', pg_temp.try_collection('11111111-1111-4111-8111-111111111111',
      'probe-no-project', 'uav-compliance', null, 'client_confidential')),
  ('collection_bogus_class', pg_temp.try_collection('11111111-1111-4111-8111-111111111111',
      'probe-bogus-class', 'uav-compliance', null, 'secret')),
  ('chunk_below_parent_class', pg_temp.try_chunk('11111111-1111-4111-8111-111111111111',
      '71000000-0000-4000-8000-000000000002', 'public', 903, '{"page": 1}'::jsonb)),
  ('chunk_bad_locator', pg_temp.try_chunk('11111111-1111-4111-8111-111111111111',
      '71000000-0000-4000-8000-000000000001', 'public', 904, '{"page": "three"}'::jsonb)),
  ('chunk_ok', pg_temp.try_chunk('11111111-1111-4111-8111-111111111111',
      '71000000-0000-4000-8000-000000000001', 'public', 905, '{"page": 12, "section": "Maintenance"}'::jsonb)),
  ('chunk_xtenant', pg_temp.try_chunk('11111111-1111-4111-8111-111111111111',
      '72000000-0000-4000-8000-000000000001', 'public', 906, '{"page": 1}'::jsonb));

select is((select result from t_out where case_name = 'collection_clear_project'), '23514',
  '49 B2: clearing a project collection''s project_id is refused on the privileged path too: widening a corpus needs a new collection (§6.2)');
select is((select result from t_out where case_name = 'collection_move_org'), '23514',
  '50 B2: a collection cannot be moved to another tenant, which is what the composite keys depend on (§6.2)');
select is((select result from t_out where case_name = 'collection_lower_class'), '23514',
  '51 B2: relabelling cannot lower a collection''s data class (§6.2)');
select is((select result from t_out where case_name = 'collection_raise_class'), 'ok',
  '52 raising a collection''s class is the one direction the guard allows, so the rule is a direction and not a block (§6.2)');
select is((select result from t_out where case_name = 'collection_restricted'), '23514',
  '53 a restricted collection cannot be created in M1: the SQL mirror of isIngestibleInM1 (§12.4, §15.0)');
select is((select result from t_out where case_name = 'collection_no_project'), '23514',
  '54 a client_confidential collection without a project is rejected (§6.2)');
select is((select result from t_out where case_name = 'collection_bogus_class'), '23514',
  '55 an unrecognised data class is rejected rather than defaulted to something permissive (§6.2)');
select is((select result from t_out where case_name = 'chunk_below_parent_class'), '23514',
  '56 a chunk may not carry a lower class than the source version it came from (§6.2, AGENTS.md §4.4)');
select is((select result from t_out where case_name = 'chunk_bad_locator'), '23514',
  '57 a locator is structured metadata: a page that is not a number is refused (F12)');
select is((select result from t_out where case_name = 'chunk_ok'), 'ok',
  '58 a correctly labelled chunk in a readable version is accepted, so the guards above are not a blanket block');
select is((select result from t_out where case_name = 'chunk_xtenant'), '23503',
  '59 the composite FK makes a cross-tenant chunk impossible for every role, privileged paths included (§6.2)');

insert into t_out values
  ('version_text', pg_temp.try_version_text('71000000-0000-4000-8000-000000000002',
      'Rewritten synthetic text: a correction must create a new version, not edit this one.')),
  ('version_hash', pg_temp.try_version_hash('71000000-0000-4000-8000-000000000002',
      '11aa22bb33cc44dd55ee66ff77aa88bb11aa22bb33cc44dd55ee66ff77aa88bb')),
  ('version_uploader', pg_temp.try_version_uploader('71000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-0000000000b1')),
  ('class_lowered', pg_temp.try_version_class('71000000-0000-4000-8000-000000000002', 'public')),
  ('class_raised', pg_temp.try_version_class('71000000-0000-4000-8000-000000000001', 'internal')),
  ('chunk_text', pg_temp.try_chunk_text('81000000-0000-4000-8000-000000000002',
      'Rewritten synthetic chunk text.')),
  ('current_version_other_source', pg_temp.try_current_version('61000000-0000-4000-8000-000000000002',
      '71000000-0000-4000-8000-000000000001'));

select is((select result from t_out where case_name = 'version_text'), '23514',
  '60 rewriting a source version''s extracted text is refused: corrections are new versions (§7.2)');
select is((select result from t_out where case_name = 'version_hash'), '23514',
  '61 rewriting a source version''s content hash is refused: the hash is the proof of what was captured (F10)');
select is((select result from t_out where case_name = 'version_uploader'), '23514',
  '62 B4: the recorded capture identity cannot be rewritten either, so reviewer independence cannot be backdated (issue #8)');
select is((select result from t_out where case_name = 'class_lowered'), '23514',
  '63 relabelling cannot lower a version''s data class (§6.2)');
select is((select result from t_out where case_name = 'class_raised'), 'ok',
  '64 a reviewer raising a class is accepted, which is the only direction the rule permits (§6.2)');
select is((select result from t_out where case_name = 'chunk_text'), '23514',
  '65 a chunk cannot be rewritten in place either: retrieval cites what was actually extracted (F12)');
select is((select result from t_out where case_name = 'current_version_other_source'), '23503',
  '66 a source cannot adopt another source''s version as current, even inside one tenant (F13)');

insert into t_out values
  ('state_out_of_set', pg_temp.try_version_state('71000000-0000-4000-8000-000000000001', 'processed')),
  ('state_forward', pg_temp.try_version_state('71000000-0000-4000-8000-000000000001', 'superseded')),
  ('state_revoked', pg_temp.try_version_state('71000000-0000-4000-8000-000000000001', 'revoked')),
  ('state_revoked_back', pg_temp.try_version_state('71000000-0000-4000-8000-000000000001', 'published'));

select is((select result from t_out where case_name = 'state_out_of_set'), '23514',
  '67 a state outside the documented set is rejected: there is no hidden sixth state (§7.2)');
select is((select result from t_out where case_name = 'state_forward'), 'ok',
  '68 a legal transition inside the set is accepted (published to superseded, F13)');
select is((select result from t_out where case_name = 'state_revoked'), 'ok',
  '69 revoking a published version is a state change, not a deletion (F14)');
select is((select result from t_out where case_name = 'state_revoked_back'), '23514',
  '70 a revoked version cannot be republished by a stale or replayed job (§7.3, F14)');

-- ---------------------------------------------------------------- 71-79 pinned index generations and jobs
-- The seed clears every class E1 allows (#6, ADR-0007). Narrow this generation to `public` here,
-- inside the test's transaction, so 72 still proves the gate refuses a class the index does not clear.
update public.embedding_indexes set cleared_for = array['public']::text[]
  where id = '91000000-0000-4000-8000-000000000001';
insert into t_out values
  ('embed_wrong_dims', pg_temp.try_embedding('11111111-1111-4111-8111-111111111111',
      '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003', 1, '[0.1,0.2,0.3]')),
  ('embed_uncleared_class', pg_temp.try_embedding('11111111-1111-4111-8111-111111111111',
      '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000004', 1, pg_temp.pinned_vector())),
  ('embed_ok', pg_temp.try_embedding('11111111-1111-4111-8111-111111111111',
      '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 1, pg_temp.pinned_vector())),
  ('embed_wrong_generation', pg_temp.try_embedding('11111111-1111-4111-8111-111111111111',
      '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', 2, pg_temp.pinned_vector())),
  ('embed_rewrite', pg_temp.try_embedding_rewrite('11111111-1111-4111-8111-111111111111',
      '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', pg_temp.pinned_vector())),
  ('index_second_active', pg_temp.try_index('11111111-1111-4111-8111-111111111111', 'corpus', 2, 'active', 1024)),
  ('job_local_box_index', pg_temp.try_job('11111111-1111-4111-8111-111111111111',
      '71000000-0000-4000-8000-000000000002', 'index', 'local_box', 'client_confidential', 1)),
  ('job_restricted', pg_temp.try_job('11111111-1111-4111-8111-111111111111',
      '71000000-0000-4000-8000-000000000002', 'index', 'cloud_worker', 'restricted', 1)),
  ('job_duplicate_stage', pg_temp.try_job('11111111-1111-4111-8111-111111111111',
      '71000000-0000-4000-8000-000000000001', 'index', 'cloud_worker', 'public', 1));

select is((select result from t_out where case_name = 'embed_wrong_dims'), '23514',
  '71 a vector that does not match the pinned dimensions is refused: incomparable vectors are corruption, not noise (§12.4, TOI-ADR-13)');
select is((select result from t_out where case_name = 'embed_uncleared_class'), '23514',
  '72 N1: a vector for a client_confidential chunk is refused against a generation cleared only for public, because embedding sends the full chunk text to the provider (§12.4)');
select is((select result from t_out where case_name = 'embed_ok'), 'ok',
  '73 a vector of the pinned shape, for a chunk the generation is cleared for, is accepted');
select is((select result from t_out where case_name = 'embed_wrong_generation'), '23514',
  '74 a vector cannot be attached to a generation its index row does not name (§8.3)');
select is((select result from t_out where case_name = 'embed_rewrite'), '23514',
  '75 re-embedding writes a new generation; it never overwrites a vector that an answer may still cite (§8.3)');
select is((select result from t_out where case_name = 'index_second_active'), '23505',
  '76 only one generation per tenant index may be active, so the pointer switches atomically (§8.3)');
select is((select result from t_out where case_name = 'job_local_box_index'), '23514',
  '77 the local box may only run extraction: OCR and inference stay separate processes (§13)');
select is((select result from t_out where case_name = 'job_restricted'), '23514',
  '78 restricted content cannot be enqueued for ingestion in M1, in SQL as well as in the payload schema (§12.4)');
select is((select result from t_out where case_name = 'job_duplicate_stage'), '23505',
  '79 a duplicate delivery of the same stage cannot create a second job row: the idempotency key absorbs it (§7.5)');

select * from finish();
rollback;
