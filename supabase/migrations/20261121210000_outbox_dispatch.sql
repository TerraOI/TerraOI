-- T-211 PR-3d: outbox dispatcher — extract_succeeded → index enqueue (#99 stage key).
-- Plan §7.2 step 1 / §7.5: events are written in the same transaction as the aggregate change;
-- a dispatcher publishes at-least-once and marks processed_at. Idempotency is the stage key on
-- ingestion_jobs (knowledge_core.sql:398), not a second unique on the outbox row.
--
-- Timestamp claim (daily sync, COORDINATION §3): after in-flight #229 `20261121200000_last_admin_guard`
-- and after main's latest `20261120215000_tenant_admin_rpc`. Exactly one migration in this PR.
-- Privilege discipline (FAQ-0010): revoke by full signature; EXECUTE only to toi_job_api.

begin;

-- ── dispatch_outbox_v1 ─────────────────────────────────────────────────────────────────────────
-- Cloud worker only: index stage is never local_box (ingestion_jobs_local_box_runs_only_extract).
-- Selects only the known M1 event type so unknown future event_types do not block the pending
-- index (outbox_events_pending_idx is created_at over processed_at is null).
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

  -- Dispatcher is the cloud worker's job: a box credential leases extract work, it does not
  -- enqueue the next stage (#99 / §13). Revoked and unknown digests answer the same way.
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
       and e.event_type = 'knowledge.ingestion_job.extract_succeeded'
       and e.organisation_id = any (v_orgs)
     order by e.created_at
     limit p_limit
     for update of e skip locked
  loop
    v_processed := v_processed + 1;
    v_inserted := 0;

    select j.* into v_job
      from public.ingestion_jobs j
     where j.id = v_event.aggregate_id
       and j.organisation_id = v_event.organisation_id
       and j.stage = 'extract'
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
        -- Same shape as capture's extract enqueue (knowledge_uploads.sql:470-478): stage key
        -- absorbs a duplicate delivery; attempt stays outside the key (#16 N3, #99).
        insert into public.ingestion_jobs (
          organisation_id, source_version_id, stage, executor, status, data_class,
          parser_generation, index_generation
        ) values (
          v_job.organisation_id, v_job.source_version_id, 'index', 'cloud_worker', 'queued',
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
  'Cloud-worker outbox dispatcher (T-211, #99): drains pending knowledge.ingestion_job.extract_succeeded '
  'events for the credential''s tenants, enqueues an index-stage job under the stage key (on conflict do '
  'nothing), and marks processed_at. A duplicate delivery or a revoked parent is a skip, not an error. '
  'Unknown event types are left unprocessed so a later dispatcher can own them.';

commit;
