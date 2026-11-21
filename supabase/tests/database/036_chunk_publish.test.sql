-- T-113 SQL half: chunk/vector writes and atomic publication through `job_api`
-- (supabase/migrations/20261120217000_chunk_publish.sql).
-- Plan §7.2 steps 4-8, §8.3, §12.4; F12, F13.
-- Rulings pinned here:
--   * #134: `toi_job_api` over JOB_DB, credential digest checked inside the same compare as
--     tenant, version, stage, lease token and fence; no table grants to `toi_job_api`.
--   * #136: `job_api.write_chunks_v1` writes chunks and vectors only for the leased job's version
--     (tenant and version come from the job row, never from the caller); `job_api.publish_version_v1`
--     switches `knowledge_sources.current_version_id` atomically in one statement, with re-runs of
--     the same stage key being a no-op; embedding-route-down aborts the `index` job with a closed
--     reason (#99) and leaves the version in `indexing` with no pointer movement.
--   * #142 / FAQ-0010: EXECUTE revoked from public, anon, authenticated, service_role by full
--     signature and granted to `toi_job_api` only; nothing added to `public`.
--
-- Synthetic fixtures only (AGENTS.md §4.7): doubled md5 markers and synthetic prose, rolled back
-- at the end of this transaction. Runtime calls run as `toi_job_api` (and negatively as `anon` /
-- `authenticated`), resetting role to `postgres` before pgTAP assertions because `toi_job_api`
-- holds no privilege on `extensions` or any table.
begin;
create extension if not exists pgtap with schema extensions;

select plan(78);

-- ---------------------------------------------------------------- helpers
create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t113-synthetic-' || p_seed) || md5('t113-synthetic-' || p_seed || '-tail');
$fn$;

-- One-hot 1024-dim JSONB array matching the pinned index dimensions in supabase/seed.sql.
create function pg_temp.spike_json(p_at integer, p_dims integer default 1024) returns jsonb
language plpgsql immutable as $fn$
declare
  v_body text;
begin
  select string_agg(case when n = p_at then '1' else '0.001' end, ',')
    into v_body from generate_series(1, p_dims) n;
  return ('[' || v_body || ']')::jsonb;
end;
$fn$;

create function pg_temp.spike_vec(p_at integer, p_dims integer default 1024) returns text
language plpgsql immutable as $fn$
declare
  v_body text;
begin
  select string_agg(case when n = p_at then '1' else '0.001' end, ',')
    into v_body from generate_series(1, p_dims) n;
  return '[' || v_body || ']';
end;
$fn$;

-- SECURITY INVOKER helpers so role-level privilege refusals surface as SQLSTATE 42501.
create function pg_temp.try_write_chunks(
  p_token_hash text, p_job_id uuid, p_lease_token text, p_fence bigint,
  p_source_version_id uuid, p_index_generation integer, p_embedding_index_id uuid, p_chunks jsonb
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.write_chunks_v1(
      p_token_hash, p_job_id, p_lease_token, p_fence,
      p_source_version_id, p_index_generation, p_embedding_index_id, p_chunks
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_publish_version(
  p_token_hash text, p_job_id uuid, p_lease_token text, p_fence bigint,
  p_source_version_id uuid, p_index_generation integer
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.publish_version_v1(
      p_token_hash, p_job_id, p_lease_token, p_fence,
      p_source_version_id, p_index_generation
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_direct_chunk_insert(
  p_organisation_id uuid, p_source_version_id uuid, p_chunk_index integer, p_data_class text
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.knowledge_chunks (
      organisation_id, source_version_id, chunk_index, locator, body_text, data_class
    ) values (
      p_organisation_id, p_source_version_id, p_chunk_index, '{"page": 1}'::jsonb,
      'Synthetic probe chunk expected to fail constraint.', p_data_class
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_direct_embedding_insert(
  p_organisation_id uuid, p_chunk_id uuid, p_index_id uuid,
  p_index_generation integer, p_vec text
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.chunk_embeddings (
      organisation_id, chunk_id, index_id, index_generation, embedding
    ) values (
      p_organisation_id, p_chunk_id, p_index_id, p_index_generation, p_vec::extensions.vector
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_select_table_as_worker(p_table text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    if p_table = 'knowledge_chunks' then
      perform 1 from public.knowledge_chunks limit 1;
    elsif p_table = 'chunk_embeddings' then
      perform 1 from public.chunk_embeddings limit 1;
    elsif p_table = 'source_versions' then
      perform 1 from public.source_versions limit 1;
    elsif p_table = 'knowledge_sources' then
      perform 1 from public.knowledge_sources limit 1;
    elsif p_table = 'worker_credentials' then
      perform 1 from job_api.worker_credentials limit 1;
    end if;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- ---------------------------------------------------------------- fixtures
-- Dedicated sources for Company1 so seed fixtures remain clean:
--   s3601: public source with v1 published and v2 indexing (happy path write -> publish -> search; B1 superseded target)
--   s3602: public source with v1 published and v2 indexing (embedding-route-down abort -> no publish)
--   s3603: client_confidential source on Site A (class propagation, cleared_for guard, lexical-only & public-only index)
--   s3604: public source whose v1 is revoked mid-flight (F14 no-resurrection on write & publish)
--   s3605: public source with pre-seeded chunk 0 (B2 ON CONFLICT body_text / raised-class refusal & valid re-index)
--   s3606: public source for B3 3-of-10 partial embedding refusal and publish half-embedded backstop
--   s3607: public source with v1/v2 indexing and v3 failed (B1 older-after-newer & failed-target refusal)
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000003601', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-s1', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000003602', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-s2', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000003603', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000002', 'upload', 'syn-t113-s3', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000003604', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-s4', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000003605', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-s5', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000003606', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-s6', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000003607', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-s7', '00000000-0000-4000-8000-0000000000a1');

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text, published_at
) values
  -- s3601 v1 (already published) and v2 (extracting -> indexed -> published)
  ('71000000-0000-4000-8000-000000003611', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003601', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s1v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003601/v1.pdf',
   'published', 'v1', null, now() - interval '2 hours'),
  ('71000000-0000-4000-8000-000000003612', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003601', '51000000-0000-4000-8000-000000000001', 2,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s1v2'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003601/v2.pdf',
   'extracting', 'v1', null, null),
  -- s3602 v1 (published) and v2 (indexing, embedding route down)
  ('71000000-0000-4000-8000-000000003621', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003602', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s2v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003602/v1.pdf',
   'published', 'v1', null, now() - interval '1 hour'),
  ('71000000-0000-4000-8000-000000003622', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003602', '51000000-0000-4000-8000-000000000001', 2,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s2v2'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003602/v2.pdf',
   'indexing', 'v1', null, null),
  -- s3603 v1 & v2 (client_confidential, indexing)
  ('71000000-0000-4000-8000-000000003631', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003603', '51000000-0000-4000-8000-000000000002', 1,
   '00000000-0000-4000-8000-0000000000a1', 'client_confidential', pg_temp.syn_hash('s3v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003603/v1.pdf',
   'indexing', 'v1', null, null),
  ('71000000-0000-4000-8000-000000003632', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003603', '51000000-0000-4000-8000-000000000002', 2,
   '00000000-0000-4000-8000-0000000000a1', 'client_confidential', pg_temp.syn_hash('s3v2'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003603/v2.pdf',
   'indexing', 'v1', null, null),
  -- s3604 v1 (revoked mid-flight)
  ('71000000-0000-4000-8000-000000003641', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003604', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s4v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003604/v1.pdf',
   'revoked', 'v1', null, null),
  -- s3605 v1 (B2 conflict verification)
  ('71000000-0000-4000-8000-000000003651', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003605', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s5v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003605/v1.pdf',
   'indexing', 'v1', null, null),
  -- s3606 v1 (B3 3-of-10 partial embedding refusal)
  ('71000000-0000-4000-8000-000000003661', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003606', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s6v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003606/v1.pdf',
   'indexing', 'v1', null, null),
  -- s3607 v1/v2 (indexing) and v3 (failed) for B1 older-after-newer & non-forward-state tests
  ('71000000-0000-4000-8000-000000003671', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003607', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s7v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003607/v1.pdf',
   'indexing', 'v1', null, null),
  ('71000000-0000-4000-8000-000000003672', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003607', '51000000-0000-4000-8000-000000000001', 2,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s7v2'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003607/v2.pdf',
   'indexing', 'v1', null, null),
  ('71000000-0000-4000-8000-000000003673', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000003607', '51000000-0000-4000-8000-000000000001', 3,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('s7v3'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000003607/v3.pdf',
   'failed', 'v1', null, null);

update public.knowledge_sources
   set current_version_id = '71000000-0000-4000-8000-000000003611'
 where id = '61000000-0000-4000-8000-000000003601';

update public.knowledge_sources
   set current_version_id = '71000000-0000-4000-8000-000000003621'
 where id = '61000000-0000-4000-8000-000000003602';

-- Pre-seeded chunks: s3601 v1 (proves v1 disappears once v2 publishes), s3605 v1 (B2 conflict
-- checks), and s3607 v1/v2/v3 (B1 older-after-newer and non-forward-state publish checks).
insert into public.knowledge_chunks (
  id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
) values
  ('81000000-0000-4000-8000-000000003611', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003611', 0, '{"page": 1, "section": "Old SOP"}'::jsonb,
   'Synthetic predecessor SOP: token-t113-old-v1-only calibration note.', 'public', 10),
  ('81000000-0000-4000-8000-000000003651', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003651', 0, '{"page": 1}'::jsonb,
   'Synthetic B2 original chunk text.', 'public', 6),
  ('81000000-0000-4000-8000-000000003671', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003671', 0, '{"page": 1}'::jsonb,
   'Synthetic B1 s7 v1 chunk text.', 'public', 6),
  ('81000000-0000-4000-8000-000000003672', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003672', 0, '{"page": 1}'::jsonb,
   'Synthetic B1 s7 v2 chunk text.', 'public', 6),
  ('81000000-0000-4000-8000-000000003673', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003673', 0, '{"page": 1}'::jsonb,
   'Synthetic B1 s7 v3 failed chunk text.', 'public', 7);

-- A public-only embedding index for Company1 so we can prove cleared_for refuses client_confidential.
insert into public.embedding_indexes (
  id, organisation_id, index_key, provider_key, model, dimensions, metric, generation, status, cleared_for
) values (
  '91000000-0000-4000-8000-000000003601', '11111111-1111-4111-8111-111111111111',
  'public-only', 'workers_ai', 'synthetic-multilingual-e5', 1024, 'cosine', 1, 'active',
  array['public']::text[]
);

-- Worker credentials for Company1 cloud, Company2 cloud, Company1 local_box, and revoked cloud.
insert into job_api.worker_credentials (label, token_hash, executor, organisations, revoked_at) values
  ('syn-t113-cloud-c1', pg_temp.syn_hash('cloud-c1'), 'cloud_worker',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null),
  ('syn-t113-cloud-c2', pg_temp.syn_hash('cloud-c2'), 'cloud_worker',
   array['22222222-2222-4222-8222-222222222222']::uuid[], null),
  ('syn-t113-box-c1', pg_temp.syn_hash('box-c1'), 'local_box',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null),
  ('syn-t113-cloud-revoked', pg_temp.syn_hash('cloud-revoked'), 'cloud_worker',
   array['11111111-1111-4111-8111-111111111111']::uuid[], now());

-- Ingestion jobs (leased with explicit tokens/fences so tests are deterministic and clock-safe).
insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class,
  parser_generation, index_generation, attempt, lease_token, lease_expires_at, lease_fence
) values
  -- j3611: s3601 v2 index job (happy path)
  ('96000000-0000-4000-8000-000000003611', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003612', 'index', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-index-s1v2-aaaa', now() + interval '10 minutes', 2),
  -- j3612: s3601 v2 publish job (happy path, same stage key parser='v1', index_gen=1)
  ('96000000-0000-4000-8000-000000003612', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003612', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s1v2-bbbb', now() + interval '10 minutes', 2),
  -- j3613: s3601 v2 second publish job (re-run under distinct parser_generation after v2 is active)
  ('96000000-0000-4000-8000-000000003613', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003612', 'publish', 'cloud_worker', 'leased', 'public',
   'v1b', 1, 1, 't113-lease-pub-s1v2-cccc', now() + interval '10 minutes', 1),
  -- j3614: matching succeeded index job for v1b so j3613 passes prerequisite check
  ('96000000-0000-4000-8000-000000003614', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003612', 'index', 'cloud_worker', 'succeeded', 'public',
   'v1b', 1, 1, null, null, 1),
  -- j3621: s3602 v2 index job (will be aborted for embedding_route_unavailable)
  ('96000000-0000-4000-8000-000000003621', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003622', 'index', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-index-s2v2-dddd', now() + interval '10 minutes', 1),
  -- j3622: s3602 v2 publish job (must refuse when index job is leased OR aborted)
  ('96000000-0000-4000-8000-000000003622', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003622', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s2v2-eeee', now() + interval '10 minutes', 1),
  -- j3631: s3603 v1 client_confidential index job (guard failures -> rollback -> lexical-only success)
  ('96000000-0000-4000-8000-000000003631', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003631', 'index', 'cloud_worker', 'leased', 'client_confidential',
   'v1', 1, 1, 't113-lease-index-s3v1-ffff', now() + interval '10 minutes', 3),
  -- j3641: s3604 v1 revoked version index job (must refuse 42501)
  ('96000000-0000-4000-8000-000000003641', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003641', 'index', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-index-s4v1-gggg', now() + interval '10 minutes', 1),
  -- j3642: s3604 v1 revoked version publish job (must refuse 42501)
  ('96000000-0000-4000-8000-000000003642', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003641', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s4v1-hhhh', now() + interval '10 minutes', 1),
  -- j3651: expired lease on s3601 v2 extract/index check
  ('96000000-0000-4000-8000-000000003651', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003612', 'index', 'cloud_worker', 'leased', 'public',
   'v1-exp', 1, 1, 't113-lease-expired-iiii', now() - interval '1 minute', 1),
  -- j3652: expired lease on publish
  ('96000000-0000-4000-8000-000000003652', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003612', 'publish', 'cloud_worker', 'leased', 'public',
   'v1-exp', 1, 1, 't113-lease-pub-exp-jjjj', now() - interval '1 minute', 1),
  -- j3615/j3616: s3601 v1 index (succeeded) + publish (leased) for B1 superseded-target check
  ('96000000-0000-4000-8000-000000003615', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003611', 'index', 'cloud_worker', 'succeeded', 'public',
   'v1', 1, 1, null, null, 1),
  ('96000000-0000-4000-8000-000000003616', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003611', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s1v1-sup1', now() + interval '10 minutes', 1),
  -- j3632: s3603 v2 client_confidential index job (B3 public-only-index lexical-only pass)
  ('96000000-0000-4000-8000-000000003632', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003632', 'index', 'cloud_worker', 'leased', 'client_confidential',
   'v1', 1, 1, 't113-lease-idx-s3v2-pubo', now() + interval '10 minutes', 1),
  -- j3661: s3605 v1 index job under parser_generation='v2' (B2 conflict refusal & valid re-index)
  ('96000000-0000-4000-8000-000000003661', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003651', 'index', 'cloud_worker', 'leased', 'public',
   'v2', 1, 1, 't113-lease-idx-s5v1-b201', now() + interval '10 minutes', 1),
  -- j3671/j3672: s3606 v1 index + publish jobs (B3 3-of-10 partial embedding refusal)
  ('96000000-0000-4000-8000-000000003671', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003661', 'index', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-idx-s6v1-b301', now() + interval '10 minutes', 1),
  ('96000000-0000-4000-8000-000000003672', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003661', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s6v1-b302', now() + interval '10 minutes', 1),
  -- j3681..j3686: s3607 v1/v2/v3 jobs (B1 older-after-newer & failed-target publish checks)
  ('96000000-0000-4000-8000-000000003681', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003671', 'index', 'cloud_worker', 'succeeded', 'public',
   'v1', 1, 1, null, null, 1),
  ('96000000-0000-4000-8000-000000003682', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003671', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s7v1-b101', now() + interval '10 minutes', 1),
  ('96000000-0000-4000-8000-000000003683', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003672', 'index', 'cloud_worker', 'succeeded', 'public',
   'v1', 1, 1, null, null, 1),
  ('96000000-0000-4000-8000-000000003684', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003672', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s7v2-b102', now() + interval '10 minutes', 1),
  ('96000000-0000-4000-8000-000000003685', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003673', 'index', 'cloud_worker', 'succeeded', 'public',
   'v1', 1, 1, null, null, 1),
  ('96000000-0000-4000-8000-000000003686', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000003673', 'publish', 'cloud_worker', 'leased', 'public',
   'v1', 1, 1, 't113-lease-pub-s7v3-b103', now() + interval '10 minutes', 1);

-- Scratch tables for collecting results while running under `toi_job_api`, `authenticated`, or `anon`.
create temp table t_out (case_name text, result text);
create temp table t_write (case_name text, outcome text, chunk_count int, vector_count int, event_id uuid);
create temp table t_pub (
  case_name text, outcome text, source_id uuid, source_version_id uuid,
  previous_version_id uuid, published_at timestamptz, event_id uuid
);
create temp table t_abort (case_name text, outcome text, status text);
create temp table t_search (case_name text, result_status text, chunk_id uuid, source_version_id uuid);

grant insert, select on t_out, t_write, t_pub, t_abort to toi_job_api;
grant insert, select on t_out to authenticated, anon;
grant insert, select on t_search to authenticated;
-- Migration role `postgres` is not a superuser in Supabase (001 test 36), so PG16+ requires
-- explicit membership inside this rolled-back transaction before `set local role toi_job_api`.
grant toi_job_api to postgres;

-- ================================================================ 1-14 privilege & surface pins
select ok(
  has_function_privilege(
    'toi_job_api',
    'job_api.write_chunks_v1(text,uuid,text,bigint,uuid,integer,uuid,jsonb)',
    'execute'
  ),
  '1 toi_job_api holds EXECUTE on job_api.write_chunks_v1 (#134, #136)'
);
select ok(
  has_function_privilege(
    'toi_job_api',
    'job_api.publish_version_v1(text,uuid,text,bigint,uuid,integer)',
    'execute'
  ),
  '2 toi_job_api holds EXECUTE on job_api.publish_version_v1 (#134, #136)'
);
select is(
  has_function_privilege(
    'anon',
    'job_api.write_chunks_v1(text,uuid,text,bigint,uuid,integer,uuid,jsonb)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'job_api.write_chunks_v1(text,uuid,text,bigint,uuid,integer,uuid,jsonb)',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'job_api.write_chunks_v1(text,uuid,text,bigint,uuid,integer,uuid,jsonb)',
    'execute'
  ),
  false,
  '3 anon, authenticated and service_role cannot execute job_api.write_chunks_v1 (#142)'
);
select is(
  has_function_privilege(
    'anon',
    'job_api.publish_version_v1(text,uuid,text,bigint,uuid,integer)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'job_api.publish_version_v1(text,uuid,text,bigint,uuid,integer)',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'job_api.publish_version_v1(text,uuid,text,bigint,uuid,integer)',
    'execute'
  ),
  false,
  '4 anon, authenticated and service_role cannot execute job_api.publish_version_v1 (#142)'
);
select is_empty(
  $$ select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('write_chunks_v1', 'publish_version_v1') $$,
  '5 neither write_chunks_v1 nor publish_version_v1 exists in public (#136, #142)'
);
select is_empty(
  $$ select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'job_api'
        and p.proname in ('write_chunks_v1', 'publish_version_v1')
        and (not p.prosecdef
             or not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                             where c like 'search_path=%')) $$,
  '6 both new job_api functions are SECURITY DEFINER with a pinned search_path'
);
select is(
  has_table_privilege('toi_job_api', 'public.knowledge_chunks', 'select, insert, update, delete')
  or has_table_privilege('toi_job_api', 'public.chunk_embeddings', 'select, insert, update, delete')
  or has_table_privilege('toi_job_api', 'public.source_versions', 'select, insert, update, delete')
  or has_table_privilege('toi_job_api', 'public.knowledge_sources', 'select, insert, update, delete')
  or has_table_privilege('toi_job_api', 'public.outbox_events', 'select, insert, update, delete'),
  false,
  '7 toi_job_api holds no table privileges on knowledge or outbox tables (#134)'
);
select ok(
  'embedding_route_unavailable' = any (job_api.abort_reasons()),
  '8 closed abort vocabulary includes embedding_route_unavailable (#99, #136)'
);
select is(
  has_function_privilege('anon', 'job_api.abort_reasons()', 'execute')
  or has_function_privilege('authenticated', 'job_api.abort_reasons()', 'execute')
  or has_function_privilege('service_role', 'job_api.abort_reasons()', 'execute'),
  false,
  '9 job_api.abort_reasons() stays revoked from anon, authenticated and service_role'
);

set local role authenticated;
insert into t_out values
  ('auth_write', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"probe"}]'::jsonb)),
  ('auth_pub', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1));
reset role;

set local role anon;
insert into t_out values
  ('anon_write', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"probe"}]'::jsonb)),
  ('anon_pub', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1));
reset role;

set local role toi_job_api;
insert into t_out values
  ('worker_sel_chunks', pg_temp.try_select_table_as_worker('knowledge_chunks')),
  ('worker_sel_embeds', pg_temp.try_select_table_as_worker('chunk_embeddings')),
  ('worker_sel_creds', pg_temp.try_select_table_as_worker('worker_credentials'));
reset role;

select is((select result from t_out where case_name = 'auth_write'), '42501',
  '10 authenticated role is refused write_chunks_v1 at runtime');
select is((select result from t_out where case_name = 'auth_pub'), '42501',
  '11 authenticated role is refused publish_version_v1 at runtime');
select is((select result from t_out where case_name = 'anon_write')
          || '/' || (select result from t_out where case_name = 'anon_pub'), '42501/42501',
  '12 anon role is refused both RPCs at runtime');
select is((select result from t_out where case_name = 'worker_sel_chunks')
          || '/' || (select result from t_out where case_name = 'worker_sel_embeds'), '42501/42501',
  '13 toi_job_api cannot select knowledge_chunks or chunk_embeddings directly at runtime');
select is((select result from t_out where case_name = 'worker_sel_creds'), '42501',
  '14 toi_job_api cannot read job_api.worker_credentials at runtime');

-- ================================================================ 15-18 schema FK & guard checks
select is(
  pg_temp.try_direct_chunk_insert(
    '22222222-2222-4222-8222-222222222222',
    '71000000-0000-4000-8000-000000003612',
    0, 'public'
  ),
  '23503',
  '15 cross-tenant chunk insert naming another tenant''s version is rejected by composite FK (23503)'
);
select is(
  pg_temp.try_direct_chunk_insert(
    '11111111-1111-4111-8111-111111111111',
    '71000000-0000-4000-8000-000000003631',
    0, 'internal'
  ),
  '23514',
  '16 chunk data_class below its client_confidential version is rejected by guard trigger (23514)'
);
select is(
  pg_temp.try_direct_embedding_insert(
    '11111111-1111-4111-8111-111111111111',
    '81000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000003601',
    1, pg_temp.spike_vec(1)
  ),
  '23514',
  '17 vector insert for client_confidential chunk into public-only index is rejected (23514, #13(4))'
);
select is(
  pg_temp.try_direct_embedding_insert(
    '11111111-1111-4111-8111-111111111111',
    '81000000-0000-4000-8000-000000003611',
    '91000000-0000-4000-8000-000000000001',
    1, pg_temp.spike_vec(1, 4)
  ),
  '23514',
  '18 vector insert with mismatched dimensions (4 vs 1024) is rejected (23514, TOI-ADR-13)'
);

-- ================================================================ 19-34 write_chunks_v1 behavior
-- First test negative/boundary refusals as toi_job_api before completing j3611.
set local role toi_job_api;
insert into t_out values
  ('w_bad_hash', pg_temp.try_write_chunks(
    'not-a-sha256', '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"probe"}]'::jsonb)),
  ('w_empty', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[]'::jsonb)),
  ('w_dup_idx', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    null, '[{"chunk_index":0,"body_text":"a"},{"chunk_index":0,"body_text":"b"}]'::jsonb)),
  ('w_vec_no_idx', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    null, jsonb_build_array(jsonb_build_object(
      'chunk_index', 0, 'body_text', 'vec without index', 'embedding', pg_temp.spike_json(1))))),
  ('w_foreign_cred', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c2'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"foreign"}]'::jsonb)),
  ('w_revoked_cred', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-revoked'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"revoked"}]'::jsonb)),
  ('w_box_cred', pg_temp.try_write_chunks(
    pg_temp.syn_hash('box-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"box"}]'::jsonb)),
  ('w_wrong_ver', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003611', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"wrong ver"}]'::jsonb)),
  ('w_null_ver', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, null, 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"null ver"}]'::jsonb)),
  ('w_wrong_gen', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 9,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"wrong gen"}]'::jsonb)),
  ('w_wrong_stage', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"publish job"}]'::jsonb)),
  ('w_foreign_idx', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '92000000-0000-4000-8000-000000000001', jsonb_build_array(jsonb_build_object(
      'chunk_index', 0, 'body_text', 'foreign idx', 'embedding', pg_temp.spike_json(1))))),
  ('w_stale_fence', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 1, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"stale fence"}]'::jsonb)),
  ('w_wrong_token', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    'wrong-token-000000000000', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"wrong tok"}]'::jsonb)),
  ('w_expired', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003651',
    't113-lease-expired-iiii', 1, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"expired"}]'::jsonb)),
  ('w_revoked_ver', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003641',
    't113-lease-index-s4v1-gggg', 1, '71000000-0000-4000-8000-000000003641', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"revoked ver"}]'::jsonb));
