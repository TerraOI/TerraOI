-- T-113 follow-up: publish-stage lease + index_succeeded → publish outbox drain
-- (supabase/migrations/20261124130000_publish_stage_lease.sql).
-- Plan §7.2; #134 credential compare; FAQ-0010 privilege surface.
-- Synthetic fixtures only. Privileged paths run as the test role (postgres), matching
-- 045/047 idiom: job_api RPCs are SECURITY DEFINER and EXECUTE is granted only to
-- toi_job_api — request-role negatives use `set local role authenticated` + try_* helpers.
-- Do not `set local role toi_job_api` here (045/047 never need it).

begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t113-pub-lease-' || p_seed) || md5('t113-pub-lease-' || p_seed || '-tail');
$fn$;

create function pg_temp.try_lease(p_token_hash text, p_stage text, p_seconds integer) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.lease_parse_job_v1(p_token_hash, p_stage, p_seconds);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_dispatch(p_hash text, p_limit integer) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform o_processed from job_api.dispatch_outbox_v1(p_hash, p_limit);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

select ok(
  has_function_privilege('toi_job_api', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute'),
  '1 toi_job_api holds EXECUTE on lease_parse_job_v1 after publish replace'
);

select is(
  (select count(*)::text from (
     select 1 where has_function_privilege('anon', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute')
     union all
     select 1 where has_function_privilege('authenticated', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute')
     union all
     select 1 where has_function_privilege('service_role', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute')
   ) s),
  '0',
  '2 request roles and service_role cannot lease (#142)'
);

select ok(
  has_function_privilege('toi_job_api', 'job_api.dispatch_outbox_v1(text,integer)', 'execute'),
  '3 toi_job_api holds EXECUTE on dispatch_outbox_v1 after replace'
);

insert into job_api.worker_credentials (label, token_hash, executor, organisations, revoked_at) values
  ('syn-t113-pub-cloud-c1', pg_temp.syn_hash('cloud-c1'), 'cloud_worker',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null),
  ('syn-t113-pub-box-c1', pg_temp.syn_hash('box-c1'), 'local_box',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null);

insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000004801', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-pub-s4801',
   '00000000-0000-4000-8000-0000000000a1');

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text
) values (
  '71000000-0000-4000-8000-000000004801', '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-000000004801', '51000000-0000-4000-8000-000000000001', 1,
  '00000000-0000-4000-8000-0000000000a1', 'internal', pg_temp.syn_hash('s4801v1'),
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004801/v1.pdf',
  'indexing', 'v1', null
);

-- attempt >= 1 on every fixture row (lease/complete history, not a virgin insert).
insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class,
  parser_generation, index_generation, attempt, lease_fence, created_at
) values
  ('95000000-0000-4000-8000-000000004801',
   '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000004801',
   'index', 'cloud_worker', 'succeeded', 'internal',
   'v1', 1, 1, 1, now() - interval '1 hour'),
  ('95000000-0000-4000-8000-000000004802',
   '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000004801',
   'publish', 'cloud_worker', 'queued', 'internal',
   'v1', 1, 1, 0, now() - interval '5 minutes');

create temp table t_lease (
  found boolean, job_id uuid, stage text, executor text, lease_token text, fence bigint
);
create temp table t_out (case_name text, result text);

insert into t_lease
  select o_found, o_job_id, o_stage, o_executor, o_lease_token, o_fence
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'publish', 300);

select is((select found::text from t_lease), 'true',
  '4 cloud_worker credential leases a publish job');
select is((select stage from t_lease), 'publish',
  '5 the leased row is stage=publish');
select is((select job_id::text from t_lease), '95000000-0000-4000-8000-000000004802',
  '6 it is the queued publish job, not the succeeded index row');
select is((select executor from t_lease), 'cloud_worker',
  '7 publish leases are cloud_worker only');

insert into t_out
  select 'box_publish', case when o_found then 'found' else 'empty' end
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'publish', 300);
select is((select result from t_out where case_name = 'box_publish'), 'empty',
  '8 local_box credential finds no publish work');

