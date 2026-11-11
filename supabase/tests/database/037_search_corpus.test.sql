-- T-114 `search_corpus_v1`: the hybrid reader (full text + vector, reciprocal-rank fusion) under RLS.
-- Plan §8.1–§8.3, §6.2, §4.3; F08, F16; ADR-0008 (SQL returns text, never offsets); the supervisor's
-- slot-and-role ruling on #136 (security invoker, `authenticated` only, no write path).
--
-- Structure follows 020_knowledge.test.sql and 040_knowledge_uploads.test.sql: every authorization
-- claim is asserted as `authenticated` with a real JWT subject inside a tenant scope, so deleting a
-- predicate from the RPC fails a test rather than quietly passing. Calls go through SECURITY INVOKER
-- pg_temp.try_* wrappers that return the SQLSTATE instead of aborting the test transaction, and rows
-- are captured in temp tables created by the role that fills them, so a fixture call never prints an
-- ok line (COORDINATION §6b).
--
-- Fixtures: the merged seed (two tenants, the Site A project audience, one pinned `corpus` generation
-- per tenant at 1024 dimensions) plus search-shaped rows this file adds and rolls back — provision
-- text, one unpublished version, and synthetic one-hot vectors so the vector lane has something
-- rankable to name. All of it is invented for this repository (AGENTS.md §4.7): the hashes are md5 of
-- a marker string, digests of nothing.
--
-- Fixture map, so the assertions can name rows instead of guessing:
--   81…0101 tenant-wide, version published 2024-02-01, text holds "SQ-118", NO vector
--   81…0102 tenant-wide, published now,           text "chainage", vector spike 2 (vector lane's nearest)
--   81…0103 Site A (client_confidential), published now, text "grid", vector spike 3
--   81…0104 `received`, never published, text holds "SQ-121"
--   81…0105 tenant-wide, same version as 0101, text "aircraft", vector spike 3
--   81…0106 tenant-wide, version published 2024-03-05 **23:30 UTC**, text holds "daystamp", NO vector
--   seed 81…0003 tenant-wide published now "aircraft", vector spike 4
--   seed 81…0004 Site A published now "grid", no vector
--   seed 81…0005 Site A published now "aircraft", no vector
--   seed 82…0001 company2, published now, "couplant", vector spike 5 (company2's index)
begin;
create extension if not exists pgtap with schema extensions;

select plan(70);

-- ---------------------------------------------------------------- helpers
create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t114-synthetic-' || p_seed) || md5('t114-synthetic-' || p_seed || '-tail');
$fn$;

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

-- SET LOCAL lives for the whole test transaction, so this is how a block reaches a genuinely unscoped
-- call (the merged tenancy migration's own helper, not a session-level reset).
create function pg_temp.try_clear_scope() returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.clear_tenant_scope();
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- The RPC, called as the calling role. Returns the SQLSTATE on a refusal and 'ok' when it ran —
-- including when it ran and legitimately found nothing, which is the distinction 63 pins.
create function pg_temp.try_search(p_organisation_id uuid, p_service_keys text[], p_project_id uuid,
                                   p_collection_ids uuid[], p_query_text text, p_vector text,
                                   p_embedding_index_id uuid, p_effective_on date,
                                   p_authority_filters text[], p_limit integer) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    perform 1 from public.search_corpus_v1(p_organisation_id, p_service_keys, p_project_id,
      p_collection_ids, p_query_text, p_vector::extensions.vector, p_embedding_index_id,
      p_effective_on, p_authority_filters, p_limit);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- One-hot vector against the pinned 1024 dimensions: cosine order is then exactly "which chunk owns
-- which spike", so a test can name the vector lane's first candidate instead of hoping about models.
-- It hands back text, so each call site that reaches the RPC's vector-typed parameter names the type
-- out loud (spike_vector(n)::extensions.vector): Postgres resolves a function call through implicit
-- casts only, so a text expression never finds search_corpus_v1's extensions.vector parameter. The
-- merged 020_knowledge.test.sql:254 and :268 cast the same way at the vector boundary.
create function pg_temp.spike_vector(p_at integer, p_dims integer default 1024) returns text
language plpgsql security invoker as $fn$
declare
  v_body text;
begin
  select string_agg(case when n = p_at then '1' else '0.001' end, ',')
    into v_body from generate_series(1, p_dims) n;
  return '[' || v_body || ']';
end;
$fn$;

-- Temp tables, created as the role that fills them, so the grants and RLS the test exercises are the
-- ones a real request role has (COORDINATION §6b).
set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_rows (case_name text, result_status text, evidence_kind text, chunk_id uuid,
                         collection_id uuid, organisation_id uuid, data_class text, lane text,
                         rank int, lexical_rank int, vector_rank int, exact_match boolean, locator jsonb,
                         rrf numeric, diagnostics jsonb);
create temp table t_count (case_name text, n int);
reset role;

-- ---------------------------------------------------------------- fixtures (owner-written: members hold no write grant, B1/§4.3)
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload', 'synth-search-provision-118', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000000102', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload', 'synth-search-provision-119', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000002', 'note', null, '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000000104', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload', 'synth-search-unpublished', '00000000-0000-4000-8000-0000000000a1');

insert into public.source_versions (id, organisation_id, source_id, collection_id, version_number,
                                    uploaded_by, data_class, content_hash, object_ref, state,
                                    parser_generation, body_text, published_at) values
  ('71000000-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000101', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s118'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000101/v1.pdf',
   'published', 'v1', 'Synthetic provision SQ-118: verify the couplant bottle is sealed and record the aircraft type.', '2024-02-01'),
  ('71000000-0000-4000-8000-000000000102', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000102', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s119'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000102/v1.pdf',
   'published', 'v1', 'Synthetic provision SQ-119: a degraded coupling trace is re-run at the affected chainage.', now()),
  ('71000000-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000103', '51000000-0000-4000-8000-000000000002', 1,
   '00000000-0000-4000-8000-0000000000a1', 'client_confidential', pg_temp.syn_hash('s120'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000103/v1.json',
   'published', 'v1', 'Synthetic site note SQ-120: the second pass over grid four used the reserve threshold for the aircraft type.', now()),
  ('71000000-0000-4000-8000-000000000104', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000104', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('unpublished'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000104/v1.pdf',
   'received', 'v1', 'Synthetic provision SQ-121 captured but never published: readable, not searchable.', null);

insert into public.knowledge_chunks (id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class) values
  ('81000000-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000101', 0,
   '{"page": 18, "section": "Provisions"}', 'Synthetic provision SQ-118: verify the couplant bottle is sealed and record the aircraft type.', 'public'),
  ('81000000-0000-4000-8000-000000000102', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000102', 0,
   '{"page": 19, "section": "Provisions"}', 'Synthetic provision SQ-119: a degraded coupling trace is re-run at the affected chainage.', 'public'),
  ('81000000-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000103', 0,
   '{"page": 2, "section": "Site note"}', 'Synthetic site note SQ-120: the second pass over grid four used the reserve threshold for the aircraft type.', 'client_confidential'),
  ('81000000-0000-4000-8000-000000000104', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000104', 0,
   '{"page": 1, "section": "Draft"}', 'Synthetic provision SQ-121 captured but never published: readable, not searchable.', 'public'),
  ('81000000-0000-4000-8000-000000000105', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000101', 1,
   '{"page": 18, "section": "Provisions"}', 'Synthetic run sheet for the same provision: the aircraft type and the reserve threshold for the sortie are recorded before the first pass.', 'public');

-- The #161 day-boundary fixture: one version published at **23:30 UTC** on 2024-03-05. The offset is
-- written into the literal (`23:30:00+00`) on purpose — the ruling is that an asked date means the UTC
-- calendar day, so the row that proves it has to be pinned in UTC as well, or the session's TimeZone
-- would decide which side of the boundary it falls on and the test would be measuring the venue.
-- `daystamp` is a token no other case queries, so this row stays out of every earlier count while
-- remaining readable, published and tenant-wide.
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000000105', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload', 'synth-search-dayboundary', '00000000-0000-4000-8000-0000000000a1');

insert into public.source_versions (id, organisation_id, source_id, collection_id, version_number,
                                    uploaded_by, data_class, content_hash, object_ref, state,
                                    parser_generation, body_text, published_at) values
  ('71000000-0000-4000-8000-000000000105', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000105', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('dayboundary'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000105/v1.pdf',
   'published', 'v1', 'Synthetic boundary note SQ-123: the daystamp marker records one late pass.', '2024-03-05 23:30:00+00');

insert into public.knowledge_chunks (id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class) values
  ('81000000-0000-4000-8000-000000000106', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000105', 0,
   '{"page": 3, "section": "Boundary"}', 'Synthetic boundary note SQ-123: the daystamp marker records one late pass.', 'public');

-- Vectors against each tenant's pinned `corpus` generation. 0101 deliberately has none: that is what
-- makes assertions 8-10 non-vacuous, because the text lane is the only one that can reach that chunk.
insert into public.chunk_embeddings (organisation_id, index_id, chunk_id, index_generation, embedding) values
  ('11111111-1111-4111-8111-111111111111', '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000102', 1, pg_temp.spike_vector(2)::extensions.vector),
  ('11111111-1111-4111-8111-111111111111', '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000103', 1, pg_temp.spike_vector(3)::extensions.vector),
  ('11111111-1111-4111-8111-111111111111', '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000105', 1, pg_temp.spike_vector(3)::extensions.vector),
  ('11111111-1111-4111-8111-111111111111', '91000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003', 1, pg_temp.spike_vector(4)::extensions.vector),
  ('22222222-2222-4222-8222-222222222222', '92000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 1, pg_temp.spike_vector(5)::extensions.vector);

-- ---------------------------------------------------------------- 1-6 shape, role and grants
-- #136: this packet is a reader. A definer here would be a query path that outranks the caller's own
-- policies, which is exactly what plan §4.3 refuses for a retrieval RPC.
select is((select count(*)::int from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'search_corpus_v1'), 1::int,
  '1 search_corpus_v1 exists in public — the assertion that fails first until the migration lands (plan §8.2)');

select is((select p.prosecdef from pg_proc p
            where p.oid = 'public.search_corpus_v1(uuid, text[], uuid, uuid[], text, extensions.vector, uuid, date, text[], integer)'::regprocedure),
  false, '2 the RPC is SECURITY INVOKER, so the querying role''s RLS is the authorization boundary (#136, §4.3)');

select is((select exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                             where cfg like 'search_path=%' and cfg like '%pg_temp%')
             from pg_proc p
            where p.oid = 'public.search_corpus_v1(uuid, text[], uuid, uuid[], text, extensions.vector, uuid, date, text[], integer)'::regprocedure),
  true, '3 the RPC pins its search_path, so no caller can re-point a helper it relies on (§4.3)');

select is(has_function_privilege('anon', 'public.search_corpus_v1(uuid, text[], uuid, uuid[], text, extensions.vector, uuid, date, text[], integer)', 'execute'),
  false, '4 anon cannot execute it: knowledge is behind sign-in and 001 rule 31 stays closed (§4.2, FAQ-0010)');

select is(has_function_privilege('authenticated', 'public.search_corpus_v1(uuid, text[], uuid, uuid[], text, extensions.vector, uuid, date, text[], integer)', 'execute'),
  true, '5 authenticated holds EXECUTE by full signature: the request-role grant 001 rule 32 allow-lists in this same PR (FAQ-0010)');

select is((select has_table_privilege('authenticated', 'public.knowledge_chunks', 'insert')
             or has_table_privilege('authenticated', 'public.knowledge_chunks', 'update')
             or has_table_privilege('authenticated', 'public.chunk_embeddings', 'delete')),
  false, '6 the reader adds no write path: members still hold no INSERT, UPDATE or DELETE on any knowledge table (#136, B1)');

-- ---------------------------------------------------------------- 7-14 the two lanes and their fusion
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
-- Exact lookup first: the provision number matches lexically while the query vector points elsewhere
-- (spike 2 = chunk 0102). Chunk 0101 has no vector, so both lanes score it 1/61 and the documented
-- deterministic-lookup precedence is the only thing that can decide the tie (§8.1 step 4).
insert into t_rows
  select 'exact_first', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array['uav-compliance']::text[], null, null,
         'SQ-118', pg_temp.spike_vector(2)::extensions.vector, '91000000-0000-4000-8000-000000000001', null, null, 10);
-- The same query with no embedding at all: the degraded lane, labelled rather than failed (§8.1 step 6).
insert into t_rows
  select 'lexical_only', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array['uav-compliance']::text[], null, null,
         'SQ-118', null, null, null, null, 10);
-- A term no chunk contains, with a vector: only the vector lane can answer, so a `vector` row here
-- proves the second lane is real and not the first one wearing another label.
insert into t_rows
  select 'vector_only', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array['uav-compliance']::text[], null, null,
         'quadrant', pg_temp.spike_vector(3)::extensions.vector, '91000000-0000-4000-8000-000000000001', null, null, 10);