reset role;

select is((select result from t_out where case_name = 'w_bad_hash')
          || '/' || (select result from t_out where case_name = 'w_empty')
          || '/' || (select result from t_out where case_name = 'w_dup_idx')
          || '/' || (select result from t_out where case_name = 'w_vec_no_idx'),
  '22023/22023/22023/22023',
  '19 write_chunks_v1 rejects malformed digest, empty chunks, duplicate chunk_index, and vector without index (22023)');
select is((select result from t_out where case_name = 'w_foreign_cred')
          || '/' || (select result from t_out where case_name = 'w_revoked_cred')
          || '/' || (select result from t_out where case_name = 'w_box_cred'),
  '42501/42501/42501',
  '20 write_chunks_v1 refuses foreign tenant, revoked, and local_box credentials (42501)');
select is((select result from t_out where case_name = 'w_wrong_ver')
          || '/' || (select result from t_out where case_name = 'w_null_ver')
          || '/' || (select result from t_out where case_name = 'w_wrong_gen')
          || '/' || (select result from t_out where case_name = 'w_wrong_stage'),
  '42501/42501/42501/42501',
  '21 write_chunks_v1 re-checks version (including NULL), index_generation, and index stage (42501)');
select is((select result from t_out where case_name = 'w_foreign_idx')
          || '/' || (select result from t_out where case_name = 'w_stale_fence')
          || '/' || (select result from t_out where case_name = 'w_wrong_token')
          || '/' || (select result from t_out where case_name = 'w_expired')
          || '/' || (select result from t_out where case_name = 'w_revoked_ver'),
  '42501/42501/42501/42501/42501',
  '22 write_chunks_v1 refuses foreign index, stale fence, wrong token, expired lease, and revoked version (42501)');

