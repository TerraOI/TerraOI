-- T-113 follow-up: index-stage lease + artifacts_for_lease_v1
-- (supabase/migrations/20261126190000_index_stage_lease.sql).
-- Plan §7.2; #134 credential compare; FAQ-0010 privilege surface.
-- Synthetic fixtures only. Privileged paths run as the test role (postgres), matching
-- 045's idiom: job_api RPCs are SECURITY DEFINER and EXECUTE is granted only to
-- toi_job_api — request-role negatives use `set local role authenticated` + try_* helpers.
-- Do not `set local role toi_job_api` here: the test runner is not IN ROLE toi_job_api
-- (see 100_lifecycle's explicit `grant … to postgres` pattern; 045 never needs it).

begin;
create extension if not exists pgtap with schema extensions;

select plan(18);

create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t113-idx-lease-' || p_seed) || md5('t113-idx-lease-' || p_seed || '-tail');
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

create function pg_temp.try_artifacts(
  p_token_hash text, p_job_id uuid, p_lease_token text, p_fence bigint
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.artifacts_for_lease_v1(p_token_hash, p_job_id, p_lease_token, p_fence);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

select ok(
  has_function_privilege(
    'toi_job_api',
    'job_api.artifacts_for_lease_v1(text,uuid,text,bigint)',
    'execute'
  ),
  '1 toi_job_api holds EXECUTE on artifacts_for_lease_v1'
);

select is(
  (select count(*)::text from (
     select 1 where has_function_privilege('anon', 'job_api.artifacts_for_lease_v1(text,uuid,text,bigint)', 'execute')
     union all
     select 1 where has_function_privilege('authenticated', 'job_api.artifacts_for_lease_v1(text,uuid,text,bigint)', 'execute')
     union all
     select 1 where has_function_privilege('service_role', 'job_api.artifacts_for_lease_v1(text,uuid,text,bigint)', 'execute')
   ) s),
  '0',
  '2 anon, authenticated and service_role cannot execute artifacts_for_lease_v1 (#142)'
);

select is(
  (select n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'artifacts_for_lease_v1' limit 1),
  'job_api',
  '3 artifacts_for_lease_v1 lives in job_api, not public'
);

insert into job_api.worker_credentials (label, token_hash, executor, organisations, revoked_at) values
  ('syn-t113-idx-cloud-c1', pg_temp.syn_hash('cloud-c1'), 'cloud_worker',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null),
  ('syn-t113-idx-box-c1', pg_temp.syn_hash('box-c1'), 'local_box',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null);

insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000004701', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'syn-t113-idx-s4701',
   '00000000-0000-4000-8000-0000000000a1');

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text
) values (
  '71000000-0000-4000-8000-000000004701', '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-000000004701', '51000000-0000-4000-8000-000000000001', 1,
  '00000000-0000-4000-8000-0000000000a1', 'internal', pg_temp.syn_hash('s4701v1'),
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004701/v1.pdf',
  'extracting', 'v1', null
);

insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class,
  parser_generation, index_generation, attempt, lease_fence, created_at
) values
  ('95000000-0000-4000-8000-000000004701',
   '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000004701',
   'extract', 'cloud_worker', 'succeeded', 'internal',
   'v1', 1, 1, 1, now() - interval '1 hour'),
  ('95000000-0000-4000-8000-000000004702',
   '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000004701',
   'index', 'cloud_worker', 'queued', 'internal',
   'v1', 1, 1, 0, now() - interval '5 minutes');

insert into public.extraction_artifacts (
  organisation_id, source_version_id, job_id, stage, parser_generation, index_generation,
  artifact_index, locator, body_text, producer, data_class, fence
) values (
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-000000004701',
  '95000000-0000-4000-8000-000000004701',
  'extract', 'v1', 1, 0,
  '{"page":1}'::jsonb,
  'Synthetic extract body for the index lease reader.',
  'cloud_worker', 'internal', 1
);

create temp table t_lease (
  found boolean, job_id uuid, stage text, lease_token text, fence bigint
);
create temp table t_out (case_name text, result text);

insert into t_lease
  select o_found, o_job_id, o_stage, o_lease_token, o_fence
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'index', 300);

select is((select found::text from t_lease), 'true',
  '4 cloud_worker credential leases an index job');
select is((select stage from t_lease), 'index',
  '5 the leased row is stage=index');
select is((select job_id::text from t_lease), '95000000-0000-4000-8000-000000004702',
  '6 it is the queued index job, not the succeeded extract row');

insert into t_out
  select 'box_index', case when o_found then 'found' else 'empty' end
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'index', 300);
select is((select result from t_out where case_name = 'box_index'), 'empty',
  '7 local_box credential finds no index work (index is cloud_worker only)');

insert into t_out values
  ('publish', pg_temp.try_lease(pg_temp.syn_hash('cloud-c1'), 'publish', 300));
select is((select result from t_out where case_name = 'publish'), '22023',
  '8 publish stage remains refused at the lease gate');

create temp table t_art as
  select o_found, o_artifact_index, o_body_text, o_locator
    from job_api.artifacts_for_lease_v1(
      pg_temp.syn_hash('cloud-c1'),
      (select job_id from t_lease),
      (select lease_token from t_lease),
      (select fence from t_lease)
    );

select is((select o_found::text from t_art limit 1), 'true',
  '9 artifacts_for_lease_v1 returns extract rows for the leased index job');
select is((select count(*)::text from t_art), '1',
  '10 exactly one extract artifact is returned');
select is((select o_body_text from t_art), 'Synthetic extract body for the index lease reader.',
  '11 body_text is the extract artifact text');
select is((select (o_locator ->> 'page') from t_art), '1',
  '12 locator page survives the read');

create temp table t_art_bad as
  select o_found
    from job_api.artifacts_for_lease_v1(
      pg_temp.syn_hash('cloud-c1'),
      (select job_id from t_lease),
      (select lease_token from t_lease),
      (select fence from t_lease) + 1
    );
select is((select o_found::text from t_art_bad), 'false',
  '13 a superseded fence answers o_found = false with no existence signal');

-- pg_temp is session-local (045 idiom): grant so authenticated can record its own SQLSTATE.
grant insert, select on t_out to authenticated;
set local role authenticated;
insert into t_out values (
  'auth_art',
  pg_temp.try_artifacts(
    pg_temp.syn_hash('cloud-c1'),
    '95000000-0000-4000-8000-000000004702',
    'token', 1
  )
);
reset role;
select is((select result from t_out where case_name = 'auth_art'), '42501',
  '14 authenticated cannot call artifacts_for_lease_v1 at runtime');

truncate t_lease;
insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class,
  parser_generation, index_generation, attempt, lease_fence, created_at
) values (
  '95000000-0000-4000-8000-000000004703',
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-000000004701',
  'extract', 'local_box', 'queued', 'internal',
  'v1-box', 1, 1, 0, now()
);

insert into t_lease
  select o_found, o_job_id, o_stage, o_lease_token, o_fence
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'extract', 300);
select is((select found::text from t_lease), 'true',
  '15 extract lease path is unchanged for local_box');
select is((select stage from t_lease), 'extract',
  '16 leased stage is still extract');

select ok(
  has_function_privilege('toi_job_api', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute'),
  '17 toi_job_api still holds EXECUTE on lease_parse_job_v1 after replace'
);

select is(
  (select count(*)::text from (
     select 1 where has_function_privilege('anon', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute')
     union all
     select 1 where has_function_privilege('authenticated', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute')
   ) s),
  '0',
  '18 request roles still cannot lease'
);

select * from finish();
rollback;
