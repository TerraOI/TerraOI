-- TOI-013 (T-113 × T-213): the worker publish path honours T-213's publication policy.
--
-- T-113's `job_api.publish_version_v1` (#219) is the week-1 skeleton auto-publish: it publishes any
-- fully indexed version. T-213 (#267) then added the review queue and the rule for publication —
-- an `approve` row in `knowledge_review_decisions`, or a collection with `auto_publish` and a
-- low-risk note (`kind = 'note'`, class public|internal) — but enforced it only on the employee path
-- (`publish_knowledge_version_v1`). With both merged, the worker path would publish every upload
-- unreviewed, including client_confidential versions whose collections require independent review.
--
-- This migration keeps the signature the workers call and puts the same rule in front of it:
-- * allowed (approved, auto-publishable note, or already published) → the original body runs
--   unchanged (renamed `job_api.publish_version_core_v1`, executable by nobody but its owner);
-- * otherwise the publish job is completed under the same lease compare, the version is parked in
--   `awaiting_review` with no pointer movement, and the outcome is `awaiting_review`. A reviewer
--   then approves (`review_decision_v1`) and publishes (`publish_knowledge_version_v1`).

alter function job_api.publish_version_v1(text, uuid, text, bigint, uuid, integer)
  rename to publish_version_core_v1;
revoke all on function job_api.publish_version_core_v1(text, uuid, text, bigint, uuid, integer)
  from public, anon, authenticated, service_role, toi_job_api;
comment on function job_api.publish_version_core_v1(text, uuid, text, bigint, uuid, integer) is
  'T-113 publish body (#219), reached only through job_api.publish_version_v1 once the T-213 publication rule allows it.';

-- The completeness predicate of the T-113 body (#219), restated so a parked version has passed exactly
-- the gate a published one would have: the index job for this parser/index generation succeeded, the
-- version has chunks, and no chunk is missing an embedding in an index cleared for its class.
create or replace function job_api.publish_version_complete(p_job public.ingestion_jobs)
returns boolean
language sql stable security definer set search_path = job_api, public, pg_temp as $fn$
  select exists (
           select 1 from public.ingestion_jobs idx
            where idx.organisation_id = p_job.organisation_id
              and idx.source_version_id = p_job.source_version_id
              and idx.stage = 'index'
              and idx.parser_generation = p_job.parser_generation
              and idx.index_generation = p_job.index_generation
              and idx.status = 'succeeded')
     and exists (
           select 1 from public.knowledge_chunks kc
            where kc.organisation_id = p_job.organisation_id
              and kc.source_version_id = p_job.source_version_id)
     and not exists (
           select 1
             from public.chunk_embeddings ce_any
             join public.knowledge_chunks kc_any
               on kc_any.id = ce_any.chunk_id and kc_any.organisation_id = ce_any.organisation_id
             join public.embedding_indexes ei
               on ei.id = ce_any.index_id and ei.organisation_id = ce_any.organisation_id
             join public.knowledge_chunks kc_miss
               on kc_miss.organisation_id = p_job.organisation_id
              and kc_miss.source_version_id = p_job.source_version_id
            where ce_any.organisation_id = p_job.organisation_id
              and kc_any.source_version_id = p_job.source_version_id
              and ce_any.index_generation = p_job.index_generation
              and ei.cleared_for @> array[kc_miss.data_class]
              and not exists (
                select 1 from public.chunk_embeddings ce_ok
                 where ce_ok.organisation_id = kc_miss.organisation_id
                   and ce_ok.chunk_id = kc_miss.id
                   and ce_ok.index_id = ei.id
                   and ce_ok.index_generation = p_job.index_generation));
$fn$;
revoke all on function job_api.publish_version_complete(public.ingestion_jobs) from public, anon, authenticated, service_role, toi_job_api;

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
  v_collection public.knowledge_collections;
  v_allowed boolean;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;

  -- Same tenant/executor/credential compare as the body, so a refusal here leaks nothing new.
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
  if not found
     or v_job.stage is distinct from 'publish'
     or v_job.source_version_id is distinct from p_source_version_id
     or v_job.index_generation is distinct from p_index_generation then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  select * into v_version from public.source_versions
   where id = v_job.source_version_id and organisation_id = v_job.organisation_id;
  select * into v_source from public.knowledge_sources
   where id = v_version.source_id and organisation_id = v_job.organisation_id;
  select * into v_collection from public.knowledge_collections
   where id = v_version.collection_id and organisation_id = v_job.organisation_id;
  if v_version.id is null or v_source.id is null or v_collection.id is null then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  v_allowed :=
    v_version.state = 'published'
    or exists (
      select 1 from public.knowledge_review_decisions d
       where d.organisation_id = v_job.organisation_id
         and d.source_version_id = v_version.id
         and d.decision = 'approve'
    )
    or (v_collection.auto_publish and v_source.kind = 'note' and v_version.data_class in ('public', 'internal'));

  if v_allowed then
    return query
      select * from job_api.publish_version_core_v1(
        p_token_hash, p_job_id, p_lease_token, p_fence, p_source_version_id, p_index_generation);
    return;
  end if;

  -- Not allowed to publish yet: the version must still pass every gate the body would apply before
  -- it is parked — live source, a parkable state, executor clearance, complete indexing — so review
  -- can never become a way around them.
  if v_source.lifecycle_state <> 'active'
     or v_version.state not in ('indexing', 'awaiting_review')
     or not job_api.executor_clears_class(
          v_job.executor,
          case when public.data_class_rank(v_version.data_class) >= public.data_class_rank(v_job.data_class)
               then v_version.data_class else v_job.data_class end) then
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;
  if not job_api.publish_version_complete(v_job) then
    raise exception 'source version % is not completely indexed for generation %; refusing to park it for review',
      v_job.source_version_id, v_job.index_generation using errcode = '55000';
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
    -- A replay of the same finished stage key answers the same way; anything else is refused.
    if not (v_job.status = 'succeeded' and v_job.lease_fence = p_fence and v_version.state = 'awaiting_review') then
      raise exception 'job not available to this worker' using errcode = '42501';
    end if;
  end if;

  update public.source_versions
     set state = 'awaiting_review',
         updated_at = now()
   where id = v_version.id
     and organisation_id = v_job.organisation_id
     and state = 'indexing';

  o_outcome := 'awaiting_review';
  o_source_id := v_source.id;
  o_source_version_id := v_version.id;
  o_previous_version_id := v_source.current_version_id;
  o_published_at := null;
  o_event_id := null;
  return next;
end;
$fn$;

revoke all on function job_api.publish_version_v1(text, uuid, text, bigint, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function job_api.publish_version_v1(text, uuid, text, bigint, uuid, integer)
  to toi_job_api;
comment on function job_api.publish_version_v1(text, uuid, text, bigint, uuid, integer) is
  'Worker publish (T-113) behind the T-213 rule: approved, auto-publishable note or already published → publish; otherwise complete the job and park the version in awaiting_review (outcome awaiting_review).';