-- Guard rollback atomicity on s3603 (client_confidential): batch with valid chunk 0 + invalid chunk 1.
set local role toi_job_api;
insert into t_out values
  ('w_lower_class', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003631',
    't113-lease-index-s3v1-ffff', 3, '71000000-0000-4000-8000-000000003631', 1,
    '91000000-0000-4000-8000-000000000001',
    '[{"chunk_index":0,"body_text":"valid cc chunk"},
      {"chunk_index":1,"body_text":"lowered chunk","data_class":"internal"}]'::jsonb)),
  ('w_restricted', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003631',
    't113-lease-index-s3v1-ffff', 3, '71000000-0000-4000-8000-000000003631', 1,
    '91000000-0000-4000-8000-000000000001',
    '[{"chunk_index":0,"body_text":"restricted chunk","data_class":"restricted"}]'::jsonb)),
  ('w_uncleared_idx', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003631',
    't113-lease-index-s3v1-ffff', 3, '71000000-0000-4000-8000-000000003631', 1,
    '91000000-0000-4000-8000-000000003601',
    jsonb_build_array(
      jsonb_build_object('chunk_index', 0, 'body_text', 'cc chunk into public-only index',
                         'embedding', pg_temp.spike_json(1))))),
  ('w_bad_dims', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003631',
    't113-lease-index-s3v1-ffff', 3, '71000000-0000-4000-8000-000000003631', 1,
    '91000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object('chunk_index', 0, 'body_text', 'valid vector',
                         'embedding', pg_temp.spike_json(1)),
      jsonb_build_object('chunk_index', 1, 'body_text', 'wrong dims',
                         'embedding', pg_temp.spike_json(2, 4)))));