-- A term several chunks share, so fusion has something to combine.
insert into t_rows
  select 'both_lanes', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array['uav-compliance']::text[], null, null,
         'aircraft', pg_temp.spike_vector(4)::extensions.vector, '91000000-0000-4000-8000-000000000001', null, null, 10);
-- A valid project the caller may read but no collection is bound to: the tenant-wide corpus stays and
-- other projects' corpora drop out (§8.1 step 3: narrowing, never broadening).
insert into t_rows
  select 'project_field_notes', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[],
         '41000000-0000-4000-8000-000000000002', null, 'aircraft', null, null, null, null, 10);
reset role;

select is((select result from t_out where case_name = 'scope_a1'), 'ok',
  '7 an active company1 member scopes to company1, and that scope is what the RPC reads (F03, §4.3)');

select is((select chunk_id from t_rows where case_name = 'exact_first' and rank = 1),
  '81000000-0000-4000-8000-000000000101',
  '8 the provision-number query returns the chunk naming SQ-118 first, before the vector lane''s nearest neighbour (§8.1 step 4)');

select is((select lane || '/' || coalesce(vector_rank::text, 'none') || '/' || exact_match
             from t_rows where case_name = 'exact_first' and rank = 1),
  'lexical/none/true',
  '9 that first row came only from the text lane and carries the exact-lookup marker, so its win is not a vector score wearing another label (§8.2 ranking diagnostics)');

