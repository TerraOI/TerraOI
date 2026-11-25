-- T-113 follow-up: open `lease_parse_job_v1` for the `publish` stage (cloud_worker only) and
-- extend `dispatch_outbox_v1` so `index_succeeded` enqueues a publish job (#99 stage key).
--
-- Consumes the index-stage lease migration (`20261124120000_index_stage_lease`) and the
-- write/publish RPC slice on the merge train (#219: `write_chunks_v1` emits
-- `knowledge.ingestion_job.index_succeeded`; `publish_version_v1` switches the pointer).
-- This migration does **not** vendor chunk_publish.sql.
--
-- Policy assumption (T-113 vs T-213): the skeleton auto-publish loop stays here; T-213 owns
-- review/revoke policy later. Provisional on: none.
--
-- Timestamp claim (daily sync, COORDINATION §3): after `20261124120000_index_stage_lease`.
-- Exactly one migration in this PR. Privilege discipline (FAQ-0010): revoke by full signature;
-- EXECUTE only to toi_job_api. Nothing added to `public` (no 001 allow-list row).

begin;

-- ── 1. lease_parse_job_v1: extract + index + publish (index/publish = cloud_worker only) ───────
-- Replaces the extract+index gate from `20261124120000_index_stage_lease.sql`. Publish reclaim
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
-- Keeps the extract→index arm from `20261121210000_outbox_dispatch.sql` and adds the
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

commit;