reset role;

select is((select result from t_out where case_name = 'w_lower_class')
          || '/' || (select result from t_out where case_name = 'w_restricted')
          || '/' || (select result from t_out where case_name = 'w_uncleared_idx')
          || '/' || (select result from t_out where case_name = 'w_bad_dims'),
  '23514/23514/23514/23514',
  '23 write_chunks_v1 rejects lowered class, restricted class, uncleared index, and wrong dimensions (23514)');
select is((select count(*)::text from public.knowledge_chunks
            where source_version_id = '71000000-0000-4000-8000-000000003631')
          || '/' || (select status from public.ingestion_jobs
                      where id = '96000000-0000-4000-8000-000000003631'),
  '0/leased',
  '24 failed chunk/vector batch rolls back atomically: zero partial chunks and job remains leased');

-- Lexical-only write on s3603 succeeds with 0 vectors and preserves client_confidential class.
set local role toi_job_api;
insert into t_write
  select 'lex_only', o_outcome, o_chunk_count, o_vector_count, o_event_id
    from job_api.write_chunks_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003631',
      't113-lease-index-s3v1-ffff', 3, '71000000-0000-4000-8000-000000003631', 1,
      null,
      '[{"chunk_index":0,"body_text":"Synthetic confidential lexical-only chunk.",
         "locator":{"page":1,"section":"Restricted lane"}}]'::jsonb
    );