select is((select chunk_id || '/' || lane || '/' || rank from t_rows
            where case_name = 'exact_first' and vector_rank = 1 and evidence_kind = 'chunk'),
  '81000000-0000-4000-8000-000000000102/vector/2',
  '10 the vector lane did run and did rank chunk 0102 first inside its own lane, and the deterministic hit still outranks it (§8.1 step 6, §8.2)');

select is((select locator ->> 'page' from t_rows where case_name = 'exact_first' and rank = 1), '18',
  '11 the row arrives with its page locator, which is what a citation is later built from (F12, F21)');

select is((select count(*)::int from t_rows where case_name = 'vector_only' and evidence_kind = 'chunk'
             and lane = 'vector' and lexical_rank is null) >= 1, true,
  '12 a query the text lane cannot match still returns rows through the pinned index identity, so the hybrid half is not decorative (§8.2)');

select is((select lane from t_rows where case_name = 'both_lanes' and evidence_kind = 'chunk'
            order by rrf desc, rank limit 1), 'both',
  '13 reciprocal-rank fusion puts a chunk both lanes agree on above any single-lane chunk (§8.1 step 6)');

select is((select count(*)::int from t_rows where case_name = 'project_field_notes' and evidence_kind = 'chunk'
             and collection_id = '51000000-0000-4000-8000-000000000002'), 0::int,
  '14 a readable project with nothing bound to it drops the other project''s corpus: p_project_id narrows and never claims a wider audience (§8.1 step 3)');

