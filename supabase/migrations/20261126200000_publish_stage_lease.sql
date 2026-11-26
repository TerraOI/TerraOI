-- T-113 follow-up: open `lease_parse_job_v1` for the `publish` stage (cloud_worker only) and
-- extend `dispatch_outbox_v1` so `index_succeeded` enqueues a publish job (#99 stage key).
--
-- Consumes the index-stage lease migration (`20261124120000_index_stage_lease`) and the
-- write/publish RPC slice on the merge train (#219: `write_chunks_v1` emits
-- `knowledge.ingestion_job.index_succeeded`; `publish_version_v1` switches the pointer).
-- This migration does **not** vendor chunk_publish.sql.
--
-- Policy (supervisor round 1 on #285): the worker publish path is NOT a skeleton auto-publish.
-- section 3 of this file (ported from #291's `20261125120000_publish_respects_review.sql`) puts T-213's publication rule in front of
-- `publish_version_v1`: an unreviewed version is parked in `awaiting_review`, never published.
--
-- Timestamp (COORDINATION §3): renamed from 20261124130000 (it collided with T-213's
-- review_publish and sorted before main's outbox_dispatch 160000 and index_stage_lease 190000,
-- which replace the same two functions) to after `20261126190000_index_stage_lease`.
-- Exactly one migration in this PR. Privilege discipline (FAQ-0010): revoke by full signature;
-- EXECUTE only to toi_job_api. Nothing added to `public` (no 001 allow-list row).

begin;

-- ── 1. lease_parse_job_v1: extract + index + publish (index/publish = cloud_worker only) ───────
-- Replaces the extract+index gate from `20261126190000_index_stage_lease.sql`. Publish reclaim
-- is stage-scoped so an extract or index lease never reclaims a publish holder and vice versa.
create or replace function job_api.lease_parse_job_v1(
  p_token_hash text,
  p_stage text,
  p_lease_seconds integer
) returns table (
  o_found boolean, o_job_id uuid, o_organisation_id uuid, o_source_version_id uuid,
  o_stage text, o_executor text, o_parser_generation text, o_index_generation integer,
  o_data_class text, o_lease_token text, o_fence bigint, o_attempt integer
)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_job public.ingestion_jobs;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  -- Extract stays open for both executors; index and publish are cloud_worker only
  -- (ingestion_jobs CHECK already pins local_box to extract).
  if p_stage is null or p_stage not in ('extract', 'index', 'publish') then
    raise exception 'this job API leases extract, index, and publish only'
      using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and job_api.max_lease_seconds() then
    raise exception 'lease seconds must be between 60 and %', job_api.max_lease_seconds()
      using errcode = '22023';
  end if;

  -- Reclaim first (#99), scoped to the stage being leased.
  update public.ingestion_jobs j
     set status = case when j.attempt > job_api.max_attempts() then 'failed' else 'queued' end,
         lease_token = null,
         lease_expires_at = null,
         lease_fence = j.lease_fence + 1,
         last_error = case when j.attempt > job_api.max_attempts()
                           then 'retries_exhausted' else j.last_error end
   where j.stage = p_stage
     and j.status in ('leased', 'running')
     and j.lease_expires_at is not null
     and j.lease_expires_at <= now()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations));

  select * into v_job from public.ingestion_jobs j
   where j.stage = p_stage
     and j.status in ('queued', 'leased', 'running')
     and (j.lease_token is null or j.lease_expires_at <= now())
     and j.attempt <= job_api.max_attempts()
     and (p_stage = 'extract' or j.executor = 'cloud_worker')
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations))
   order by j.created_at
   limit 1
   for update skip locked;

  if not found then
    o_found := false;
    return next;
    return;
  end if;

  update public.ingestion_jobs
     set status = 'leased',
         lease_token = encode(extensions.gen_random_bytes(24), 'base64'),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         lease_fence = lease_fence + 1,
         attempt = attempt + 1
   where id = v_job.id
   returning lease_token, lease_fence, attempt into o_lease_token, o_fence, o_attempt;

  o_found := true;
  o_job_id := v_job.id;
  o_organisation_id := v_job.organisation_id;
  o_source_version_id := v_job.source_version_id;
  o_stage := v_job.stage;
  o_executor := v_job.executor;
  o_parser_generation := v_job.parser_generation;
  o_index_generation := v_job.index_generation;
  o_data_class := v_job.data_class;
  return next;
end;
$fn$;

comment on function job_api.lease_parse_job_v1(text, text, integer) is
  'Lease one queued extract, index, or publish job for the credential''s executor and tenants '
  '(#134, T-113). Index and publish are cloud_worker only. Expired leases for the requested stage '
  'are reclaimed under the attempt cap before the skip-locked select. Foreign and unknown answer '
  'o_found = false.';

