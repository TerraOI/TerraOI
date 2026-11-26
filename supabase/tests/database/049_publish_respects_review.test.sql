-- TOI-013: the worker publish path honours T-213's publication rule
-- (supabase/migrations/20261126210000_publish_respects_review.sql). Slot 049, next to 048.
-- Synthetic fixtures only (AGENTS.md §4.7). Runs as the owner, like 045/047/048.
begin;
create extension if not exists pgtap with schema extensions;

select plan(18);

create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('toi013-' || p_seed) || md5('toi013-' || p_seed || '-tail');
$fn$;

select ok(has_function_privilege('toi_job_api', 'job_api.publish_version_v1(text,uuid,text,bigint,uuid,integer)', 'execute'),
  '1 toi_job_api keeps EXECUTE on the publish signature the workers call');
select ok(not has_function_privilege('toi_job_api', 'job_api.publish_version_core_v1(text,uuid,text,bigint,uuid,integer)', 'execute')
          and not has_function_privilege('authenticated', 'job_api.publish_version_core_v1(text,uuid,text,bigint,uuid,integer)', 'execute'),
  '2 nobody but the owner can reach the unguarded body');

insert into job_api.worker_credentials (label, token_hash, executor, organisations, revoked_at) values
  ('syn-toi013-cloud-c1', pg_temp.syn_hash('cloud-c1'), 'cloud_worker', array['11111111-1111-4111-8111-111111111111']::uuid[], null);