-- ---------------------------------------------------------------- 15-18 lexical_only is a label, not a loophole
select is((select lane from t_rows where case_name = 'lexical_only' and rank = 1), 'lexical',
  '15 the degraded lane is labelled and still returns the authorized row (§8.1 step 6)');

select is((select (diagnostics ->> 'retrieval_mode') from t_rows where case_name = 'lexical_only' and rank = 1),
  'lexical_only',
  '16 and the diagnostics say so, so reduced search quality is visible to the employee rather than inferred (§8.2, chat.ts retrievalMode)');

select is((select (diagnostics -> 'signals' ->> 'index_unavailable')::boolean
             from t_rows where case_name = 'lexical_only' and rank = 1), true,
  '17 with no query vector the pinned index is reported unavailable instead of quietly skipped (§8.2 index_unavailable)');

select is((select count(*)::int from t_rows where case_name = 'lexical_only'
             and (chunk_id in ('81000000-0000-4000-8000-000000000103', '82000000-0000-4000-8000-000000000001')
                  or organisation_id = '22222222-2222-4222-8222-222222222222')), 0::int,
  '18 the degraded lane is no wider than the hybrid one: no project-restricted chunk, no other tenant''s chunk (§4.2)');

-- ---------------------------------------------------------------- 19-24 cross-tenant
-- The same question shape under a company2 scope, against company2's own pinned index.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('scope_b1', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_rows
  select 'b1_foreign_term', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('22222222-2222-4222-8222-222222222222', array[]::text[], null, null,
         'SQ-118', null, null, null, null, 10);
insert into t_rows
  select 'b1_hybrid', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('22222222-2222-4222-8222-222222222222', array[]::text[], null, null,
         'SQ-118', pg_temp.spike_vector(2)::extensions.vector, '92000000-0000-4000-8000-000000000001', null, null, 10);
insert into t_rows
  select 'b1_own_term', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('22222222-2222-4222-8222-222222222222', array['gpr']::text[], null, null,
         'couplant', pg_temp.spike_vector(5)::extensions.vector, '92000000-0000-4000-8000-000000000001', null, null, 10);
insert into t_rows
  select 'b1_foreign_collection', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('22222222-2222-4222-8222-222222222222', array[]::text[], null,
         array['51000000-0000-4000-8000-000000000001']::uuid[], 'couplant', null, null, null, null, 10);
reset role;

select is((select result from t_out where case_name = 'scope_b1'), 'ok',
  '19 the company2 owner can scope to company2 (F03)');

select is((select count(*)::int from t_rows where case_name = 'b1_foreign_term' and evidence_kind = 'chunk'), 0::int,
  '20 the same question from another tenant returns zero evidence rows: SQ-118 exists only in company1''s corpus (§4.2)');

select is((select result_status from t_rows where case_name = 'b1_foreign_term' and rank = 1),
  'no_accessible_evidence',
  '21 and the caller is told which kind of empty this is, in one diagnostics row rather than an empty array (§8.2)');

select is((select count(*)::int from t_rows where case_name = 'b1_hybrid' and evidence_kind = 'chunk'
             and organisation_id = '11111111-1111-4111-8111-111111111111'), 0::int,
  '22 even with both lanes open no company1 row crosses into a company2 answer: RLS is the boundary, not the query text (§4.2, AGENTS.md §4.1)');

select is((select chunk_id from t_rows where case_name = 'b1_own_term' and rank = 1),
  '82000000-0000-4000-8000-000000000001',
  '23 company2''s own corpus answers the same shape of query on the same index shape, so 20 is audience and not a broken reader (§8.1)');

select is((select count(*)::int from t_rows where case_name = 'b1_foreign_collection' and evidence_kind = 'chunk'), 0::int,
  '24 a company1 collection id handed to a company2 caller narrows to nothing instead of opening that tenant (§4.2, §8.2)');

-- ---------------------------------------------------------------- 25-29 project audience
-- 0103 and seed chunks 81…0004/81…0005 sit in company1's Site A (client_confidential) collection.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope_a2', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_rows
  select 'a2_grid', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'grid', pg_temp.spike_vector(3)::extensions.vector, '91000000-0000-4000-8000-000000000001', null, null, 10);
insert into t_rows
  select 'a2_own', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'SQ-119', null, null, null, null, 10);
insert into t_out values ('a2_narrow_unreadable', pg_temp.try_search('11111111-1111-4111-8111-111111111111',
  array[]::text[], null, array['51000000-0000-4000-8000-000000000002']::uuid[], 'SQ-120', null, null, null, null, 10));