reset role;

select is((select outcome || '/' || chunk_count::text || '/' || vector_count::text
             from t_write where case_name = 'lex_only'),
  'completed/1/0',
  '25 lexical-only write_chunks_v1 succeeds with 1 chunk and 0 vectors');
select is((select data_class from public.knowledge_chunks
            where source_version_id = '71000000-0000-4000-8000-000000003631' and chunk_index = 0),
  'client_confidential',
  '26 chunk inherits client_confidential class from its version when omitted');

-- Happy-path hybrid write on s3601 v2 as toi_job_api with deterministic chunk_ids + vectors.
set local role toi_job_api;
insert into t_write
  select 'happy_write', o_outcome, o_chunk_count, o_vector_count, o_event_id
    from job_api.write_chunks_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
      't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
      '91000000-0000-4000-8000-000000000001',
      jsonb_build_array(
        jsonb_build_object(
          'chunk_id', '81000000-0000-4000-8000-000000003621',
          'chunk_index', 0,
          'locator', jsonb_build_object('page', 1, 'section', 'Battery check'),
          'body_text', 'Synthetic updated SOP v2: token-t113-new-v2-alpha battery inspection.',
          'token_count', 12,
          'embedding', pg_temp.spike_json(11)
        ),
        jsonb_build_object(
          'chunk_id', '81000000-0000-4000-8000-000000003622',
          'chunk_index', 1,
          'locator', jsonb_build_object('page', 2, 'table', 'limits'),
          'body_text', 'Synthetic updated SOP v2: wind threshold table continuation.',
          'token_count', 9,
          'embedding', pg_temp.spike_json(12)
        )
      )
    );
reset role;

select is((select outcome || '/' || chunk_count::text || '/' || vector_count::text
             from t_write where case_name = 'happy_write'),
  'completed/2/2',
  '27 toi_job_api writes 2 chunks and 2 vectors for the leased index job');
select ok((select event_id is not null from t_write where case_name = 'happy_write'),
  '28 write_chunks_v1 emits an outbox event id on completion');
select is((select count(*)::text from public.knowledge_chunks
            where organisation_id = '11111111-1111-4111-8111-111111111111'
              and source_version_id = '71000000-0000-4000-8000-000000003612'),
  '2',
  '29 chunks landed under the job row''s tenant and version');
select is((select count(*)::text from public.chunk_embeddings ce
            join public.knowledge_chunks kc on kc.id = ce.chunk_id
           where kc.source_version_id = '71000000-0000-4000-8000-000000003612'
             and ce.index_id = '91000000-0000-4000-8000-000000000001'
             and ce.index_generation = 1),
  '2',
  '30 vectors landed against the pinned index and job''s index_generation');
select is((select status || '/' || (lease_token is null)::text || '/' || (completed_at is not null)::text
             from public.ingestion_jobs where id = '96000000-0000-4000-8000-000000003611'),
  'succeeded/true/true',
  '31 index job transitioned to succeeded with lease pair cleared');
select is((select state from public.source_versions where id = '71000000-0000-4000-8000-000000003612')
          || '/' || (select current_version_id::text from public.knowledge_sources
                      where id = '61000000-0000-4000-8000-000000003601'),
  'indexing/71000000-0000-4000-8000-000000003611',
  '32 write_chunks_v1 advances version to indexing without moving current_version_id (v1 still active)');

-- Duplicate delivery of the completed index job (winning fence -> already_completed; stale fence / foreign cred -> 42501).
set local role toi_job_api;
insert into t_write
  select 'replay_write', o_outcome, o_chunk_count, o_vector_count, o_event_id
    from job_api.write_chunks_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
      't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
      '91000000-0000-4000-8000-000000000001',
      '[{"chunk_index":0,"body_text":"duplicate delivery"}]'::jsonb
    );
insert into t_out values
  ('w_replay_stale', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 1, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"stale replay"}]'::jsonb)),
  ('w_replay_foreign', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c2'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1,
    '91000000-0000-4000-8000-000000000001', '[{"chunk_index":0,"body_text":"foreign replay"}]'::jsonb));
reset role;

select is((select outcome || '/' || chunk_count::text || '/' || vector_count::text
             || '/' || (event_id is null)::text from t_write where case_name = 'replay_write'),
  'already_completed/2/2/true',
  '33 duplicate delivery of succeeded index job with winning fence is a no-op (already_completed, no event)');
select is((select count(*)::text from public.outbox_events
            where aggregate_type = 'ingestion_job'
              and aggregate_id = '96000000-0000-4000-8000-000000003611')
          || '/' || (select result from t_out where case_name = 'w_replay_stale')
          || '/' || (select result from t_out where case_name = 'w_replay_foreign'),
  '1/42501/42501',
  '34 still 1 outbox event; stale fence and foreign credential on succeeded job still get 42501');

-- ================================================================ 35-42 embedding route down -> no publication
-- First prove interrupted embed (index job still leased) cannot be published.
set local role toi_job_api;
insert into t_out values
  ('pub_while_indexing', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003622',
    't113-lease-pub-s2v2-eeee', 1, '71000000-0000-4000-8000-000000003622', 1));