revoke all on function job_api.lease_parse_job_v1(text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function job_api.lease_parse_job_v1(text, text, integer)
  to toi_job_api;

-- ── 2. dispatch_outbox_v1: extract_succeeded→index and index_succeeded→publish ─────────────────
-- Keeps the extract→index arm from `20261126160000_outbox_dispatch.sql` and adds the
-- index→publish arm. Unknown event types stay unprocessed for a later owner.
create or replace function job_api.dispatch_outbox_v1(
  p_token_hash text,
  p_limit integer default 32
) returns table (
  o_processed integer,
  o_enqueued integer,
  o_skipped integer
)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_orgs uuid[];
  v_event public.outbox_events;
  v_job public.ingestion_jobs;
  v_version_state text;
  v_next_stage text;
  v_inserted integer;
  v_processed integer := 0;
  v_enqueued integer := 0;
  v_skipped integer := 0;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'dispatch limit must be between 1 and 100' using errcode = '22023';
  end if;

  select c.organisations into v_orgs
    from job_api.worker_credentials c
   where c.token_hash = p_token_hash
     and c.revoked_at is null
     and c.executor = 'cloud_worker';

  if v_orgs is null then
    raise exception 'worker not permitted to dispatch' using errcode = '42501';
  end if;

  for v_event in
    select e.*
      from public.outbox_events e
     where e.processed_at is null
       and e.event_type in (
         'knowledge.ingestion_job.extract_succeeded',
         'knowledge.ingestion_job.index_succeeded'
       )
       and e.organisation_id = any (v_orgs)
     order by e.created_at
     limit p_limit
     for update of e skip locked
  loop
    v_processed := v_processed + 1;
    v_inserted := 0;
    v_next_stage := case v_event.event_type
      when 'knowledge.ingestion_job.extract_succeeded' then 'index'
      when 'knowledge.ingestion_job.index_succeeded' then 'publish'
      else null
    end;

    if v_next_stage is null then
      v_skipped := v_skipped + 1;
    else
      select j.* into v_job
        from public.ingestion_jobs j
       where j.id = v_event.aggregate_id
         and j.organisation_id = v_event.organisation_id
         and j.stage = case v_next_stage
           when 'index' then 'extract'
           when 'publish' then 'index'
           else null
         end
         and j.status = 'succeeded';

      if not found then
        v_skipped := v_skipped + 1;
      else
        select v.state into v_version_state
          from public.source_versions v
         where v.id = v_job.source_version_id
           and v.organisation_id = v_job.organisation_id;

        if v_version_state is null
           or v_version_state in ('revoked', 'deleting', 'deleted')
           or not public.data_class_is_ingestible_in_m1(v_job.data_class) then
          v_skipped := v_skipped + 1;
        else
          -- Stage key absorbs a duplicate delivery; attempt stays outside the key (#16 N3, #99).
          insert into public.ingestion_jobs (
            organisation_id, source_version_id, stage, executor, status, data_class,
            parser_generation, index_generation
          ) values (
            v_job.organisation_id, v_job.source_version_id, v_next_stage, 'cloud_worker', 'queued',
            v_job.data_class, v_job.parser_generation, v_job.index_generation
          )
          on conflict (organisation_id, source_version_id, stage, parser_generation, index_generation)
            do nothing;

          get diagnostics v_inserted = row_count;
          if v_inserted > 0 then
            v_enqueued := v_enqueued + 1;
          else
            v_skipped := v_skipped + 1;
          end if;
        end if;
      end if;
    end if;

    update public.outbox_events
       set processed_at = now()
     where id = v_event.id
       and organisation_id = v_event.organisation_id
       and processed_at is null;
  end loop;

  o_processed := v_processed;
  o_enqueued := v_enqueued;
  o_skipped := v_skipped;
  return next;
end;
$fn$;

revoke all on function job_api.dispatch_outbox_v1(text, integer)
  from public, anon, authenticated, service_role;

grant execute on function job_api.dispatch_outbox_v1(text, integer)
  to toi_job_api;

comment on function job_api.dispatch_outbox_v1(text, integer) is
  'Cloud-worker outbox dispatcher (T-211 / T-113, #99): drains pending extract_succeeded and '
  'index_succeeded events for the credential''s tenants, enqueues the next stage job under the '
  'stage key (on conflict do nothing), and marks processed_at. A duplicate delivery or a revoked '
  'parent is a skip, not an error. Unknown event types are left unprocessed so a later dispatcher '
  'can own them.';


-- ── 3. T-213 publication rule in front of the worker publish (TOI-013) ──────────────────────────
-- Ported by the supervisor (round 1 on #285) from #291's `20261125120000_publish_respects_review.sql`,
-- unchanged. In this file rather than its own because CI allows one migration per PR, and the rule
-- must land in the same migration that opens the publish stage.

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

commit;