insert into t_rows
  select 'a2_narrow_unreadable_rows', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null,
         array['51000000-0000-4000-8000-000000000002']::uuid[], 'SQ-120', null, null, null, null, 10);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_rows
  select 'a1_grid', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'grid', pg_temp.spike_vector(3)::extensions.vector, '91000000-0000-4000-8000-000000000001', null, null, 10);
reset role;

select is((select count(*)::int from t_rows where case_name = 'a2_grid' and evidence_kind = 'chunk'
             and chunk_id in ('81000000-0000-4000-8000-000000000103', '81000000-0000-4000-8000-000000000004',
                              '81000000-0000-4000-8000-000000000005')), 0::int,
  '25 a company1 member outside Site A never sees the project-restricted chunks, through either lane (§1.1, §6.2)');

select is((select count(*)::int from t_rows where case_name = 'a1_grid' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000103'), 1::int,
  '26 the same query for a Site A member does return them: the audience rule is membership, not a keyword block (§6.2)');

select is((select data_class from t_rows where case_name = 'a1_grid' and chunk_id = '81000000-0000-4000-8000-000000000103'),
  'client_confidential',
  '27 every row carries the chunk''s own data class, so the caller propagates the highest class among its dependencies (§6.2, AGENTS.md §4.4)');

select is((select count(*)::int from t_rows where case_name = 'a2_own' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000102') >= 1, true,
  '28 and that member still reads the tenant-wide corpus, so 25 is a narrowing rather than a shut-off (§4.2)');

select is((select count(*)::int from t_rows where case_name = 'a2_narrow_unreadable_rows' and evidence_kind = 'chunk'), 0::int,
  '29 p_collection_ids naming a collection the caller may not read narrows to nothing: it is a filter, never a grant (§8.2)');

-- ---------------------------------------------------------------- 30-34 the scope and membership gates
insert into t_out values ('clear_scope', pg_temp.try_clear_scope());
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('no_scope', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', null, null, null, null, 10)),
  ('null_org', pg_temp.try_search(null, array[]::text[], null, null, 'aircraft', null, null, null, null, 10)),
  ('mismatched_org', pg_temp.try_search('22222222-2222-4222-8222-222222222222', array[]::text[], null, null,
     'aircraft', null, null, null, null, 10)),
  ('re_scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;

select is((select result from t_out where case_name = 'no_scope'), '28000',
  '30 with no transaction scope the RPC raises (28000) instead of searching every tenant it can reach (§4.3, AGENTS.md §4.1)');

select is((select result from t_out where case_name = 'null_org'), '22023',
  '31 a missing host-derived organization is a bad request, not a scope for the database to guess (§8.2)');

select is((select result from t_out where case_name = 'mismatched_org'), '28000',
  '32 p_organisation_id is honored only when it agrees with the session scope: the parameter is a cross-check, never the tenant (§4.1, §8.2)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_rows
  select 'a1_regate', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'SQ-119', null, null, null, null, 10);
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_out values ('suspended_search', pg_temp.try_search('11111111-1111-4111-8111-111111111111',
  array[]::text[], null, null, 'SQ-119', null, null, null, null, 10));
reset role;

select is((select result from t_out where case_name = 'suspended_search'), '28000',
  '33 a removed membership is refused under a scope an active member established: the RPC re-checks auth.uid() rather than trusting the GUC (§4.2, AGENTS.md §4.1)');

select is((select count(*)::int from t_rows where case_name = 'a1_regate' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000102') >= 1, true,
  '34 the active member still gets rows in the same transaction after that refusal, so 33 is the membership gate and not a broken connection (§4.2)');

-- ---------------------------------------------------------------- 35-42 narrowing, scope claims, and the pinned index
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope_a2b', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values
  ('a2_bad_project', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[],
     '41000000-0000-4000-8000-000000000001', null, 'aircraft', null, null, null, null, 10)),
  ('a2_foreign_project', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[],
     '42000000-0000-4000-8000-000000000001', null, 'aircraft', null, null, null, null, 10)),
  ('a2_unknown_project', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[],
     '00000000-0000-4000-8000-0000000000ff', null, 'aircraft', null, null, null, null, 10)),
  ('unknown_collection', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null,
     array['00000000-0000-4000-8000-0000000000fe']::uuid[], 'aircraft', null, null, null, null, 10));
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1c', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values
  ('active_index', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', pg_temp.spike_vector(3), '91000000-0000-4000-8000-000000000001', null, null, 10)),
  ('wrong_dims', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', '[0.1,0.2,0.3]', '91000000-0000-4000-8000-000000000001', null, null, 10)),
  ('vector_no_index', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', pg_temp.spike_vector(3), null, null, null, 10)),
  ('foreign_index', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', pg_temp.spike_vector(3), '92000000-0000-4000-8000-000000000001', null, null, 10));
reset role;

-- Owner-run, exactly as 040_knowledge_uploads.test.sql:411 and :428 do it: a member holds no UPDATE on
-- embedding_indexes, so retiring a generation has to come from the privileged side (§4.3). The scope
-- set above is SET LOCAL for this transaction, so the call below still runs scoped.
update public.embedding_indexes set status = 'retired' where id = '91000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('retired_index', pg_temp.try_search('11111111-1111-4111-8111-111111111111',
  array[]::text[], null, null, 'aircraft', pg_temp.spike_vector(3), '91000000-0000-4000-8000-000000000001', null, null, 10));
reset role;
update public.embedding_indexes set status = 'active' where id = '91000000-0000-4000-8000-000000000001';

select is((select result from t_out where case_name = 'a2_bad_project'), '42501',
  '35 a project id the caller is not a member of is an error, not a filter that quietly disappears and widens the search (§8.2)');

select is((select result from t_out where case_name = 'a2_foreign_project'), '42501',
  '36 and so is another tenant''s project id, answered identically, so project ids are not probeable (§4.2)');

select is((select result from t_out where case_name = 'a2_unknown_project'), '42501',
  '37 an unknown project id answers the same way: no widening and no existence oracle (§4.2)');

select is((select result from t_out where case_name = 'unknown_collection'), 'ok',
  '38 a collection id that does not exist is a filter that matches nothing, which is the deliberate contrast with 37 (§8.2)');

select is((select result from t_out where case_name = 'active_index'), 'ok',
  '39 the tenant''s own active generation is accepted, so 40-42 are the identity rule and not a blanket refusal (§8.3)');

select is((select result from t_out where case_name = 'wrong_dims'), '55000',
  '40 a 3-dimension query vector against an index pinned at 1024 is refused: incomparable vectors are not a ranking signal (§12.4, TOI-ADR-13)');

select is((select result from t_out where case_name = 'vector_no_index'), '22023',
  '41 a vector with no pinned identity cannot be searched at all, so it is never compared against a generation nobody chose (§8.3)');

select is((select result from t_out where case_name = 'foreign_index'), '42501',
  '42 another tenant''s index id is not in this scope: RLS answers, and the reader never becomes a tenant probe (§4.2)');

select is((select result from t_out where case_name = 'retired_index'), '55000',
  '43 a retired generation is refused rather than searched at reduced quality: no active pointer, no vector lane (§8.3)');

-- ---------------------------------------------------------------- 44-48 publication and revocation
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1d', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_rows
  select 'unpublished', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'SQ-121', null, null, null, null, 10);
insert into t_count select 'readable_unpublished', (select count(*)::int from public.knowledge_chunks
                                                     where id = '81000000-0000-4000-8000-000000000104');
reset role;

update public.knowledge_sources set lifecycle_state = 'revoked', revoked_at = now()
  where id = '61000000-0000-4000-8000-000000000101';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1e', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_rows
  select 'revoked_hybrid', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'SQ-118', pg_temp.spike_vector(2)::extensions.vector, '91000000-0000-4000-8000-000000000001', null, null, 10);
insert into t_rows
  select 'revoked_other', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'chainage', null, null, null, null, 10);
