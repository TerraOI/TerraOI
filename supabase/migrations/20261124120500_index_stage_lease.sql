-- T-113 follow-up: open `lease_parse_job_v1` for the `index` stage and add
-- `job_api.artifacts_for_lease_v1` so the cloud index consumer can read extract artifacts
-- under the same lease compare as `write_chunks_v1` (#134, #136).
--
-- Timestamp claim (daily sync, COORDINATION §3): after `20261121210000_outbox_dispatch`
-- (T-211 PR-3d) and after `20261120217000_chunk_publish` (T-113 SQL half). Exactly one
-- migration in this PR. Privilege discipline (FAQ-0010): revoke by full signature; EXECUTE
-- only to toi_job_api. Publish-stage lease remains T-213 / a later outbox slice.

begin;

-- ── 1. lease_parse_job_v1: extract (unchanged) + index (cloud_worker only) ─────────────────────
-- Replaces the M1 extract-only gate from `20261120212000_ocr_job_leases.sql`. Publish stays
-- refused (22023). Index reclaim runs for the requested stage only so an extract lease never
-- reclaims an index holder and vice versa.
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
  -- Extract stays open for both executors; index is cloud_worker only (ingestion_jobs
  -- CHECK already pins local_box to extract). Publish belongs to T-213.
  if p_stage is null or p_stage not in ('extract', 'index') then
    raise exception 'this job API leases extract and index only; publish is a later stage'
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
     and (p_stage <> 'index' or j.executor = 'cloud_worker')
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
  'Lease one queued extract or index job for the credential''s executor and tenants (#134, T-113). '
  'Index is cloud_worker only; publish remains refused. Expired leases for the requested stage are '
  'reclaimed under the attempt cap before the skip-locked select. Foreign and unknown answer o_found = false.';

-- ── 2. artifacts_for_lease_v1: extract text for a leased index job ─────────────────────────────
-- Same compare shape as object_ref_for_lease_v1: credential, token, fence, live lease, and
-- stage=index. Returns extract-stage artifacts for the job's source_version; a no-row answer
-- is closed (foreign / revoked / wrong stage all look the same).
create or replace function job_api.artifacts_for_lease_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint
) returns table (
  o_found boolean,
  o_artifact_index integer,
  o_body_text text,
  o_locator jsonb
)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_job public.ingestion_jobs;
  v_version public.source_versions;
  v_effective_class text;
  v_has_row boolean := false;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;

  select * into v_job
    from public.ingestion_jobs j
   where j.id = p_job_id
     and j.stage = 'index'
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and j.executor = 'cloud_worker'
     and exists (
       select 1
         from job_api.worker_credentials c
        where c.token_hash = p_token_hash
          and c.revoked_at is null
          and c.executor = j.executor
          and j.organisation_id = any (c.organisations)
     );

  if not found then
    o_found := false;
    return next;
    return;
  end if;

  select * into v_version
    from public.source_versions
   where id = v_job.source_version_id
     and organisation_id = v_job.organisation_id;
  if not found or v_version.state in ('revoked', 'deleting', 'deleted', 'quarantined') then
    o_found := false;
    return next;
    return;
  end if;

  v_effective_class := case
    when public.data_class_rank(v_version.data_class) >= public.data_class_rank(v_job.data_class)
      then v_version.data_class
    else v_job.data_class
  end;
  if not job_api.executor_clears_class(v_job.executor, v_effective_class) then
    o_found := false;
    return next;
    return;
  end if;

  for o_artifact_index, o_body_text, o_locator in
    select a.artifact_index, a.body_text, a.locator
      from public.extraction_artifacts a
     where a.organisation_id = v_job.organisation_id
       and a.source_version_id = v_job.source_version_id
       and a.stage = 'extract'
       and a.parser_generation = v_job.parser_generation
       and a.index_generation = v_job.index_generation
     order by a.artifact_index
  loop
    v_has_row := true;
    o_found := true;
    return next;
  end loop;

  if not v_has_row then
    -- Live lease, no extract artifacts yet (or wrong generation): closed no-row, same as refuse.
    o_found := false;
    return next;
  end if;
end;
$fn$;

revoke all on function job_api.artifacts_for_lease_v1(text, uuid, text, bigint)
  from public, anon, authenticated, service_role;

grant execute on function job_api.artifacts_for_lease_v1(text, uuid, text, bigint)
  to toi_job_api;

comment on function job_api.artifacts_for_lease_v1(text, uuid, text, bigint) is
  'Read extract-stage artifacts for a leased index job (T-113). Credential digest, lease token, '
  'fence, expiry, stage=index and parent liveness are checked in one compare; tenant and version '
  'come from the job row. Foreign / revoked / uncleared answer o_found = false with no existence signal.';

-- lease_parse_job_v1 privileges already granted in 20261120212000; replace keeps them.
-- Re-assert revoke/grant so a drifted grant cannot linger after create or replace.
revoke all on function job_api.lease_parse_job_v1(text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function job_api.lease_parse_job_v1(text, text, integer)
  to toi_job_api;

commit;
