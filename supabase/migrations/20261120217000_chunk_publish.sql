-- T-113 SQL half: chunk/vector persistence and atomic version publication through `job_api`
-- (plan §7.2 steps 4-8, §8.3, §12.4; F12, F13).
-- Rulings implemented here:
--   * #134: server-path writes execute as `toi_job_api` over JOB_DB; the presented worker token's
--     SHA-256 digest is checked inside the same compare as tenant, version, stage, lease token and
--     fence. No table grants to `toi_job_api`.
--   * #136: `job_api.write_chunks_v1` writes chunks and vectors only for the leased `index` job's
--     version (tenant and version come from the job row, never from caller input);
--     `job_api.publish_version_v1` switches `knowledge_sources.current_version_id` atomically in
--     one statement with re-runs of the same stage key being a no-op; embedding-route-down aborts
--     the `index` job with a closed reason (#99), keeping the version in `indexing` with no pointer
--     movement.
--   * #142 / FAQ-0010: EXECUTE revoked from public, anon, authenticated, service_role by full
--     signature and granted to `toi_job_api` only; nothing added to `public`.
--
-- Timestamp claim (COORDINATION §3): `20261120217000`, after `main`'s latest
-- (`20261120215000_tenant_admin_rpc.sql`) and after in-flight #178 (`20261120216000`).
-- Exactly one migration in this PR; merged migrations are untouched.

begin;

-- ── 1. extend the closed abort vocabulary for embedding-route outages (#99, #136) ──────────────
-- Keeps all seven T-211 codes intact and adds `embedding_route_unavailable` so the cloud worker
-- can abort a leased `index` job cleanly when the pinned embedding route is down, leaving the
-- version visibly in `indexing` and preventing partial publication.
create or replace function job_api.abort_reasons() returns text[]
language sql immutable set search_path = job_api, public, pg_temp
as $fn$
  select array[
    'abandoned_by_worker', 'source_revoked', 'unsupported_document', 'object_missing',
    'quality_failed', 'operator_cancel', 'clearance_refused', 'embedding_route_unavailable'
  ]::text[]
$fn$;

revoke execute on function job_api.abort_reasons()
  from public, anon, authenticated, service_role;

-- ── 2. write_chunks_v1: sole writer of knowledge_chunks and chunk_embeddings (#136) ────────────
-- Tenant, source version and index generation are read from the locked job row, never trusted
-- from caller input. Chunk and vector inserts rely on the merged composite FKs, data-class checks,
-- `knowledge_chunks_guard`, and `chunk_embeddings_guard` (dimension pin, active/building index,
-- `cleared_for`). Any guard refusal rolls back the whole transaction so no partial batch lands.
create or replace function job_api.write_chunks_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint,
  p_source_version_id uuid,
  p_index_generation integer,
  p_embedding_index_id uuid,
  p_chunks jsonb
) returns table (
  o_outcome text,
  o_chunk_count integer,
  o_vector_count integer,
  o_event_id uuid
)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_job public.ingestion_jobs;
  v_version public.source_versions;
  v_source public.knowledge_sources;
  v_index public.embedding_indexes;
  v_effective_class text;
  v_total_chars bigint;
  v_has_embeddings boolean;
  v_elem jsonb;
  v_chunk_id uuid;
  v_chunk_index integer;
  v_chunk_class text;
  v_chunk_locator jsonb;
  v_token_count integer;
  v_existing_body text;
  v_existing_class text;
  v_chunks_written integer := 0;
  v_vectors_written integer := 0;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'chunks must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_chunks) not between 1 and 2000 then
    raise exception 'chunk set out of bounds (rows 1..2000)' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_chunks) c
     where jsonb_typeof(c) <> 'object'
        or jsonb_typeof(c -> 'body_text') <> 'string'
        or char_length(c ->> 'body_text') not between 1 and 100000
        or jsonb_typeof(c -> 'chunk_index') <> 'number'
        or (c ->> 'chunk_index') !~ '^[0-9]+$'
        or char_length(c ->> 'chunk_index') > 9
        or ((c -> 'chunk_id') is not null
            and jsonb_typeof(c -> 'chunk_id') <> 'null'
            and (jsonb_typeof(c -> 'chunk_id') <> 'string'
                 or (c ->> 'chunk_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
        or ((c -> 'locator') is not null
            and jsonb_typeof(c -> 'locator') <> 'null'
            and jsonb_typeof(c -> 'locator') <> 'object')
        or ((c -> 'data_class') is not null
            and jsonb_typeof(c -> 'data_class') <> 'null'
            and jsonb_typeof(c -> 'data_class') <> 'string')
        or ((c -> 'token_count') is not null
            and jsonb_typeof(c -> 'token_count') <> 'null'
            and (jsonb_typeof(c -> 'token_count') <> 'number'
                 or (c ->> 'token_count') !~ '^[0-9]+$'
                 or char_length(c ->> 'token_count') > 7
                 or (c ->> 'token_count')::int > 1000000))
        or ((c -> 'embedding') is not null
            and jsonb_typeof(c -> 'embedding') <> 'null'
            and (jsonb_typeof(c -> 'embedding') <> 'array'
                 or jsonb_array_length(c -> 'embedding') not between 1 and 4096
                 or exists (
                      select 1
                        from jsonb_array_elements(c -> 'embedding') v
                       where jsonb_typeof(v) <> 'number'
                    )))
  ) then
    raise exception 'each chunk needs chunk_index (>= 0), body_text (1..100000), and valid optional fields'
      using errcode = '22023';
  end if;

  select coalesce(sum(char_length(c ->> 'body_text')), 0) into v_total_chars
    from jsonb_array_elements(p_chunks) c;
  if v_total_chars > 2000000 then
    raise exception 'chunk set out of bounds (2000000 characters max)' using errcode = '22023';
  end if;

  if exists (
    select 1
      from (select (c ->> 'chunk_index')::int as ix
              from jsonb_array_elements(p_chunks) c) s
     group by s.ix having count(*) > 1
  ) then
    raise exception 'chunk_index values must be distinct within one write' using errcode = '22023';
  end if;

  select exists (
    select 1
      from jsonb_array_elements(p_chunks) c
     where (c -> 'embedding') is not null
       and jsonb_typeof(c -> 'embedding') <> 'null'
  ) into v_has_embeddings;

  if v_has_embeddings and p_embedding_index_id is null then
    raise exception 'embedding vectors require a pinned embedding_index_id' using errcode = '22023';
  end if;

  -- Authoritative lock with credential arm in the same query (#134, Round-1 B1 of #149):
  -- foreign, unknown, wrong-executor and revoked credentials answer identically.
  select * into v_job
    from public.ingestion_jobs j
   where j.id = p_job_id
     and exists (
       select 1
         from job_api.worker_credentials c
        where c.token_hash = p_token_hash
          and c.revoked_at is null
          and c.executor = j.executor
          and j.organisation_id = any (c.organisations)
     )
     for update;
  if not found then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  if v_job.stage is distinct from 'index'
     or v_job.source_version_id is distinct from p_source_version_id
     or v_job.index_generation is distinct from p_index_generation then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  select * into v_version
    from public.source_versions
   where id = v_job.source_version_id
     and organisation_id = v_job.organisation_id
     for update;
  if not found or v_version.state in ('revoked', 'deleting', 'deleted', 'quarantined') then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  select * into v_source
    from public.knowledge_sources
   where id = v_version.source_id
     and organisation_id = v_job.organisation_id;
  if not found or v_source.lifecycle_state <> 'active' then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  -- Highest of version class and job class so a reviewer raise cannot be lowered by a queued job.
  v_effective_class := case
    when public.data_class_rank(v_version.data_class) >= public.data_class_rank(v_job.data_class)
      then v_version.data_class
    else v_job.data_class
  end;

  if not job_api.executor_clears_class(v_job.executor, v_effective_class) then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  if p_embedding_index_id is not null then
    select * into v_index
      from public.embedding_indexes
     where id = p_embedding_index_id
       and organisation_id = v_job.organisation_id;
    if not found then
      raise exception 'job not available to this worker' using errcode = '42501';
    end if;
    if v_index.status = 'retired' or v_index.generation <> v_job.index_generation then
      raise exception 'embedding index % is retired or does not match index_generation %',
        v_index.id, v_job.index_generation using errcode = '23514';
    end if;
  end if;

  -- Guarded lease compare: token, fence, active lease state, expiry, and credential arm together.
  update public.ingestion_jobs j
     set status = 'succeeded',
         lease_token = null,
         lease_expires_at = null,
         completed_at = now(),
         last_error = null
   where j.id = p_job_id
     and j.stage = 'index'
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and exists (
       select 1
         from job_api.worker_credentials c
        where c.token_hash = p_token_hash
          and c.revoked_at is null
          and c.executor = j.executor
          and j.organisation_id = any (c.organisations)
     );

  if not found then
    -- Duplicate delivery from the winning fence is a no-op writing nothing; a superseded holder
    -- with an older fence still receives 42501.
    if v_job.status = 'succeeded' and v_job.lease_fence = p_fence then
      o_outcome := 'already_completed';
      select count(*)::integer into o_chunk_count
        from public.knowledge_chunks
       where organisation_id = v_job.organisation_id
         and source_version_id = v_job.source_version_id;
      select count(*)::integer into o_vector_count
        from public.chunk_embeddings ce
        join public.knowledge_chunks kc
          on kc.id = ce.chunk_id and kc.organisation_id = ce.organisation_id
       where ce.organisation_id = v_job.organisation_id
         and kc.source_version_id = v_job.source_version_id
         and ce.index_generation = v_job.index_generation;
      o_event_id := null;
      return next;
      return;
    end if;
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  for v_elem in select value from jsonb_array_elements(p_chunks) loop
    v_chunk_index := (v_elem ->> 'chunk_index')::int;
    v_chunk_locator := case
      when (v_elem -> 'locator') is not null and jsonb_typeof(v_elem -> 'locator') <> 'null'
        then v_elem -> 'locator'
      else '{}'::jsonb
    end;
    v_token_count := case
      when (v_elem -> 'token_count') is not null and jsonb_typeof(v_elem -> 'token_count') <> 'null'
        then (v_elem ->> 'token_count')::int
      else null
    end;
    v_chunk_class := case
      when (v_elem -> 'data_class') is not null and jsonb_typeof(v_elem -> 'data_class') <> 'null'
        then v_elem ->> 'data_class'
      else v_effective_class
    end;

    if not public.data_class_is_valid(v_chunk_class)
       or not public.data_class_is_ingestible_in_m1(v_chunk_class)
       or public.data_class_rank(v_chunk_class) < public.data_class_rank(v_effective_class) then
      raise exception 'chunk data class % is invalid or below its version class %',
        v_chunk_class, v_effective_class using errcode = '23514';
    end if;

    v_chunk_id := case
      when (v_elem -> 'chunk_id') is not null and jsonb_typeof(v_elem -> 'chunk_id') <> 'null'
        then (v_elem ->> 'chunk_id')::uuid
      else gen_random_uuid()
    end;

    -- ON CONFLICT on (org, version, ordinal) supports shadow re-index of identical chunks while
    -- still raising 23505 on a cross-tenant chunk_id PK collision. On conflict, verify the stored
    -- row has identical body_text and data_class >= v_effective_class (and >= v_chunk_class) so a
    -- re-parse or a reviewer class raise can never pair a new vector with stale text or a lower
    -- class (§6.2, §12.4).
    insert into public.knowledge_chunks (
      id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
    ) values (
      v_chunk_id,
      v_job.organisation_id,
      v_job.source_version_id,
      v_chunk_index,
      v_chunk_locator,
      v_elem ->> 'body_text',
      v_chunk_class,
      v_token_count
    )
    on conflict (organisation_id, source_version_id, chunk_index) do nothing;

    if found then
      v_chunks_written := v_chunks_written + 1;
    else
      select id, body_text, data_class
        into v_chunk_id, v_existing_body, v_existing_class
        from public.knowledge_chunks
       where organisation_id = v_job.organisation_id
         and source_version_id = v_job.source_version_id
         and chunk_index = v_chunk_index;

      if v_existing_body is distinct from (v_elem ->> 'body_text') then
        raise exception 'existing chunk % at chunk_index % has different body_text; refusing silent reuse',
          v_chunk_id, v_chunk_index using errcode = '23514';
      end if;

      if public.data_class_rank(v_existing_class) < public.data_class_rank(v_effective_class)
         or public.data_class_rank(v_existing_class) < public.data_class_rank(v_chunk_class) then
        raise exception 'existing chunk % at chunk_index % has data_class % below required class %',
          v_chunk_id, v_chunk_index, v_existing_class, v_chunk_class using errcode = '23514';
      end if;
    end if;

    if (v_elem -> 'embedding') is not null and jsonb_typeof(v_elem -> 'embedding') <> 'null' then
      insert into public.chunk_embeddings (
        organisation_id, chunk_id, index_id, index_generation, embedding
      ) values (
        v_job.organisation_id,
        v_chunk_id,
        v_index.id,
        v_job.index_generation,
        ((v_elem -> 'embedding')::text)::extensions.vector
      )
      on conflict (organisation_id, index_id, chunk_id) do nothing;

      if found then
        v_vectors_written := v_vectors_written + 1;
      end if;
    end if;
  end loop;

  -- Reject half-embedded batches when an index is pinned (§7.2 step 8, #136): every chunk of this
  -- version whose data_class is covered by v_index.cleared_for must have a vector in that index
  -- and generation. Chunks outside cleared_for legitimately remain lexical-only.
  if p_embedding_index_id is not null then
    if exists (
      select 1
        from public.knowledge_chunks kc
       where kc.organisation_id = v_job.organisation_id
         and kc.source_version_id = v_job.source_version_id
         and v_index.cleared_for @> array[kc.data_class]
         and not exists (
           select 1
             from public.chunk_embeddings ce
            where ce.organisation_id = kc.organisation_id
              and ce.chunk_id = kc.id
              and ce.index_id = v_index.id
              and ce.index_generation = v_job.index_generation
         )
    ) then
      raise exception 'source version % has cleared chunks missing vectors in index % generation %; refusing partial embedding',
        v_job.source_version_id, v_index.id, v_job.index_generation using errcode = '23514';
    end if;
  end if;

  if v_version.state in ('received', 'validating', 'extracting') then
    update public.source_versions
       set state = 'indexing'
     where id = v_job.source_version_id
       and organisation_id = v_job.organisation_id;
  end if;

  insert into public.outbox_events (
    organisation_id, event_type, aggregate_type, aggregate_id, payload
  ) values (
    v_job.organisation_id,
    'knowledge.ingestion_job.index_succeeded',
    'ingestion_job',
    p_job_id,
    jsonb_build_object(
      'job_id', p_job_id,
      'source_version_id', v_job.source_version_id,
      'chunks_written', v_chunks_written,
      'vectors_written', v_vectors_written,
      'index_generation', v_job.index_generation
    )
  )
  returning id into o_event_id;

  o_outcome := 'completed';
  o_chunk_count := v_chunks_written;
  o_vector_count := v_vectors_written;
  return next;
end;
$fn$;

-- ── 3. publish_version_v1: atomic skeleton auto-publish pointer switch (#136) ──────────────────
-- Verifies credential, lease, stage, version, generation, parent liveness, and that the matching
-- `index` stage succeeded with chunks persisted, then flips target -> `published`, prior active
-- version -> `superseded`, and `knowledge_sources.current_version_id` -> target in one statement.
create or replace function job_api.publish_version_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint,
  p_source_version_id uuid,
  p_index_generation integer
) returns table (
  o_outcome text,
  o_source_id uuid,
  o_source_version_id uuid,
  o_previous_version_id uuid,
  o_published_at timestamptz,
  o_event_id uuid
)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_job public.ingestion_jobs;
  v_version public.source_versions;
  v_source public.knowledge_sources;
  v_effective_class text;
  v_prior_version_id uuid;
  v_prior_version_number integer;
  v_published_at timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;

  select * into v_job
    from public.ingestion_jobs j
   where j.id = p_job_id
     and exists (
       select 1
         from job_api.worker_credentials c
        where c.token_hash = p_token_hash
          and c.revoked_at is null
          and c.executor = j.executor
          and j.organisation_id = any (c.organisations)
     )
     for update;
  if not found then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  if v_job.stage is distinct from 'publish'
     or v_job.source_version_id is distinct from p_source_version_id
     or v_job.index_generation is distinct from p_index_generation then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  select * into v_version
    from public.source_versions
   where id = v_job.source_version_id
     and organisation_id = v_job.organisation_id;
  if not found then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  -- Lock parent source before target version so concurrent publishes for the same source serialize.
  select * into v_source
    from public.knowledge_sources
   where id = v_version.source_id
     and organisation_id = v_job.organisation_id
     for update;
  if not found or v_source.lifecycle_state <> 'active' then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  select * into v_version
    from public.source_versions
   where id = v_job.source_version_id
     and organisation_id = v_job.organisation_id
     for update;
  if v_version.state in ('revoked', 'deleting', 'deleted', 'quarantined') then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  -- Same higher-of-job-and-version clearance rule as write_chunks_v1.
  v_effective_class := case
    when public.data_class_rank(v_version.data_class) >= public.data_class_rank(v_job.data_class)
      then v_version.data_class
    else v_job.data_class
  end;

  if not job_api.executor_clears_class(v_job.executor, v_effective_class) then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  if v_job.status = 'succeeded' and v_job.lease_fence = p_fence then
    o_outcome := 'already_published';
    o_source_id := v_source.id;
    o_source_version_id := v_job.source_version_id;
    o_previous_version_id := null;
    o_published_at := v_version.published_at;
    o_event_id := null;
    return next;
    return;
  end if;

  update public.ingestion_jobs j
     set status = 'succeeded',
         lease_token = null,
         lease_expires_at = null,
         completed_at = now(),
         last_error = null
   where j.id = p_job_id
     and j.stage = 'publish'
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and exists (
       select 1
         from job_api.worker_credentials c
        where c.token_hash = p_token_hash
          and c.revoked_at is null
          and c.executor = j.executor
          and j.organisation_id = any (c.organisations)
     );

  if not found then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  -- Never expose an un-indexed or half-embedded version (§7.2 step 8, #136): raising 55000 rolls
  -- back the job update above so the lease and any prior active version remain intact.
  if not exists (
    select 1
      from public.ingestion_jobs idx
     where idx.organisation_id = v_job.organisation_id
       and idx.source_version_id = v_job.source_version_id
       and idx.stage = 'index'
       and idx.parser_generation = v_job.parser_generation
       and idx.index_generation = v_job.index_generation
       and idx.status = 'succeeded'
  ) or not exists (
    select 1
      from public.knowledge_chunks kc
     where kc.organisation_id = v_job.organisation_id
       and kc.source_version_id = v_job.source_version_id
  ) or exists (
    select 1
      from public.chunk_embeddings ce_any
      join public.knowledge_chunks kc_any
        on kc_any.id = ce_any.chunk_id
       and kc_any.organisation_id = ce_any.organisation_id
      join public.embedding_indexes ei
        on ei.id = ce_any.index_id
       and ei.organisation_id = ce_any.organisation_id
      join public.knowledge_chunks kc_miss
        on kc_miss.organisation_id = v_job.organisation_id
       and kc_miss.source_version_id = v_job.source_version_id
     where ce_any.organisation_id = v_job.organisation_id
       and kc_any.source_version_id = v_job.source_version_id
       and ce_any.index_generation = v_job.index_generation
       and ei.cleared_for @> array[kc_miss.data_class]
       and not exists (
         select 1
           from public.chunk_embeddings ce_ok
          where ce_ok.organisation_id = kc_miss.organisation_id
            and ce_ok.chunk_id = kc_miss.id
            and ce_ok.index_id = ei.id
            and ce_ok.index_generation = v_job.index_generation
       )
  ) then
    raise exception 'source version % is not completely indexed for generation %; refusing partial publication',
      v_job.source_version_id, v_job.index_generation using errcode = '55000';
  end if;

  if v_source.current_version_id = v_job.source_version_id
     and v_version.state = 'published' then
    o_outcome := 'already_published';
    o_source_id := v_source.id;
    o_source_version_id := v_job.source_version_id;
    o_previous_version_id := v_source.current_version_id;
    o_published_at := v_version.published_at;
    o_event_id := null;
    return next;
    return;
  end if;

  -- Only forward states may publish, and a version may never replace an equal or newer active
  -- version (prevents out-of-order v1-after-v2 rollback or superseded/failed resurrection).
  if v_version.state not in ('indexing', 'awaiting_review') then
    raise exception 'source version % in state % is not eligible for publication',
      v_job.source_version_id, v_version.state using errcode = '55000';
  end if;

  v_prior_version_id := v_source.current_version_id;
  if v_prior_version_id is not null then
    select version_number into v_prior_version_number
      from public.source_versions
     where id = v_prior_version_id
       and organisation_id = v_job.organisation_id
       for update;
    if not found or v_version.version_number <= v_prior_version_number then
      raise exception 'source version % (v%) cannot replace active version % (v%)',
        v_job.source_version_id, v_version.version_number,
        v_prior_version_id, v_prior_version_number using errcode = '55000';
    end if;
  end if;

  -- Single-statement atomic pointer switch (#136, F13): target -> published, prior -> superseded,
  -- source.current_version_id -> target.
  with mark_target as (
    update public.source_versions
       set state = 'published',
           published_at = coalesce(published_at, now())
     where id = v_job.source_version_id
       and organisation_id = v_job.organisation_id
       and state in ('indexing', 'awaiting_review')
     returning id, source_id, published_at
  ), mark_prior as (
    update public.source_versions
       set state = 'superseded'
     where id = v_prior_version_id
       and organisation_id = v_job.organisation_id
       and id <> v_job.source_version_id
       and state = 'published'
       and exists (select 1 from mark_target)
     returning id
  )
  update public.knowledge_sources s
     set current_version_id = t.id
    from mark_target t
   where s.id = t.source_id
     and s.organisation_id = v_job.organisation_id
     and s.lifecycle_state = 'active'
   returning t.published_at into v_published_at;

  if not found then
    raise exception 'source % could not switch active version pointer', v_source.id
      using errcode = '55000';
  end if;

  insert into public.outbox_events (
    organisation_id, event_type, aggregate_type, aggregate_id, payload
  ) values (
    v_job.organisation_id,
    'knowledge.source_version.published',
    'source_version',
    v_job.source_version_id,
    jsonb_build_object(
      'job_id', p_job_id,
      'source_id', v_source.id,
      'source_version_id', v_job.source_version_id,
      'previous_version_id', v_prior_version_id,
      'organisation_id', v_job.organisation_id,
      'index_generation', v_job.index_generation,
      'policy', 'skeleton_auto_publish'
    )
  )
  returning id into o_event_id;

  o_outcome := 'published';
  o_source_id := v_source.id;
  o_source_version_id := v_job.source_version_id;
  o_previous_version_id := v_prior_version_id;
  o_published_at := v_published_at;
  return next;
end;
$fn$;

-- ── 4. per-function revoke and grant, by full signature (#134, #142, FAQ-0010) ────────────────
revoke execute on function
  job_api.write_chunks_v1(text, uuid, text, bigint, uuid, integer, uuid, jsonb),
  job_api.publish_version_v1(text, uuid, text, bigint, uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function
  job_api.write_chunks_v1(text, uuid, text, bigint, uuid, integer, uuid, jsonb),
  job_api.publish_version_v1(text, uuid, text, bigint, uuid, integer)
  to toi_job_api;

comment on function job_api.write_chunks_v1(text, uuid, text, bigint, uuid, integer, uuid, jsonb) is
  'Sole write path for knowledge_chunks and chunk_embeddings (T-113, #136). Executes as toi_job_api over JOB_DB; checks credential digest, lease token, fence, expiry, stage, version, generation and parent liveness in one transaction. Derives tenant and version from the job row, enforces class non-lowering and pinned-index guards atomically, and treats duplicate deliveries from the winning fence as already_completed.';

comment on function job_api.publish_version_v1(text, uuid, text, bigint, uuid, integer) is
  'Atomic skeleton auto-publish switch (T-113, #136, F13). Executes as toi_job_api over JOB_DB; requires a succeeded index stage and persisted chunks for the matching stage key, switches target -> published, prior -> superseded and knowledge_sources.current_version_id -> target in one statement, emits one outbox event, and treats stage re-runs as already_published.';

commit;