reset role;

select is((select n from t_count where case_name = 'readable_unpublished'), 1::int,
  '44 the chunk of the `received` version really is readable to this caller, so 45 is the publication predicate and not an RLS accident (§7.2 step 8, F13)');

select is((select count(*)::int from t_rows where case_name = 'unpublished' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000104'), 0::int,
  '45 retrieval adds `state = published` on top of visibility: a captured version reaches employees only after publication (§8.2, F14)');

select is((select count(*)::int from t_rows where case_name = 'revoked_hybrid' and evidence_kind = 'chunk'
             and chunk_id in ('81000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000105')), 0::int,
  '46 a revoked source stops returning results in the same session with nothing re-indexed or re-embedded: its chunks are gone from both lanes (F14)');

select is((select (count(*) >= 1)::text from t_rows where case_name = 'revoked_hybrid' and evidence_kind = 'chunk')
          || '/' || (select result_status from t_rows where case_name = 'revoked_hybrid' and rank = 1),
  'true/ok',
  '47 the rest of the corpus still answers and the status is still ok: revoking a source removed rows, it did not break the reader (§8.1)');

select is((select count(*)::int from t_rows where case_name = 'revoked_other' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000102'), 1::int,
  '48 a source the caller can still read is unaffected by that revocation, so the reader did not over-react into a shut-off (§8.1)');

-- 46-48 mutated a fixture, so put it back before the effective-date block reads it: the same
-- mutate / assert / restore shape as the retired-index block at :448-454. Without this the 49-53 block
-- contradicts its own comment: 0101 and 0105 are the only material published before 2024-06-01
-- (version 710000000001, published_at 2024-02-01), and 46 had already revoked them. That is why
-- assertion 49 could never pass as this block was written - the fix is the fixture, not the assertion.
update public.knowledge_sources set lifecycle_state = 'active', revoked_at = null
  where id = '61000000-0000-4000-8000-000000000101';

-- ---------------------------------------------------------------- 49-53 effective date and coverage
-- 0101/0105 sit in a version published 2024-02-01; 0103, seed 81…0003 and seed 81…0005 published now.
-- `aircraft` appears in 0101, 0103, 0105, 81…0003 and 81…0005, so an effective date in the middle of
-- that history has to hold the later material back and admit what it cannot know about that date.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1f', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_rows
  select 'effective_2024_06', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'aircraft', null, null, date '2024-06-01', null, 10);
insert into t_rows
  select 'effective_2020_01', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'aircraft', null, null, date '2020-01-01', null, 10);