insert into t_abort
  select 'abort_embed_down', o_outcome, o_status
    from job_api.abort_parse_job_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003621',
      't113-lease-index-s2v2-dddd', 1, 'embedding_route_unavailable'
    );
insert into t_out values
  ('pub_after_abort', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003622',
    't113-lease-pub-s2v2-eeee', 1, '71000000-0000-4000-8000-000000003622', 1));
reset role;

select is((select result from t_out where case_name = 'pub_while_indexing'), '55000',
  '35 publish_version_v1 refuses while index stage is still in flight (interrupted embed, 55000)');
select is((select outcome || '/' || status from t_abort where case_name = 'abort_embed_down'),
  'aborted/cancelled',
  '36 cloud worker aborts index job with closed reason embedding_route_unavailable (#99, #136)');
select is((select last_error from public.ingestion_jobs where id = '96000000-0000-4000-8000-000000003621'),
  'embedding_route_unavailable',
  '37 aborted index job records the closed reason in last_error');
select is((select result from t_out where case_name = 'pub_after_abort'), '55000',
  '38 publish_version_v1 refuses after index job was aborted (55000: no partial publication)');
select is((select state || '/' || (published_at is null)::text
             from public.source_versions where id = '71000000-0000-4000-8000-000000003622'),
  'indexing/true',
  '39 version waits visibly in indexing with null published_at when embedding route is down');
select is((select current_version_id::text from public.knowledge_sources
            where id = '61000000-0000-4000-8000-000000003602'),
  '71000000-0000-4000-8000-000000003621',
  '40 source pointer stays on previous published version v1');
select is((select state from public.source_versions where id = '71000000-0000-4000-8000-000000003621'),
  'published',
  '41 previous published version stays published and unaffected');
select is((select count(*)::text from public.outbox_events
            where aggregate_type = 'source_version'
              and aggregate_id = '71000000-0000-4000-8000-000000003622'
              and event_type = 'knowledge.source_version.published'),
  '0',
  '42 zero publication outbox events emitted for the un-indexed version');

-- ================================================================ 43-62 publish_version_v1 atomic switch,
-- ================================================================ idempotency, negatives, and search visibility
set local role toi_job_api;
insert into t_out values
  ('p_bad_hash', pg_temp.try_publish_version(
    'bad-hash', '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_foreign_cred', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c2'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_revoked_cred', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-revoked'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_box_cred', pg_temp.try_publish_version(
    pg_temp.syn_hash('box-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_wrong_stage', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003611',
    't113-lease-index-s1v2-aaaa', 2, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_wrong_ver', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003611', 1)),
  ('p_null_ver', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, null, 1)),
  ('p_wrong_gen', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 4)),
  ('p_stale_fence', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 1, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_wrong_token', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    'wrong-pub-token-00000000', 2, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_expired', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003652',
    't113-lease-pub-exp-jjjj', 1, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_revoked_ver', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003642',
    't113-lease-pub-s4v1-hhhh', 1, '71000000-0000-4000-8000-000000003641', 1));
reset role;

select is((select result from t_out where case_name = 'p_bad_hash'), '22023',
  '43 publish_version_v1 rejects malformed digest (22023)');
select is((select result from t_out where case_name = 'p_foreign_cred')
          || '/' || (select result from t_out where case_name = 'p_revoked_cred')
          || '/' || (select result from t_out where case_name = 'p_box_cred'),
  '42501/42501/42501',
  '44 publish_version_v1 refuses foreign tenant, revoked, and local_box credentials (42501)');
select is((select result from t_out where case_name = 'p_wrong_stage')
          || '/' || (select result from t_out where case_name = 'p_wrong_ver')
          || '/' || (select result from t_out where case_name = 'p_null_ver')
          || '/' || (select result from t_out where case_name = 'p_wrong_gen'),
  '42501/42501/42501/42501',
  '45 publish_version_v1 re-checks stage, version (including NULL), and index_generation (42501)');
select is((select result from t_out where case_name = 'p_stale_fence')
          || '/' || (select result from t_out where case_name = 'p_wrong_token')
          || '/' || (select result from t_out where case_name = 'p_expired')
          || '/' || (select result from t_out where case_name = 'p_revoked_ver'),
  '42501/42501/42501/42501',
  '46 publish_version_v1 refuses stale fence, wrong token, expired lease, and revoked version (42501)');

-- Happy-path atomic publish of s3601 v2 (switching pointer from v1 -> v2 in one statement).
set local role toi_job_api;
insert into t_pub
  select 'pub_ok', o_outcome, o_source_id, o_source_version_id,
         o_previous_version_id, o_published_at, o_event_id
    from job_api.publish_version_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
      't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1
    );
reset role;

select is((select outcome from t_pub where case_name = 'pub_ok'), 'published',
  '47 publish_version_v1 publishes the indexed version');
select is((select source_id::text || '/' || source_version_id::text || '/' || previous_version_id::text
             from t_pub where case_name = 'pub_ok'),
  '61000000-0000-4000-8000-000000003601/71000000-0000-4000-8000-000000003612/71000000-0000-4000-8000-000000003611',
  '48 publish_version_v1 reports source, new active version, and superseded prior version');
select ok((select published_at is not null and event_id is not null from t_pub where case_name = 'pub_ok'),
  '49 publish_version_v1 sets published_at and emits an outbox event');
select is((select current_version_id::text from public.knowledge_sources
            where id = '61000000-0000-4000-8000-000000003601'),
  '71000000-0000-4000-8000-000000003612',
  '50 knowledge_sources.current_version_id switched atomically to v2');
select is((select state || '/' || (published_at is not null)::text
             from public.source_versions where id = '71000000-0000-4000-8000-000000003612'),
  'published/true',
  '51 v2 is now published with published_at populated');
select is((select state from public.source_versions where id = '71000000-0000-4000-8000-000000003611'),
  'superseded',
  '52 prior version v1 transitioned to superseded in the same statement');
select is((select status || '/' || (lease_token is null)::text || '/' || (completed_at is not null)::text
             from public.ingestion_jobs where id = '96000000-0000-4000-8000-000000003612'),
  'succeeded/true/true',
  '53 publish job transitioned to succeeded with lease pair cleared');
select is((select count(*)::text from public.outbox_events
            where aggregate_type = 'source_version'
              and aggregate_id = '71000000-0000-4000-8000-000000003612'
              and event_type = 'knowledge.source_version.published'),
  '1',
  '54 exactly one knowledge.source_version.published outbox event was written');

-- Idempotent re-run of the same publish job (winning fence -> already_published; stale/foreign -> 42501),
-- plus a second publish job targeting already-active v2 (converges without self-superseding).
set local role toi_job_api;
insert into t_pub
  select 'pub_replay', o_outcome, o_source_id, o_source_version_id,
         o_previous_version_id, o_published_at, o_event_id
    from job_api.publish_version_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
      't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1
    );
insert into t_out values
  ('p_replay_stale', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 1, '71000000-0000-4000-8000-000000003612', 1)),
  ('p_replay_foreign', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c2'), '96000000-0000-4000-8000-000000003612',
    't113-lease-pub-s1v2-bbbb', 2, '71000000-0000-4000-8000-000000003612', 1));