-- s1: an upload in the tenant-wide public collection (no auto_publish) → must wait for review.
-- s2: a note in a collection switched to auto_publish → publishes without a decision.
-- s3: a client_confidential upload in Site A (independent review) → must wait for review.
update public.knowledge_collections set auto_publish = true where id = '51000000-0000-4000-8000-000000000001';
insert into public.knowledge_collections (id, organisation_id, key, service_key, project_id, name, data_class, auto_publish) values
  ('51000000-0000-4000-8000-000000004901', '11111111-1111-4111-8111-111111111111', 'toi013-manuals', 'uav-compliance', null,
   'TOI-013 manuals (synthetic)', 'internal', false);
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000004901', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000004901', 'upload', 'syn-toi013-s1', '00000000-0000-4000-8000-0000000000a2'),
  ('61000000-0000-4000-8000-000000004902', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'note', null, '00000000-0000-4000-8000-0000000000a2'),
  ('61000000-0000-4000-8000-000000004903', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000002', 'upload', 'syn-toi013-s3', '00000000-0000-4000-8000-0000000000a1');
insert into public.source_versions (id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
                                    content_hash, object_ref, state, parser_generation, body_text) values
  ('71000000-0000-4000-8000-000000004901', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000004901', '51000000-0000-4000-8000-000000004901', 1,
   '00000000-0000-4000-8000-0000000000a2', 'internal', pg_temp.syn_hash('v1'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004901/v1.pdf', 'indexing', 'v1', null),
  ('71000000-0000-4000-8000-000000004902', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000004902', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a2', 'internal', pg_temp.syn_hash('v2'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004902/v1.json', 'indexing', 'v1', 'Synthetic note.'),
  ('71000000-0000-4000-8000-000000004903', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000004903', '51000000-0000-4000-8000-000000000002', 1,
   '00000000-0000-4000-8000-0000000000a1', 'client_confidential', pg_temp.syn_hash('v3'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004903/v1.pdf', 'indexing', 'v1', null);
insert into public.knowledge_chunks (id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count) values
  ('81000000-0000-4000-8000-000000004901', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004901', 0, '{"page":1}', 'Synthetic TOI-013 chunk one.', 'internal', 5),
  ('81000000-0000-4000-8000-000000004902', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004902', 0, '{"page":1}', 'Synthetic TOI-013 note chunk.', 'internal', 5),
  ('81000000-0000-4000-8000-000000004903', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004903', 0, '{"page":1}', 'Synthetic TOI-013 Site A chunk.', 'client_confidential', 5);
insert into public.ingestion_jobs (id, organisation_id, source_version_id, stage, executor, status, data_class,
                                   parser_generation, index_generation, attempt, lease_fence, created_at)
select ('95000000-0000-4000-8000-0000000049' || n || '1')::uuid, '11111111-1111-4111-8111-111111111111'::uuid,
       ('71000000-0000-4000-8000-00000000490' || n)::uuid, 'index', 'cloud_worker', 'succeeded',
       case n when 3 then 'client_confidential' else 'internal' end, 'v1', 1, 1, 1, now() - interval '1 hour'
  from generate_series(1, 3) n
union all
select ('95000000-0000-4000-8000-0000000049' || n || '2')::uuid, '11111111-1111-4111-8111-111111111111'::uuid,
       ('71000000-0000-4000-8000-00000000490' || n)::uuid, 'publish', 'cloud_worker', 'queued',
       case n when 3 then 'client_confidential' else 'internal' end, 'v1', 1, 1, 0, now() - interval '5 minutes' - (n || ' minutes')::interval
  from generate_series(1, 3) n;

create temp table t_lease (job_id uuid, version_id uuid, lease_token text, fence bigint);
create temp table t_pub (case_name text, outcome text, previous uuid);

-- Lease all three publish jobs (oldest first).
insert into t_lease select o_job_id, o_source_version_id, o_lease_token, o_fence
  from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'publish', 300);
insert into t_lease select o_job_id, o_source_version_id, o_lease_token, o_fence
  from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'publish', 300);
insert into t_lease select o_job_id, o_source_version_id, o_lease_token, o_fence
  from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'publish', 300);
select is((select count(distinct version_id)::int from t_lease where version_id::text like '71000000-0000-4000-8000-00000000490%'), 3,
  '3 the three publish jobs lease');

create function pg_temp.publish(p_case text, p_version uuid) returns void language plpgsql as $fn$
begin
  insert into t_pub
    select p_case, o_outcome, o_previous_version_id
      from t_lease l, job_api.publish_version_v1(pg_temp.syn_hash('cloud-c1'), l.job_id, l.lease_token, l.fence, l.version_id, 1)
     where l.version_id = p_version;
end;
$fn$;

select pg_temp.publish('upload', '71000000-0000-4000-8000-000000004901');
select is((select outcome from t_pub where case_name = 'upload'), 'awaiting_review',
  '4 an unreviewed upload is not published by the worker');
select is((select v.state || '/' || coalesce(s.current_version_id::text, 'none')
             from public.source_versions v join public.knowledge_sources s on s.id = v.source_id
            where v.id = '71000000-0000-4000-8000-000000004901'),
  'awaiting_review/none', '5 …it is parked in awaiting_review and no pointer moved');
select is((select status from public.ingestion_jobs where id = '95000000-0000-4000-8000-000000004912'), 'succeeded',
  '6 …and the publish job is finished, so it does not sit leased');
select pg_temp.publish('upload_replay', '71000000-0000-4000-8000-000000004901');
select is((select outcome from t_pub where case_name = 'upload_replay'), 'awaiting_review',
  '7 a replay of the same stage key answers the same way');

select pg_temp.publish('note', '71000000-0000-4000-8000-000000004902');
select is((select outcome from t_pub where case_name = 'note'), 'published',
  '8 a low-risk note in an auto_publish collection publishes without a decision (§7.2 step 7)');
select is((select state from public.source_versions where id = '71000000-0000-4000-8000-000000004902'), 'published',
  '9 …through the unchanged T-113 body');

select pg_temp.publish('confidential', '71000000-0000-4000-8000-000000004903');
select is((select outcome from t_pub where case_name = 'confidential'), 'awaiting_review',
  '10 a client_confidential upload waits for independent review even beside an auto_publish collection');

-- The parked upload then goes through T-213: a non-uploader reviewer approves and publishes.
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
select lives_ok($q$ select public.review_decision_v1('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004901', 'approve', null) $q$,
  '11 a reviewer approves the parked version');
select set_config('app.organisation_id', '', true);
select lives_ok($q$ select public.publish_knowledge_version_v1('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004901') $q$,
  '12 …and publishes it on the employee path');
reset role;
select is((select v.state || '/' || (s.current_version_id = v.id)::text
             from public.source_versions v join public.knowledge_sources s on s.id = v.source_id
            where v.id = '71000000-0000-4000-8000-000000004901'),
  'published/true', '13 the reviewed version is now the published pointer');

-- An approved version leased by the worker publishes through the body.
insert into public.knowledge_review_decisions (organisation_id, source_version_id, decision, reviewer_user_id)
values ('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004903', 'approve', '00000000-0000-4000-8000-0000000000a4');
update public.ingestion_jobs set status = 'queued', lease_token = null, lease_expires_at = null, completed_at = null
 where id = '95000000-0000-4000-8000-000000004932';
update public.source_versions set state = 'indexing' where id = '71000000-0000-4000-8000-000000004903';
delete from t_lease where version_id = '71000000-0000-4000-8000-000000004903';
insert into t_lease select o_job_id, o_source_version_id, o_lease_token, o_fence
  from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'publish', 300);
select pg_temp.publish('confidential_approved', '71000000-0000-4000-8000-000000004903');
select is((select outcome from t_pub where case_name = 'confidential_approved'), 'published',
  '14 once approved, the worker path publishes the same version');

-- ---------------------------------------------------------------- 15-18 parking never bypasses a gate
-- s4: unreviewed upload whose index job has NOT succeeded; s5: unreviewed upload, quarantined.
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000004904', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000004901', 'upload', 'syn-toi013-s4', '00000000-0000-4000-8000-0000000000a2'),
  ('61000000-0000-4000-8000-000000004905', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000004901', 'upload', 'syn-toi013-s5', '00000000-0000-4000-8000-0000000000a2');
insert into public.source_versions (id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
                                    content_hash, object_ref, state, parser_generation, body_text) values
  ('71000000-0000-4000-8000-000000004904', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000004904', '51000000-0000-4000-8000-000000004901', 1,
   '00000000-0000-4000-8000-0000000000a2', 'internal', pg_temp.syn_hash('v4'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004904/v1.pdf', 'indexing', 'v1', null),
  ('71000000-0000-4000-8000-000000004905', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000004905', '51000000-0000-4000-8000-000000004901', 1,
   '00000000-0000-4000-8000-0000000000a2', 'internal', pg_temp.syn_hash('v5'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000004905/v1.pdf', 'quarantined', 'v1', null);
insert into public.knowledge_chunks (id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count) values
  ('81000000-0000-4000-8000-000000004904', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004904', 0, '{"page":1}', 'Synthetic TOI-013 chunk four.', 'internal', 5),
  ('81000000-0000-4000-8000-000000004905', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004905', 0, '{"page":1}', 'Synthetic TOI-013 chunk five.', 'internal', 5);
insert into public.ingestion_jobs (id, organisation_id, source_version_id, stage, executor, status, data_class,
                                   parser_generation, index_generation, attempt, lease_fence, created_at) values
  ('95000000-0000-4000-8000-000000004941', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004904',
   'index', 'cloud_worker', 'failed', 'internal', 'v1', 1, 1, 1, now() - interval '1 hour'),
  ('95000000-0000-4000-8000-000000004942', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004904',
   'publish', 'cloud_worker', 'queued', 'internal', 'v1', 1, 1, 0, now() - interval '20 minutes'),
  ('95000000-0000-4000-8000-000000004951', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004905',
   'index', 'cloud_worker', 'succeeded', 'internal', 'v1', 1, 1, 1, now() - interval '1 hour'),
  ('95000000-0000-4000-8000-000000004952', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000004905',
   'publish', 'cloud_worker', 'queued', 'internal', 'v1', 1, 1, 0, now() - interval '19 minutes');
insert into t_lease select o_job_id, o_source_version_id, o_lease_token, o_fence
  from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'publish', 300);
insert into t_lease select o_job_id, o_source_version_id, o_lease_token, o_fence
  from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'publish', 300);

create function pg_temp.try_publish(p_version uuid, p_token_override text default null) returns text language plpgsql as $fn$
begin
  perform 1 from t_lease l, job_api.publish_version_v1(pg_temp.syn_hash('cloud-c1'), l.job_id,
                   coalesce(p_token_override, l.lease_token), l.fence, l.version_id, 1)
   where l.version_id = p_version;
  return 'ok';
exception when others then
  return sqlstate;
end;
$fn$;

select is(pg_temp.try_publish('71000000-0000-4000-8000-000000004904'), '55000',
  '15 an unreviewed version whose index did not succeed is refused, not parked');
select is((select state from public.source_versions where id = '71000000-0000-4000-8000-000000004904'), 'indexing',
  '16 …and stays out of the review queue');
select is(pg_temp.try_publish('71000000-0000-4000-8000-000000004905', 'forged-lease-token'), '42501',
  '17 a wrong lease token on the park path is refused');
select is(pg_temp.try_publish('71000000-0000-4000-8000-000000004905'), '42501',
  '18 a quarantined version is never parked for review');

select * from finish();
rollback;