insert into t_rows
  select 'no_effective', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'aircraft', null, null, null, null, 10);
reset role;

select is((select count(*)::int from t_rows where case_name = 'effective_2024_06' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000101'), 1::int,
  '49 material published before the effective date is searched, in the past as well as today (§8.2 p_effective_on)');

select is((select count(*)::int from t_rows where case_name = 'effective_2024_06' and evidence_kind = 'chunk'
             and chunk_id in ('81000000-0000-4000-8000-000000000103', '81000000-0000-4000-8000-000000000003',
                              '81000000-0000-4000-8000-000000000005')), 0::int,
  '50 and material published after it is held back: an answer about June 2024 cannot cite a version that did not exist then (§8.2)');

select is((select (diagnostics -> 'signals' ->> 'historical_gap')::boolean
             from t_rows where case_name = 'effective_2024_06' and rank = 1), true,
  '51 the distance between that date and the corpus that exists now is reported instead of hidden (§8.2 historical_gap)');

select is((select result_status from t_rows where case_name = 'effective_2020_01' and rank = 1),
  'coverage_unknown',
  '52 with nothing published at the asked date the honest answer is coverage_unknown, a different claim from no_accessible_evidence (§8.2)');

select is((select count(*)::int from t_rows where case_name = 'no_effective' and evidence_kind = 'chunk') >
          (select count(*)::int from t_rows where case_name = 'effective_2024_06' and evidence_kind = 'chunk'),
  true, '53 dropping the effective date widens back to today''s corpus, so the filter demonstrably did something (§8.2)');

-- ---------------------------------------------------------------- 54-60 bounded arguments and the empty/error split
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1g', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values
  ('empty_text', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     '   ', null, null, null, null, 10)),
  ('null_service_keys', pg_temp.try_search('11111111-1111-4111-8111-111111111111', null, null, null,
     'aircraft', null, null, null, null, 10)),
  ('authority_filters', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', null, null, null, array['regulation']::text[], 10)),
  ('limit_zero', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', null, null, null, null, 0)),
  ('limit_huge', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', null, null, null, null, 500)),
  ('malformed_vector', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'aircraft', 'not-a-vector', '91000000-0000-4000-8000-000000000001', null, null, 10)),
  ('ran_and_found_nothing', pg_temp.try_search('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
     'zzzplacetoken', null, null, null, null, 10));
insert into t_rows
  select 'limit_one', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'aircraft', pg_temp.spike_vector(4)::extensions.vector, '91000000-0000-4000-8000-000000000001', null, null, 1);
reset role;

select is((select result from t_out where case_name = 'empty_text'), '22023',
  '54 a blank question is a bad request: this RPC has no "hand me the corpus" mode (§8.2, §9.2)');

select is((select result from t_out where case_name = 'null_service_keys'), '22023',
  '55 service keys must be stated; an empty array means tenant-wide, while a null would be an unasked-for widening (§8.2)');

select is((select result from t_out where case_name = 'authority_filters'), '22023',
  '56 an authority filter this corpus cannot evaluate is refused rather than accepted and ignored, which is the widening case §8.2 forbids (§7.1)');

select is((select result from t_out where case_name = 'limit_zero') || '/' ||
          (select result from t_out where case_name = 'limit_huge'), '22023/22023',
  '57 the limit is bounded at both ends, so a caller can ask for neither the whole corpus nor nothing (§8.3)');

select is((select count(*)::int from t_rows where case_name = 'limit_one' and evidence_kind = 'chunk'), 1::int,
  '58 p_limit caps the evidence rows at the number the caller asked for (§8.3 final evidence budget)');

select is((select (diagnostics -> 'limits' ->> 'truncated')::boolean
             from t_rows where case_name = 'limit_one' and rank = 1), true,
  '59 and truncation is visible in the diagnostics, because a cap that affected the answer has to be shown (§8.3)');

select is((select result from t_out where case_name = 'malformed_vector') || '/' ||
          (select result from t_out where case_name = 'ran_and_found_nothing'), '22P02/ok',
  '60 a malformed argument raises a database error while a legitimate empty result does not: failure and "nothing you may see" are never the same answer (§8.2 backend_failure)');

-- ---------------------------------------------------------------- 61-63 what the diagnostics may say
select is((select position('51000000-0000-4000-8000-000000000002' in diagnostics::text)
             from t_rows where case_name = 'a2_own' and rank = 1), 0::int,
  '61 the diagnostics of a caller outside Site A never name the collection they cannot read: coverage is counts and flags, not an inventory (§8.2, AGENTS.md §4.2)');

select is((select (diagnostics -> 'signals' ->> 'max_data_class')
             from t_rows where case_name = 'a1_grid' and rank = 1), 'client_confidential',
  '62 the diagnostics report the highest class among the rows returned, which is what the gateway clears a model call against (§6.2, §12.4)');

select is((select count(*)::int from t_rows where case_name = 'b1_foreign_term'
             and evidence_kind = 'diagnostics'), 1::int,
  '63 exactly one diagnostics row accompanies an empty result, so the caller never has to guess between empty and failed (§8.2)');

-- ---------------------------------------------------------------- 64 the vector lane names pgvector right
-- pgTAP fails here by *name*, and that is the whole point of the assertion. A misspelled distance
-- function inside the RPC is a plan-time `function ... does not exist` (42883) that only surfaces on
-- the first call opening the vector lane - CI saw exactly that on 2026-11-11 - and a scratch harness
-- whose stand-in declares whatever name the migration asked for cannot see it at all. These three are
-- also the procedures the operators <->, <=> and <#> resolve to. Which one runs is decided by the
-- resolved index row's `metric` and never by a default, because incomparable vectors are refused
-- rather than averaged (§12.4, TOI-ADR-13; assertion 40 pins the dimension half).
select ok(
      to_regprocedure('extensions.l2_distance(extensions.vector, extensions.vector)') is not null
  and to_regprocedure('extensions.cosine_distance(extensions.vector, extensions.vector)') is not null
  and to_regprocedure('extensions.vector_negative_inner_product(extensions.vector, extensions.vector)') is not null
  and to_regprocedure('extensions.vector_l2_distance(extensions.vector, extensions.vector)') is null
  and to_regprocedure('extensions.vector_cosine_distance(extensions.vector, extensions.vector)') is null,
  '64 pgvector exports exactly the distance functions the vector lane calls and not the vector_-prefixed names it does not have, so a future rename fails by name here instead of at the first vector query (§8.3, §12.4)');

-- ---------------------------------------------------------------- 65-70 the supervisor's rulings on #161
-- #161 was answered on 2026-11-11 while this PR was open, with one precision about time zones. These
-- assertions are *added*, and 49-53 and 56 are left standing exactly as they were: the rulings confirm
-- the shape those assertions already pinned and settle the boundary they had left to the session.
-- 65/66 are the day boundary the answer asks for; 67 is `historical_gap` measured at that boundary;
-- 68/69 are the second half of (A) that 56 does not cover — `NULL` and `'{}'` are accepted, and the
-- flag stays false in a run that *succeeded*; 70 keeps 51 and 67 honest by showing the flag is false
-- when nothing was published later.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1h', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_rows
  select 'boundary_same_day', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'daystamp', null, null, date '2024-03-05', null, 10);