insert into t_pub
  select 'pub_second_job', o_outcome, o_source_id, o_source_version_id,
         o_previous_version_id, o_published_at, o_event_id
    from job_api.publish_version_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003613',
      't113-lease-pub-s1v2-cccc', 1, '71000000-0000-4000-8000-000000003612', 1
    );
reset role;

select is((select outcome || '/' || (event_id is null)::text from t_pub where case_name = 'pub_replay'),
  'already_published/true',
  '55 re-run of the same publish stage is a no-op (already_published, no second outbox event)');
select is((select published_at from t_pub where case_name = 'pub_replay'),
  (select published_at from t_pub where case_name = 'pub_ok'),
  '56 re-run preserves original published_at timestamp');
select is((select result from t_out where case_name = 'p_replay_stale')
          || '/' || (select result from t_out where case_name = 'p_replay_foreign'),
  '42501/42501',
  '57 stale fence and foreign credential on already-published job still receive 42501');
select is((select outcome || '/' || (event_id is null)::text from t_pub where case_name = 'pub_second_job'),
  'already_published/true',
  '58 a second publish job for an already-active version converges as already_published with no extra event');
select is((select state from public.source_versions where id = '71000000-0000-4000-8000-000000003612')
          || '/' || (select count(*)::text from public.outbox_events
                      where aggregate_type = 'source_version'
                        and aggregate_id = '71000000-0000-4000-8000-000000003612'
                        and event_type = 'knowledge.source_version.published'),
  'published/1',
  '59 already-active version never self-supersedes and still has exactly one published outbox event');

-- End-to-end search_corpus_v1 verification: Company1 sees v2 (and no longer v1); Company2 sees neither.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_search
  select 'c1_new', o_result_status, o_chunk_id, o_source_version_id
    from public.search_corpus_v1(
      '11111111-1111-4111-8111-111111111111', '{}'::text[], null, null,
      'token-t113-new-v2-alpha', pg_temp.spike_vec(11)::extensions.vector,
      '91000000-0000-4000-8000-000000000001', null, null, 5
    )
   where o_evidence_kind = 'chunk' and o_chunk_id = '81000000-0000-4000-8000-000000003621';
insert into t_search
  select 'c1_old', o_result_status, o_chunk_id, o_source_version_id
    from public.search_corpus_v1(
      '11111111-1111-4111-8111-111111111111', '{}'::text[], null, null,
      'token-t113-old-v1-only', null, null, null, null, 5
    );
do $$ begin perform public.clear_tenant_scope(); end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_search
  select 'c2_new', o_result_status, o_chunk_id, o_source_version_id
    from public.search_corpus_v1(
      '22222222-2222-4222-8222-222222222222', '{}'::text[], null, null,
      'token-t113-new-v2-alpha', null, null, null, null, 5
    );
do $$ begin perform public.clear_tenant_scope(); end $$;
reset role;

select is((select result_status || '/' || source_version_id::text
             from t_search where case_name = 'c1_new'),
  'ok/71000000-0000-4000-8000-000000003612',
  '60 Company1 member retrieves the newly published v2 chunk through hybrid search_corpus_v1');
select is((select result_status from t_search where case_name = 'c1_old'),
  'no_accessible_evidence',
  '61 superseded v1 chunk is no longer returned by search_corpus_v1');
select is((select result_status from t_search where case_name = 'c2_new'),
  'no_accessible_evidence',
  '62 Company2 member never retrieves Company1''s newly published chunk');

-- ================================================================ 63-67 Round-1 B2: ON CONFLICT
-- ================================================================ body_text & raised-class checks
-- Failure mode 1: conflicting chunk_index with different body_text (re-parse under parser='v2').
set local role toi_job_api;
insert into t_out values
  ('b2_diff_text', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003661',
    't113-lease-idx-s5v1-b201', 1, '71000000-0000-4000-8000-000000003651', 1,
    '91000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object(
        'chunk_index', 0,
        'body_text', 'Synthetic B2 re-parsed DIFFERENT text.',
        'embedding', pg_temp.spike_json(5)
      )
    )
  ));
reset role;

select is((select result from t_out where case_name = 'b2_diff_text'), '23514',
  '63 write_chunks_v1 refuses conflicting chunk_index with different body_text (23514, B2)');
select is((select count(*)::text from public.chunk_embeddings
            where chunk_id = '81000000-0000-4000-8000-000000003651')
          || '/' || (select status from public.ingestion_jobs
                      where id = '96000000-0000-4000-8000-000000003661'),
  '0/leased',
  '64 rejected body_text conflict rolls back atomically: 0 vectors attached and job remains leased');

-- Failure mode 2: reviewer raises version class to client_confidential while stored chunk stays public.
update public.source_versions
   set data_class = 'client_confidential'
 where id = '71000000-0000-4000-8000-000000003651';

set local role toi_job_api;
insert into t_out values
  ('b2_lower_stored_class', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003661',
    't113-lease-idx-s5v1-b201', 1, '71000000-0000-4000-8000-000000003651', 1,
    '91000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object(
        'chunk_index', 0,
        'body_text', 'Synthetic B2 original chunk text.',
        'embedding', pg_temp.spike_json(5)
      )
    )
  ));
reset role;

select is((select result from t_out where case_name = 'b2_lower_stored_class'), '23514',
  '65 write_chunks_v1 refuses conflicting chunk whose stored class is below raised version class (23514, B2)');
select is((select count(*)::text from public.chunk_embeddings
            where chunk_id = '81000000-0000-4000-8000-000000003651')
          || '/' || (select status from public.ingestion_jobs
                      where id = '96000000-0000-4000-8000-000000003661'),
  '0/leased',
  '66 rejected class conflict rolls back atomically: 0 vectors attached and job remains leased');

-- Once stored chunk is raised to match effective class and body_text is identical, re-index succeeds.
update public.knowledge_chunks
   set data_class = 'client_confidential'
 where id = '81000000-0000-4000-8000-000000003651';

set local role toi_job_api;
insert into t_write
  select 'b2_identical_ok', o_outcome, o_chunk_count, o_vector_count, o_event_id
    from job_api.write_chunks_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003661',
      't113-lease-idx-s5v1-b201', 1, '71000000-0000-4000-8000-000000003651', 1,
      '91000000-0000-4000-8000-000000000001',
      jsonb_build_array(
        jsonb_build_object(
          'chunk_index', 0,
          'body_text', 'Synthetic B2 original chunk text.',
          'embedding', pg_temp.spike_json(5)
        )
      )
    );
reset role;

select is((select outcome || '/' || chunk_count::text || '/' || vector_count::text
             from t_write where case_name = 'b2_identical_ok'),
  'completed/0/1',
  '67 identical body_text with stored class >= effective class succeeds on conflict (shadow re-index)');

-- ================================================================ 68-72 Round-1 B3: half-embedded
-- ================================================================ 3-of-10 refusal & public-only lexical pass
set local role toi_job_api;
insert into t_out values
  ('b3_partial_3of10', pg_temp.try_write_chunks(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003671',
    't113-lease-idx-s6v1-b301', 1, '71000000-0000-4000-8000-000000003661', 1,
    '91000000-0000-4000-8000-000000000001',
    (
      select jsonb_agg(
        case
          when n < 3 then jsonb_build_object(
            'chunk_index', n,
            'body_text', 'Synthetic B3 chunk ' || n::text,
            'embedding', pg_temp.spike_json(n + 1)
          )
          else jsonb_build_object(
            'chunk_index', n,
            'body_text', 'Synthetic B3 chunk ' || n::text
          )
        end
        order by n
      )
      from generate_series(0, 9) n
    )
  )),
  ('b3_pub_after_rollback', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003672',
    't113-lease-pub-s6v1-b302', 1, '71000000-0000-4000-8000-000000003661', 1
  ));