insert into t_out values
  ('bad_stage', pg_temp.try_lease(pg_temp.syn_hash('cloud-c1'), 'validate', 300));
select is((select result from t_out where case_name = 'bad_stage'), '22023',
  '9 stages outside extract/index/publish stay refused at the lease gate');

-- Outbox: index_succeeded → enqueue publish (fresh version so the stage key is free).
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000004802', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-pub-s4802',
   '00000000-0000-4000-8000-0000000000a1');

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text
) values (
  '71000000-0000-4000-8000-000000004802', '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-000000004802', '51000000-0000-4000-8000-000000000001', 1,
  '00000000-0000-4000-8000-0000000000a1', 'internal', pg_temp.syn_hash('s4802v1'),
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004802/v1.pdf',
  'indexing', 'v1', null
);

insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class,
  parser_generation, index_generation, attempt, lease_fence, created_at
) values (
  '95000000-0000-4000-8000-000000004803',
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-000000004802',
  'index', 'cloud_worker', 'succeeded', 'internal',
  'v1', 1, 1, 1, now() - interval '30 minutes'
);

insert into public.outbox_events (
  id, organisation_id, event_type, aggregate_type, aggregate_id, payload, created_at
) values (
  'a1000000-0000-4000-8000-000000004801',
  '11111111-1111-4111-8111-111111111111',
  'knowledge.ingestion_job.index_succeeded',
  'ingestion_job',
  '95000000-0000-4000-8000-000000004803',
  jsonb_build_object(
    'job_id', '95000000-0000-4000-8000-000000004803',
    'source_version_id', '71000000-0000-4000-8000-000000004802',
    'index_generation', 1
  ),
  now() - interval '10 minutes'
);

create temp table t_dispatch as
  select o_processed, o_enqueued, o_skipped
    from job_api.dispatch_outbox_v1(pg_temp.syn_hash('cloud-c1'), 32);

select is((select o_processed::text from t_dispatch), '1',
  '10 cloud dispatcher processes the pending index_succeeded row');
select is((select o_enqueued::text from t_dispatch), '1',
  '11 and enqueues a publish-stage job under the stage key');
select is(
  (select count(*)::text from public.ingestion_jobs
    where source_version_id = '71000000-0000-4000-8000-000000004802'
      and stage = 'publish'
      and status = 'queued'
      and executor = 'cloud_worker'),
  '1',
  '12 the enqueued row is stage=publish, executor=cloud_worker, status=queued'
);
select ok(
  (select processed_at is not null from public.outbox_events
    where id = 'a1000000-0000-4000-8000-000000004801'),
  '13 the index_succeeded outbox row is marked processed_at'
);

-- Idempotent second drain: already-enqueued publish is a skip, not a duplicate.
create temp table t_dispatch2 as
  select o_processed, o_enqueued, o_skipped
    from job_api.dispatch_outbox_v1(pg_temp.syn_hash('cloud-c1'), 32);
select is((select o_processed::text from t_dispatch2), '0',
  '14 a second drain finds nothing pending');

-- pg_temp is session-local (045 idiom): grant so authenticated can record its own SQLSTATE.
grant insert, select on t_out to authenticated;
set local role authenticated;
insert into t_out values (
  'auth_dispatch',
  pg_temp.try_dispatch(pg_temp.syn_hash('cloud-c1'), 8)
);
reset role;
select is((select result from t_out where case_name = 'auth_dispatch'), '42501',
  '15 authenticated cannot call dispatch_outbox_v1 at runtime');

select is(
  (select count(*)::text from (
     select 1 where has_function_privilege('anon', 'job_api.dispatch_outbox_v1(text,integer)', 'execute')
     union all
     select 1 where has_function_privilege('authenticated', 'job_api.dispatch_outbox_v1(text,integer)', 'execute')
   ) s),
  '0',
  '16 request roles still cannot dispatch'
);

select * from finish();
rollback;