insert into t_rows
  select 'boundary_prev_day', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'daystamp', null, null, date '2024-03-04', null, 10);
insert into t_rows
  select 'effective_future', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'aircraft', null, null, date '2100-01-01', null, 10);
-- The accepted half of (A): an empty authority array is a stated "no filter", not a filter to drop.
insert into t_out values ('empty_authority', pg_temp.try_search('11111111-1111-4111-8111-111111111111',
  array[]::text[], null, null, 'daystamp', null, null, date '2024-03-05', array[]::text[], 10));
insert into t_rows
  select 'empty_authority_rows', o_result_status, o_evidence_kind, o_chunk_id, o_collection_id, o_organisation_id,
         o_data_class, o_lane, o_rank, o_lexical_rank, o_vector_rank, o_exact_match, o_locator, o_rrf_score, o_diagnostics
    from public.search_corpus_v1('11111111-1111-4111-8111-111111111111', array[]::text[], null, null,
         'daystamp', null, null, date '2024-03-05', array[]::text[], 10);
reset role;

select is((select count(*)::int from t_rows where case_name = 'boundary_same_day' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000106'), 1::int,
  '65 a version published at 23:30 UTC on 2024-03-05 IS searched when the caller asks about 2024-03-05: the date names the UTC calendar day, not a session-time-zone midnight (#161 (D))');

select is((select count(*)::int from t_rows where case_name = 'boundary_prev_day' and evidence_kind = 'chunk'
             and chunk_id = '81000000-0000-4000-8000-000000000106'), 0::int,
  '66 the same version is NOT available to a caller asking about 2024-03-04: the boundary is UTC midnight, and 65+66 together are why `cast(published_at as date)` is not good enough (#161 (D))');

select is((select (diagnostics -> 'signals' ->> 'historical_gap')::boolean
             from t_rows where case_name = 'boundary_prev_day' and rank = 1), true,
  '67 and the version held back by that boundary is reported as a gap, because readable material published after the asked day exists in scope (#161 (D))');

select is((select result from t_out where case_name = 'empty_authority'), 'ok',
  '68 an empty p_authority_filters array means "no filter" and is accepted: 56 refuses a non-empty one, and only both halves together are the ruled behaviour (#161 (A))');

select is((select diagnostics -> 'filters' ->> 'authority_filters_applied'
             from t_rows where case_name = 'empty_authority_rows' and rank = 1) || '/' ||
           (select diagnostics -> 'filters' ->> 'authority_filters_applied'
             from t_rows where case_name = 'boundary_same_day' and rank = 1), 'false/false',
  '69 authority_filters_applied is false in a run that *succeeded*, whether the caller passed NULL (65) or an empty array (68) — the diagnostics cannot report a filter this corpus does not have as applied (#161 (A))');

select is((select (diagnostics -> 'signals' ->> 'historical_gap')::boolean
             from t_rows where case_name = 'effective_future' and rank = 1), false,
  '70 with an effective date past every published version the gap flag is false, so 51 and 67 report a measured distance rather than a constant true (#161 (D))');

select * from finish();
rollback;