insert into t_write
  select 'b3_pubonly_lexical', o_outcome, o_chunk_count, o_vector_count, o_event_id
    from job_api.write_chunks_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003632',
      't113-lease-idx-s3v2-pubo', 1, '71000000-0000-4000-8000-000000003632', 1,
      '91000000-0000-4000-8000-000000003601',
      '[{"chunk_index":0,"body_text":"Synthetic B3 confidential lexical chunk 0."},
        {"chunk_index":1,"body_text":"Synthetic B3 confidential lexical chunk 1."}]'::jsonb
    );
reset role;

select is((select result from t_out where case_name = 'b3_partial_3of10'), '23514',
  '68 write_chunks_v1 refuses 3-of-10 partial embedding when index clears the chunks (23514, B3)');
select is((select count(*)::text from public.knowledge_chunks
            where source_version_id = '71000000-0000-4000-8000-000000003661')
          || '/' || (select count(*)::text from public.chunk_embeddings ce
                      join public.knowledge_chunks kc on kc.id = ce.chunk_id
                     where kc.source_version_id = '71000000-0000-4000-8000-000000003661')
          || '/' || (select status from public.ingestion_jobs
                      where id = '96000000-0000-4000-8000-000000003671'),
  '0/0/leased',
  '69 rejected 3-of-10 batch rolls back atomically: 0 chunks, 0 vectors, job remains leased');
select is((select result from t_out where case_name = 'b3_pub_after_rollback')
          || '/' || (select (current_version_id is null)::text from public.knowledge_sources
                      where id = '61000000-0000-4000-8000-000000003606'),
  '55000/true',
  '70 publish_version_v1 refuses after rolled-back partial write (55000, pointer stays null)');
select is((select outcome || '/' || chunk_count::text || '/' || vector_count::text
             from t_write where case_name = 'b3_pubonly_lexical'),
  'completed/2/0',
  '71 public-only index with client_confidential chunks stays lexical-only and succeeds (B3)');

-- Defense-in-depth: even if 10 chunks with only 3 vectors + succeeded index job exist in DB,
-- publish_version_v1 still refuses 55000 and leaves the source pointer null.
insert into public.knowledge_chunks (
  organisation_id, source_version_id, chunk_index, locator, body_text, data_class
)
select '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000003661',
       n, jsonb_build_object('page', 1), 'Synthetic B3 db-partial chunk ' || n::text, 'public'
  from generate_series(0, 9) n;

insert into public.chunk_embeddings (
  organisation_id, chunk_id, index_id, index_generation, embedding
)
select kc.organisation_id, kc.id, '91000000-0000-4000-8000-000000000001', 1,
       pg_temp.spike_vec(kc.chunk_index + 1)::extensions.vector
  from public.knowledge_chunks kc
 where kc.source_version_id = '71000000-0000-4000-8000-000000003661'
   and kc.chunk_index < 3;

update public.ingestion_jobs
   set status = 'succeeded', lease_token = null, lease_expires_at = null, completed_at = now()
 where id = '96000000-0000-4000-8000-000000003671';

set local role toi_job_api;
insert into t_out values
  ('b3_pub_half_db', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003672',
    't113-lease-pub-s6v1-b302', 1, '71000000-0000-4000-8000-000000003661', 1
  ));
reset role;

select is((select result from t_out where case_name = 'b3_pub_half_db')
          || '/' || (select (current_version_id is null)::text from public.knowledge_sources
                      where id = '61000000-0000-4000-8000-000000003606'),
  '55000/true',
  '72 publish_version_v1 refuses half-embedded version in DB (55000, pointer stays null)');

-- ================================================================ 73-78 Round-1 B1: older-after-newer,
-- ================================================================ superseded target, and failed target
set local role toi_job_api;
insert into t_pub
  select 'b1_pub_v2_first', o_outcome, o_source_id, o_source_version_id,
         o_previous_version_id, o_published_at, o_event_id
    from job_api.publish_version_v1(
      pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003684',
      't113-lease-pub-s7v2-b102', 1, '71000000-0000-4000-8000-000000003672', 1
    );
insert into t_out values
  ('b1_older_after_newer', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003682',
    't113-lease-pub-s7v1-b101', 1, '71000000-0000-4000-8000-000000003671', 1
  )),
  ('b1_superseded_target', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003616',
    't113-lease-pub-s1v1-sup1', 1, '71000000-0000-4000-8000-000000003611', 1
  )),
  ('b1_failed_target', pg_temp.try_publish_version(
    pg_temp.syn_hash('cloud-c1'), '96000000-0000-4000-8000-000000003686',
    't113-lease-pub-s7v3-b103', 1, '71000000-0000-4000-8000-000000003673', 1
  ));
reset role;

select is((select outcome || '/' || source_version_id::text from t_pub where case_name = 'b1_pub_v2_first'),
  'published/71000000-0000-4000-8000-000000003672',
  '73 newer version v2 publishes first on s3607 while v1 is still in indexing');
select is((select result from t_out where case_name = 'b1_older_after_newer'), '55000',
  '74 publish_version_v1 refuses older v1 after newer v2 is already active (55000, B1)');
select is((select current_version_id::text from public.knowledge_sources
            where id = '61000000-0000-4000-8000-000000003607')
          || '/' || (select state from public.source_versions
                      where id = '71000000-0000-4000-8000-000000003672')
          || '/' || (select state from public.source_versions
                      where id = '71000000-0000-4000-8000-000000003671')
          || '/' || (select status from public.ingestion_jobs
                      where id = '96000000-0000-4000-8000-000000003682'),
  '71000000-0000-4000-8000-000000003672/published/indexing/leased',
  '75 older-after-newer refusal leaves pointer on v2, v2 published, v1 indexing, and v1 job leased');
select is((select result from t_out where case_name = 'b1_superseded_target'), '55000',
  '76 publish_version_v1 refuses superseded target v1 on s3601 (55000, B1)');
select is((select current_version_id::text from public.knowledge_sources
            where id = '61000000-0000-4000-8000-000000003601')
          || '/' || (select state from public.source_versions
                      where id = '71000000-0000-4000-8000-000000003612')
          || '/' || (select state from public.source_versions
                      where id = '71000000-0000-4000-8000-000000003611'),
  '71000000-0000-4000-8000-000000003612/published/superseded',
  '77 superseded refusal leaves s3601 pointer on v2, v2 published, and v1 superseded');
select is((select result from t_out where case_name = 'b1_failed_target')
          || '/' || (select current_version_id::text from public.knowledge_sources
                      where id = '61000000-0000-4000-8000-000000003607'),
  '55000/71000000-0000-4000-8000-000000003672',
  '78 publish_version_v1 refuses failed target v3 even with higher version_number (55000, pointer stays v2)');

select * from finish();
rollback;
