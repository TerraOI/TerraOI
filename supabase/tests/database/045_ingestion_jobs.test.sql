-- T-211 PR-1 — the job API, the artifact home and the reconciler
-- (supabase/migrations/20261109230000_ocr_job_leases.sql). Plan §7.2 (extraction executors), §7.5
-- (bounded retries, dead letter, reconciler), §13 (the box is outbound-only), §12.4; F12, F32.
-- Rulings pinned here: #99 (max_attempts, inline reclaim, `failed` as the dead letter, the reconciler,
-- duplicate dispatch), #134 (the credential digest inside the same compare as tenant, version, stage,
-- token and fence; retarget owned by the cloud worker), #135 (a credential carries exactly one
-- executor), #146 (object_ref_for_lease_v1 refuses a foreign tenant, an expired lease, a stale fence
-- and a revoked credential), #51 (artifacts keyed by the job's generations), #66 (retarget is an
-- UPDATE against the existing row, never a second job row).
--
-- Structure follows the supervisor's review of PR #12 (B5), as 040 does: every mutation a worker or a
-- member must not be able to make is asserted under that role, and the privileged-path assertions pin
-- the guard trigger, so dropping a grant or a guard fails a test instead of passing quietly. No psql
-- meta-commands and no dynamic SQL: pg_prove executes this file, so every call is a plain SQL call
-- through a SECURITY INVOKER helper that reports the SQLSTATE.
--
-- Fixtures are inserted in this transaction and rolled back with it. `created_at` is explicit on every
-- job row because the lease is `order by created_at limit 1` and a test that names the job taken must
-- depend on the fixture, not on the clock. The load-bearing assertions name ids and counts rather
-- than accepting an empty result: `is_empty` alone would also pass if a fixture had failed to insert.
--
-- Synthetic hashes only (AGENTS.md §4.7): doubled md5 of a marker string, the 64-hex shape the column
-- requires. They are digests of nothing; no real credential exists in this repository.
begin;
create extension if not exists pgtap with schema extensions;

-- Each pgTAP file is its own `begin; … rollback;`, and `supabase test db` runs the directory in file
-- name order (000 → 045 → 050), so this file sees the seed and every earlier file's rollback.
-- `plan(131)` equals the number of assertions this file executes: 131 numbered messages, 1..131, each
-- one top-level assertion statement. Verified mechanically against the file before pushing; #143's
-- review this morning was the plan-count trap, and `is(have, want)` is the argument order used here.
select plan(133);

-- ---------------------------------------------------------------- helpers
create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t211-synthetic-' || p_seed) || md5('t211-synthetic-' || p_seed || '-tail');
$fn$;

-- SECURITY INVOKER on purpose: the RPCs are SECURITY DEFINER, but a call made under a request role
-- has to surface a missing grant as a SQLSTATE instead of a pass (the 040 idiom).
create function pg_temp.try_scope(p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.set_tenant_scope(p_organisation_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
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

create function pg_temp.try_renew(p_token_hash text, p_job_id uuid, p_lease_token text,
                                  p_fence bigint, p_seconds integer) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.renew_parse_lease_v1(p_token_hash, p_job_id, p_lease_token,
                                                p_fence, p_seconds);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_complete(p_token_hash text, p_job_id uuid, p_lease_token text,
                                     p_fence bigint, p_source_version_id uuid, p_stage text,
                                     p_index_generation integer, p_artifacts jsonb) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.complete_parse_job_v1(p_token_hash, p_job_id, p_lease_token, p_fence,
                                                 p_source_version_id, p_stage, p_index_generation,
                                                 p_artifacts, null, null);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_abort(p_token_hash text, p_job_id uuid, p_lease_token text,
                                  p_fence bigint, p_reason text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.abort_parse_job_v1(p_token_hash, p_job_id, p_lease_token, p_fence, p_reason);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_retarget(p_token_hash text, p_job_id uuid, p_lease_token text,
                                     p_fence bigint, p_reason text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.retarget_extract_job_v1(p_token_hash, p_job_id, p_lease_token,
                                                   p_fence, p_reason);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_objref(p_token_hash text, p_job_id uuid, p_lease_token text,
                                   p_fence bigint) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.object_ref_for_lease_v1(p_token_hash, p_job_id, p_lease_token, p_fence);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Direct writes, for the constraints that must hold whatever the caller: the fence CHECK, and the
-- artifact table's own guard, CHECKs and unique key.
create function pg_temp.try_fence_lower(p_job_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.ingestion_jobs set lease_fence = -1 where id = p_job_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_artifact_insert(p_organisation_id uuid, p_source_version_id uuid,
                                            p_class text, p_parser_generation text,
                                            p_artifact_index integer) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.extraction_artifacts (
      organisation_id, source_version_id, stage, parser_generation, index_generation,
      artifact_index, body_text, producer, data_class, fence
    ) values (
      p_organisation_id, p_source_version_id, 'extract', p_parser_generation, 1,
      p_artifact_index, 'Synthetic probe text, never stored (the write below is expected to fail).',
      'local_box', p_class, 0
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_artifact_update(p_source_version_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.extraction_artifacts
       set body_text = 'edited in place, which the guard must refuse'
     where source_version_id = p_source_version_id and artifact_index = 0;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- ---------------------------------------------------------------- fixtures
-- Two extra versions so the artifact and reconciler arms have rows of their own: V9 in `extracting`
-- with a job, V10 in `extracting` with **no** job at all (the `missing_job` finding). Column list
-- mirrors supabase/seed.sql:145-172, the shape the merged version triggers accept.
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000000009', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'synthetic-t211-scan-0009',
   '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000000010', '11111111-1111-4111-8111-111111111111',
   '51000000-0000-4000-8000-000000000001', 'upload', 'synthetic-t211-scan-0010',
   '00000000-0000-4000-8000-0000000000a1');

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text
) values
  ('71000000-0000-4000-8000-000000000009', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000000009', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('v9'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000009/v9.pdf',
   'extracting', 'v1', null),
  ('71000000-0000-4000-8000-000000000010', '11111111-1111-4111-8111-111111111111',
   '61000000-0000-4000-8000-000000000010', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('v10'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000010/v10.pdf',
   'extracting', 'v1', null);

-- Credentials: one executor and one tenant each, plus a revoked one. #134's "one credential per
-- executor" is this row's `executor` column, and #135's isolation follows straight from it.
insert into job_api.worker_credentials (label, token_hash, executor, organisations, revoked_at) values
  ('syn-box-company1', pg_temp.syn_hash('box-c1'), 'local_box',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null),
  ('syn-box-company2', pg_temp.syn_hash('box-c2'), 'local_box',
   array['22222222-2222-4222-8222-222222222222']::uuid[], null),
  ('syn-cloud-company1', pg_temp.syn_hash('cloud-c1'), 'cloud_worker',
   array['11111111-1111-4111-8111-111111111111']::uuid[], null),
  ('syn-box-revoked', pg_temp.syn_hash('box-revoked'), 'local_box',
   array['11111111-1111-4111-8111-111111111111']::uuid[], now());

-- Job fixtures. The stage-key columns (organisation, version, stage, parser_generation,
-- index_generation) are distinct from supabase/seed.sql:230-240 by construction.
insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class, parser_generation,
  index_generation, attempt, lease_token, lease_expires_at, lease_fence, created_at
) values
  -- the oldest company1 box job: the first lease box1 is expected to take
  ('95000000-0000-4000-8000-0000000000a1', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000000001', 'extract', 'local_box', 'queued', 'public', 't211a', 1,
   1, null, null, 0, now() - interval '30 minutes'),
  -- company1's cloud job: complete / object_ref / retarget target
  ('95000000-0000-4000-8000-0000000000a2', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000000001', 'extract', 'cloud_worker', 'queued', 'public', 't211b', 1,
   1, null, null, 0, now() - interval '18 minutes'),
  -- company2's box job: invisible to company1's credential
  ('95000000-0000-4000-8000-0000000000a3', '22222222-2222-4222-8222-222222222222',
   '72000000-0000-4000-8000-000000000001', 'extract', 'local_box', 'queued', 'client_confidential',
   't211c', 1, 1, null, null, 0, now() - interval '17 minutes'),
  -- expired lease over the attempt cap: the sweep dead-letters it
  ('95000000-0000-4000-8000-0000000000a4', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000000001', 'extract', 'cloud_worker', 'leased', 'public', 't211d', 1,
   6, 'expired-holder-token-aaaaaaaa', now() - interval '20 minutes', 7, now() - interval '3 days'),
  -- expired lease under the cap: the sweep reclaims it, and the fence bump is what refuses the
  -- abandoned holder afterwards
  ('95000000-0000-4000-8000-0000000000a5', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000000009', 'extract', 'cloud_worker', 'leased', 'public', 't211e', 1,
   5, 'abandoned-holder-token-bbb', now() - interval '10 minutes', 5, now() - interval '4 days'),
  -- queued but over the cap (a crafted state: the sweep only moves leased/running rows). Oldest of
  -- all, so if the cap arm were dropped the very first cloud lease would name this job instead.
  ('95000000-0000-4000-8000-0000000000a6', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000000001', 'extract', 'cloud_worker', 'queued', 'public', 't211f', 1,
   6, null, null, 0, now() - interval '4 hours'),
  -- a client_confidential box job on the project-scoped version: the box clears the class, and the
  -- artifact set it writes is what the member-side RLS assertions then read
  ('95000000-0000-4000-8000-0000000000a7', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000000002', 'extract', 'local_box', 'queued', 'client_confidential',
   't211g', 1, 1, null, null, 0, now() - interval '5 minutes'),
  -- a non-extraction stage, to pin that this API never leases one
  ('95000000-0000-4000-8000-0000000000a8', '11111111-1111-4111-8111-111111111111',
   '71000000-0000-4000-8000-000000000001', 'index', 'cloud_worker', 'queued', 'public', 't211h', 1,
   1, null, null, 0, now() - interval '2 minutes');

-- Result tables. Everything below is filled by postgres — the job-API functions are granted to
-- `toi_job_api` and to no request role, so a member's attempt to reach them is asserted through a
-- helper's SQLSTATE, and a member's read of an artifact is asserted by the query itself, under RLS.
create temp table t_lease (n int, found boolean, job_id uuid, organisation_id uuid,
                          source_version_id uuid, stage text, executor text, parser_generation text,
                          index_generation int, data_class text, lease_token text, fence bigint,
                          attempt int);
create temp table t_done (case_name text, outcome text, artifact_count int, event_id uuid);
create temp table t_act (case_name text, outcome text, executor text, status text, fence bigint,
                         expires_at timestamptz, found boolean, object_ref text, data_class text);
create temp table t_out (case_name text, result text);

-- ================================================================ 1-22 shape and privilege surface
select has_table('public', 'extraction_artifacts',
  '1 the artifact home #51 ruled exists');
select has_column('public', 'ingestion_jobs', 'lease_fence',
  '2 lease_fence is the one column added to the merged job table');
select ok((select count(*) = 1 from pg_constraint
            where conname = 'ingestion_jobs_lease_fence_nonnegative'),
  '3 and it carries its own non-negative constraint rather than a convention inside the RPCs');
insert into t_out values ('fence_negative', pg_temp.try_fence_lower('95000000-0000-4000-8000-0000000000a1'));
select is((select result from t_out where case_name = 'fence_negative'), '23514',
  '4 a negative fence is refused by the constraint, so no later function can invent one');
select ok((select relrowsecurity from pg_class
            where oid = 'public.extraction_artifacts'::regclass),
  '5 the new public table has RLS enabled (000_guardrails, AGENTS §4.2)');
select has_table('job_api', 'worker_credentials',
  '6 the credential table lives in the non-exposed schema, not in public (#134)');
select ok((select count(*) = 2 from pg_attribute
            where attrelid = 'public.extraction_artifacts'::regclass
              and attname in ('fence', 'producer')),
  '7 artifacts record which fence wrote them and which executor produced them (#135)');
select ok((select count(*) = 1 from pg_constraint
            where conname = 'extraction_artifacts_source_version_fk'),
  '8 the tenant boundary is a composite (source_version_id, organisation_id) FK (ADR-0005 §4)');
select is(has_table_privilege('anon', 'public.extraction_artifacts', 'select'), false,
  '9 anon reads no artifact');
select is(has_table_privilege('authenticated', 'public.extraction_artifacts', 'select'), false,
  '10 and no request role holds the read either: nothing on main reads artifact rows yet, so the grant '
  || 'waits for the PR that has a consumer to name it (#149 review; #60''s rule that privilege changes '
  || 'are standalone and visible)');
select is(has_table_privilege('service_role', 'public.extraction_artifacts', 'insert'), false,
  '11 even the service key cannot insert an artifact: complete_parse_job_v1 is the only writer '
  || '(AGENTS §4.2, ADR-0011)');
select is(has_table_privilege('service_role', 'public.ingestion_jobs', 'update'), false,
  '12 and it holds no write on the job row either, which is what keeps the #146 Storage key out of '
  || 'SQL (ADR-0005 §1 Fact 1; precedent 20261105210000_intake_service_role.sql:6-8)');
select is(has_table_privilege('anon', 'job_api.worker_credentials', 'select'), false,
  '13 no request role reads the credential table');
select is(has_table_privilege('authenticated', 'job_api.worker_credentials', 'select'), false,
  '14 not even a signed-in member');
select is(has_table_privilege('service_role', 'job_api.worker_credentials', 'select'), false,
  '15 not the service key');
select is(has_table_privilege('toi_job_api', 'job_api.worker_credentials', 'select'), false,
  '16 and neither does the worker role: the digest is matched inside SECURITY DEFINER functions, so a '
  || 'leaked JOB_DB credential cannot enumerate credentials (ADR-0005 §8)');
select is(has_table_privilege('anon', 'job_api.reconciler_findings', 'select'), false,
  '17 the reconciler is not a request-role surface');
select is(has_table_privilege('authenticated', 'job_api.reconciler_findings', 'select'), false,
  '18 nor a member surface: reconciliation is an owner path, and its dashboard is T-405');
select is(has_table_privilege('toi_job_api', 'job_api.reconciler_findings', 'select'), false,
  '19 a worker fixes its queue by leasing, not by reading the tenant''s whole backlog');
select ok(has_function_privilege('toi_job_api', 'job_api.lease_parse_job_v1(text,text,integer)', 'execute'),
  '20 the worker role is granted EXECUTE by name (FAQ-0010, #134)');
select is_empty($jobapifn$
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'job_api' and p.prokind = 'f'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or has_function_privilege('service_role', p.oid, 'EXECUTE'))
$jobapifn$, '21 no function in job_api is executable by anon, authenticated or service_role: the '
   || 'by-name revoke rule 001 polices in public is applied to the non-exposed schema too');
select is_empty($jobapi$
  select p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'job_api' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                      where c like 'search_path=%')
$jobapi$, '22 every SECURITY DEFINER function in job_api pins search_path, as 000_guardrails requires '
   || 'of public — the guardrail is not scoped to one schema by accident');

-- ================================================================ 23-41 lease: one job at a time,
-- ================================================================ oldest first, right tenant, right
-- ================================================================ executor, bounded input
insert into t_lease
  select 1, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'extract', 300);
select is((select found::text from t_lease where n = 1), 'true', '23 a queued job is leased');
select is((select job_id::text from t_lease where n = 1), '95000000-0000-4000-8000-0000000000a1',
  '24 the oldest eligible job for this credential''s tenants and executor is the one taken, which is '
  || 'a fact of the fixture''s created_at, not of the clock');
select ok(char_length((select lease_token from t_lease where n = 1)) between 8 and 128,
  '25 the issued token fits the merged column CHECK (knowledge_core.sql:374) and the contract bound');
select is((select fence::text from t_lease where n = 1), '1', '26 a lease bumps lease_fence (ADR-0005 §3)');
select is((select attempt::text from t_lease where n = 1), '2',
  '27 and attempt, which stays bookkeeping: outside the stage key on purpose (#68, #16 N3)');
select is((select executor from t_lease where n = 1), 'local_box',
  '28 the lease reports the executor from the row, so a worker cannot be handed a job it may not run');
select is((select status from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a1'), 'leased', '29 the row is now leased');
select ok((select lease_token is not null and lease_expires_at > now() from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a1'),
  '30 the lease pair is written together and expires in the future (knowledge_core.sql:392-393)');
select ok((select lease_fence = 1 and attempt = 2 from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a1'),
  '31 the bumps are on the row, not only in the return value');
-- company1 has exactly two box jobs. The second call must take the other company1 job (a7, the
-- confidential scan) and must **not** take company2's identically-shaped job a3 — the pair of
-- assertions below is the "no cross-tenant existence signal" proof, because lease never names a job:
-- it shows what the credential's view of the queue contains. The third call then reports no work.
insert into t_lease
  select 2, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'extract', 300);
select is((select job_id::text from t_lease where n = 2), '95000000-0000-4000-8000-0000000000a7',
  '32 the second lease for this credential takes the other company1 box job, and the executor and class '
  || 'of that job are no obstacle for the tenant''s own box (plan §13)');
select is((select status || '/' || (lease_token is null)::text from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a3'), 'queued/true',
  '33 company2''s queued box job is still untouched and unleasable by this credential: a job that '
  || 'exists in another tenant is simply not in this view (AGENTS §4.2, #13(2))');
insert into t_lease
  select 3, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'extract', 300);
select is((select found::text from t_lease where n = 3), 'false',
  '34 with both company1 box jobs taken, this credential is told there is nothing to do — the same '
  || 'answer an empty queue gives, and never a hint about the job it cannot see');
-- Renumbering note: box2's own lease is the *fourth* call below, and the two assertions above are why
-- it is needed: it shows a3 is leasable at all, by the right credential.
insert into t_lease
  select 4, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c2'), 'extract', 300);
select is((select job_id::text from t_lease where n = 4), '95000000-0000-4000-8000-0000000000a3',
  '35 company2''s own credential does lease that same job, so the refusal above was tenancy and not '
  || 'the row''s shape');
insert into t_lease
  select 5, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'extract', 300);
select is((select job_id::text from t_lease where n = 5), '95000000-0000-4000-8000-0000000000a5',
  '36 the first cloud lease takes the reclaimed under-cap job and not the older over-cap one: drop '
  || 'the cap arm and this names 9500…a6, which is the starvation ADR-0005 §5b describes');
select is((select parser_generation from t_lease where n = 5), 't211e',
  '37 the lease hands back the generation the worker must complete against, so the completion can be '
  || 'checked rather than trusted');
select is((select status from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a4'), 'failed',
  '38 an expired lease over the cap is dead-lettered to failed — a state, never a deletion (#99)');
select is((select last_error from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a4'), 'retries_exhausted',
  '39 with the named reason the reconciler and T-405 will read');
select ok((select lease_token is null and lease_expires_at is null from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a4'),
  '40 and its lease pair is cleared together');
select is((select status || '/' || attempt::text from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a6'), 'queued/6',
  '41 the sweep only moves leased/running rows: a queued row is left alone, and the cap is enforced at '
  || 'lease time by exclusion, not by rewriting history');
select is((select count(*) from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a6'
              and status = 'queued')::text, '1',
  '42 the capped row stays in the table for a human (and for the reconciler), rather than vanishing');
insert into t_out values
  ('bad_hash', pg_temp.try_lease('not-a-hash', 'extract', 300)),
  ('bad_stage', pg_temp.try_lease(pg_temp.syn_hash('box-c1'), 'index', 300)),
  ('null_stage', pg_temp.try_lease(pg_temp.syn_hash('box-c1'), null, 300)),
  ('lease_short', pg_temp.try_lease(pg_temp.syn_hash('box-c1'), 'extract', 5)),
  ('lease_long', pg_temp.try_lease(pg_temp.syn_hash('box-c1'), 'extract', 7200));
select is((select result from t_out where case_name = 'bad_hash'), '22023',
  '43 a malformed credential digest is a safe input error, decided before any row is read');
select is((select result from t_out where case_name = 'bad_stage')
          || '/' || (select result from t_out where case_name = 'null_stage'), '22023/22023',
  '44 this job API leases extraction only in M1: an index or publish stage is refused rather than left '
  || 'for a worker with no path to it (T-113, T-213)');
select is((select result from t_out where case_name = 'lease_short')
          || '/' || (select result from t_out where case_name = 'lease_long'), '22023/22023',
  '45 lease seconds are bounded, because the reconciler''s stuck threshold is derived from the same '
  || 'maximum and an unbounded lease would make that number meaningless');

-- ================================================================ 44-49 renew
insert into t_act
  select 'renew_ok', o_outcome, null, null, o_fence, o_expires_at, null, null, null
    from job_api.renew_parse_lease_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a1',
         (select lease_token from t_lease where n = 1),
         (select fence from t_lease where n = 1), 600);
select is((select outcome from t_act where case_name = 'renew_ok'), 'renewed',
  '46 the holder can extend its own lease');
select is((select status from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a1'), 'leased',
  '47 renew moves only the expiry, not the state machine');
select ok((select expires_at > now() + interval '5 minutes' from t_act
            where case_name = 'renew_ok'),
  '48 and the new expiry is the requested horizon, server-side, not a clock the worker reports');
insert into t_out values
  ('renew_wrong_token', pg_temp.try_renew(pg_temp.syn_hash('box-c1'),
    '95000000-0000-4000-8000-0000000000a1', 'wrong-lease-token-ccccccccc',
    (select fence from t_lease where n = 1), 600)),
  ('renew_wrong_fence', pg_temp.try_renew(pg_temp.syn_hash('box-c1'),
    '95000000-0000-4000-8000-0000000000a1', (select lease_token from t_lease where n = 1), 99, 600)),
  ('renew_other_tenant', pg_temp.try_renew(pg_temp.syn_hash('box-c1'),
    '95000000-0000-4000-8000-0000000000a3',
    (select lease_token from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'),
    (select lease_fence from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'), 600)),
  ('renew_unknown_job', pg_temp.try_renew(pg_temp.syn_hash('box-c1'),
    '00000000-0000-4000-8000-000000000000', 'anything-at-all-12345678', 1, 600));
select is((select result from t_out where case_name = 'renew_wrong_token'), 'ok',
  '49 note: the RPC answers refused rather than raising, so this helper reports the call succeeding — '
  'the refusal itself is asserted by name in 48-50 below, which is the honest reading of a soft answer');
insert into t_act
  select 'renew_a', o_outcome, null, null, null, null, null, null, null
    from job_api.renew_parse_lease_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a1', 'wrong-lease-token-ccccccccc',
         (select fence from t_lease where n = 1), 600);
insert into t_act
  select 'renew_b', o_outcome, null, null, null, null, null, null, null
    from job_api.renew_parse_lease_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a1', (select lease_token from t_lease where n = 1), 99, 600);
insert into t_act
  select 'renew_c', o_outcome, null, null, null, null, null, null, null
    from job_api.renew_parse_lease_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a3',
         (select lease_token from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'),
         (select lease_fence from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'), 600);
insert into t_act
  select 'renew_d', o_outcome, null, null, null, null, null, null, null
    from job_api.renew_parse_lease_v1(pg_temp.syn_hash('box-c1'),
         '00000000-0000-4000-8000-000000000000', 'anything-at-all-12345678', 1, 600);
select is((select outcome from t_act where case_name = 'renew_a'), 'refused',
  '50 another worker''s lease cannot be renewed with a different lease token');
select is((select outcome from t_act where case_name = 'renew_b'), 'refused',
  '51 nor with a stale fence, even with the right token');
select is((select outcome || '/' || (select outcome from t_act where case_name = 'renew_d') from t_act
            where case_name = 'renew_c'), 'refused/refused',
  '52 company1''s credential cannot renew company2''s live lease, and an unknown job id answers exactly '
  || 'like another tenant''s: renew never reveals which one it was (#134 puts the credential arm in the '
  || 'same statement as the token and fence; knowledge_uploads.sql:368-372 discipline)');

-- ================================================================ 51-67 complete: the only artifact
-- ================================================================ write path, and its idempotency
insert into t_done
  select 'complete_cloud', o_outcome, o_artifact_count, o_event_id
    from job_api.complete_parse_job_v1(
      pg_temp.syn_hash('cloud-c1'), '95000000-0000-4000-8000-0000000000a5',
      (select lease_token from t_lease where n = 5), (select fence from t_lease where n = 5),
      '71000000-0000-4000-8000-000000000009', 'extract', 1,
      '[{"artifact_index":0,"body_text":"Synthetic scanned page one: trace spacing a quarter metre.",
        "locator":{"page":1,"section":"Line one"},"confidence":0.87},
       {"artifact_index":1,"body_text":"Synthetic scanned page two: couplant degraded at chainage 12.",
        "locator":{"page":2,"table":"chainage"}}]'::jsonb,
      '["synthetic parse warning"]'::jsonb, 0.9);
select is((select outcome from t_done where case_name = 'complete_cloud'), 'completed',
  '53 a live lease completes');
select is((select artifact_count::text from t_done where case_name = 'complete_cloud'), '2',
  '54 and reports the set it wrote');
select is((select count(*) from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009')::text, '2',
  '55 two located rows in the table #51 ruled, named by version and counted rather than merely non-empty');
select is((select parser_generation || '/' || stage || '/' || index_generation::text
             from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009'
              and artifact_index = 0), 't211e/extract/1',
  '56 the generations come from the **job row**, never from the caller: §4''s unique key would otherwise '
  || 'let a completion claim a generation that never ran');
select is((select producer from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009'
              and artifact_index = 0), 'cloud_worker',
  '57 producer is the credential''s executor (#135), which is what makes "who read these bytes" answerable');
select is((select data_class from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009'
              and artifact_index = 0), 'public',
  '58 the class propagates from the job row: a caller cannot lower it here (§6.2, AGENTS §4.4)');
select is((select jsonb_typeof(locator -> 'page') from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009'
              and artifact_index = 0), 'number',
  '59 the locator shape is the merged chunk shape, so a page locator cannot arrive as a string '
  || '(knowledge_core.sql:242-248)');
select is((select confidence::text from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009'
              and artifact_index = 0), '0.870',
  '60 the per-row OCR confidence wins over the job-level one, inside numeric(4,3) (F12, F32)');
select is((select fence::text from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009'
              and artifact_index = 0), '7',
  '61 the artifact carries the fence of the compare that succeeded, which is what abort matches '
  || 'against when it clears a dead writer''s partial output');
select is((select count(*) from public.outbox_events
            where aggregate_type = 'ingestion_job'
              and aggregate_id = '95000000-0000-4000-8000-0000000000a5')::text, '1',
  '62 exactly one outbox event, in the transaction that changed the aggregate (§7.2 step 1)');
select is((select event_type from public.outbox_events
            where aggregate_type = 'ingestion_job'
              and aggregate_id = '95000000-0000-4000-8000-0000000000a5'),
  'knowledge.ingestion_job.extract_succeeded',
  '63 named to fit the merged event_type shape (knowledge_core.sql:409) so a dispatcher can match it');
select is((select status from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a5'), 'succeeded',
  '64 the job is succeeded and the lease is released');
select ok((select lease_token is null and lease_expires_at is null and completed_at is not null
             from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a5'),
  '65 pair cleared together, completion recorded');
insert into t_done
  select 'complete_again', o_outcome, o_artifact_count, o_event_id
    from job_api.complete_parse_job_v1(
      pg_temp.syn_hash('cloud-c1'), '95000000-0000-4000-8000-0000000000a5',
      (select lease_token from t_lease where n = 5), (select fence from t_lease where n = 5),
      '71000000-0000-4000-8000-000000000009', 'extract', 1,
      '[{"artifact_index":0,"body_text":"Synthetic scanned page one: trace spacing a quarter metre.",
        "locator":{"page":1,"section":"Line one"}}]'::jsonb, null, null);
select is((select outcome from t_done where case_name = 'complete_again'), 'already_completed',
  '66 a duplicate delivery is a named no-op, not an error and not a second run');
select is((select count(*) from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000009')::text, '2',
  '67 still one artifact set: the packet''s "the same completion delivered twice is a no-op"');
select is((select count(*) from public.outbox_events
            where aggregate_type = 'ingestion_job'
              and aggregate_id = '95000000-0000-4000-8000-0000000000a5')::text, '1',
  '68 and one outbox event, which is what at-least-once dispatch needs (§7.5)');
insert into t_out values
  ('wrong_version', pg_temp.try_complete(pg_temp.syn_hash('box-c1'),
    '95000000-0000-4000-8000-0000000000a1', (select lease_token from t_lease where n = 1),
    (select fence from t_lease where n = 1), '71000000-0000-4000-8000-000000000010', 'extract', 1,
    '[{"artifact_index":0,"body_text":"probe"}]'::jsonb)),
  ('wrong_stage', pg_temp.try_complete(pg_temp.syn_hash('box-c1'),
    '95000000-0000-4000-8000-0000000000a1', (select lease_token from t_lease where n = 1),
    (select fence from t_lease where n = 1), '71000000-0000-4000-8000-000000000001', 'index', 1,
    '[{"artifact_index":0,"body_text":"probe"}]'::jsonb)),
  ('stale_generation', pg_temp.try_complete(pg_temp.syn_hash('box-c1'),
    '95000000-0000-4000-8000-0000000000a1', (select lease_token from t_lease where n = 1),
    (select fence from t_lease where n = 1), '71000000-0000-4000-8000-000000000001', 'extract', 7,
    '[{"artifact_index":0,"body_text":"probe"}]'::jsonb));
select is((select result from t_out where case_name = 'wrong_version'), '42501',
  '69 a completion naming a version the job is not for is refused with the same code as a foreign job');
select is((select result from t_out where case_name = 'wrong_stage')
          || '/' || (select result from t_out where case_name = 'stale_generation'), '42501/42501',
  '70 and so are a wrong stage and a superseded indexGeneration: the packet asks for both, and '
  || 'docs/contracts/knowledge-and-jobs.md:35 requires the re-check on every call');

-- ================================================================ 69-76 fencing: two arms, two
-- ================================================================ different failures
-- Simulate elapsed time honestly: move the expiry into the past rather than sleeping on it.
update public.ingestion_jobs set lease_expires_at = now() - interval '1 second'
  where id = '95000000-0000-4000-8000-0000000000a1';
insert into t_act
  select 'abandoned_renew', o_outcome, null, null, null, null, null, null, null
    from job_api.renew_parse_lease_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a1', (select lease_token from t_lease where n = 1),
         (select fence from t_lease where n = 1), 600);
select is((select outcome from t_act where case_name = 'abandoned_renew'), 'refused',
  '71 an abandoned lease is refused by the server-side expiry arm: the fence alone would not refuse it, '
  || 'because nobody re-leased this job and its token and fence still match (ADR-0005 §3, corrected)');
select is(pg_temp.try_complete(pg_temp.syn_hash('box-c1'), '95000000-0000-4000-8000-0000000000a1',
         (select lease_token from t_lease where n = 1), (select fence from t_lease where n = 1),
         '71000000-0000-4000-8000-000000000001', 'extract', 1,
         '[{"artifact_index":0,"body_text":"late write"}]'::jsonb), '42501',
  '72 the late completion of a partitioned box is a refusal, not a write');
select is((select count(*) from public.extraction_artifacts
            where job_id = '95000000-0000-4000-8000-0000000000a1')::text, '0',
  '73 and it left no artifact behind');
insert into t_lease
  select 6, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'extract', 300);
select is((select job_id::text from t_lease where n = 6), '95000000-0000-4000-8000-0000000000a1',
  '74 lease expiry makes the job claimable again — the packet''s failure box, via the inline sweep');
select is((select fence::text from t_lease where n = 6), '3',
  '75 and the reclaim bumped the fence first, which is what makes the old pair stale by construction '
  || '(#99: a sweep that did not bump would leave the abandoned holder''s write live)');
insert into t_act
  select 'stale_objref', null, null, null, null, null, o_found, o_object_ref, null
    from job_api.object_ref_for_lease_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a1', (select lease_token from t_lease where n = 1),
         (select fence from t_lease where n = 1));
select is((select found::text from t_act where case_name = 'stale_objref'), 'false',
  '76 a superseded holder gets no object key either (#146: the ref follows the lease, not the request)');
select is(pg_temp.try_complete(pg_temp.syn_hash('box-c1'), '95000000-0000-4000-8000-0000000000a1',
         (select lease_token from t_lease where n = 1), (select fence from t_lease where n = 1),
         '71000000-0000-4000-8000-000000000001', 'extract', 1,
         '[{"artifact_index":0,"body_text":"superseded write"}]'::jsonb), '42501',
  '77 nor may the superseded holder complete: this is the arm a fence alone provides, and it is '
  || 'independent of the clock');

-- ================================================================ 76-83 abort, and the partial
-- ================================================================ output of a dead writer
insert into t_act
  select 'abort_named', o_outcome, null, o_status, null, null, null, null, null
    from job_api.abort_parse_job_v1(pg_temp.syn_hash('box-c1'), '95000000-0000-4000-8000-0000000000a1',
         (select lease_token from t_lease where n = 6), (select fence from t_lease where n = 6),
         'source_revoked');
select is((select outcome from t_act where case_name = 'abort_named'), 'aborted',
  '78 a live lease aborts with a named reason');
select is((select status from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a1'), 'cancelled',
  '79 into cancelled, a value the merged state CHECK already offers (knowledge_core.sql:362-363): this '
  || 'migration adds no state to a merged table');
select is((select last_error from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a1'), 'source_revoked',
  '80 with the reason in last_error, inside its 1..500 CHECK, and no free text');
select is(pg_temp.try_abort(pg_temp.syn_hash('box-c1'), '95000000-0000-4000-8000-0000000000a7',
         'token-not-issued-123456789', 1, 'the document said to stop'), '22023',
  '81 an abort reason outside job_api.abort_reasons() is refused: a free-text reason is a channel for '
  || 'document-derived text into job metadata (AGENTS §4.8, #99''s closed vocabulary)');
select ok((select count(*) = 0 from unnest(job_api.abort_reasons()) u
            where u !~ '^[a-z0-9_]{1,64}$'),
  '82 every named abort code fits the shape the column and any later log line will hold');
select ok((select count(*) = 0 from unnest(job_api.retarget_reasons()) u
            where u !~ '^[a-z0-9_]{1,64}$'),
  '83 and the same for the retarget vocabulary, which is what T-212''s routing decision emits');
select ok((select 'no_text_layer' = any (job_api.retarget_reasons())
             and 'quality_failed' = any (job_api.retarget_reasons())
             and not ('the document said to stop' = any (job_api.abort_reasons()))),
  '84 the quality codes T-212 produces are in the retarget set, so the routing decision has a word to '
  || 'say, and a hostile sentence is not one');

-- ================================================================ 83-93 retarget: the cloud worker's
-- ================================================================ one-way door (#134, #66)
insert into t_lease
  select 7, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('cloud-c1'), 'extract', 300);
select is((select job_id::text from t_lease where n = 7), '95000000-0000-4000-8000-0000000000a2',
  '85 the next cloud lease takes company1''s remaining eligible cloud job (a6 is over the cap, a4 is '
  || 'failed, a5 is succeeded)');
insert into t_act
  select 'retarget_ok', o_outcome, o_executor, o_status, o_fence, null, null, null, null
    from job_api.retarget_extract_job_v1(pg_temp.syn_hash('cloud-c1'),
         '95000000-0000-4000-8000-0000000000a2', (select lease_token from t_lease where n = 7),
         (select fence from t_lease where n = 7), 'no_text_layer');
select is((select outcome from t_act where case_name = 'retarget_ok'), 'retargeted',
  '86 the cloud worker holding the lease can send its own extract job to the box (#66, #134)');
select is((select executor || '/' || status from t_act where case_name = 'retarget_ok'),
  'local_box/queued', '87 one-way to local_box and back to queued, where the box''s own credential will '
  || 'find it');
select is((select fence::text from t_act where case_name = 'retarget_ok'), '2',
  '88 and the fence is bumped: ADR-0005 §5''s race depends on this exact invariant, which #99 established '
  || 'for the sweep and #134 restates for retarget');
select ok((select lease_token is null and lease_expires_at is null
             from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a2'),
  '89 the lease pair is released together, so the abandoned holder cannot renew or complete afterwards');
select is((select last_error from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a2'), 'no_text_layer',
  '90 the reason is recorded on the row: a scan waiting for a box has to be explainable (§7.2 line 386)');
select is(pg_temp.try_retarget(pg_temp.syn_hash('box-c1'), '95000000-0000-4000-8000-0000000000a7',
         'irrelevant-token-12345678', 1, 'no_text_layer'), 'ok', '91 (helper call: a soft refusal is '
  || 'reported as a successful call, so the answers below are named)');
insert into t_act
  select 'retarget_by_box', o_outcome, null, null, null, null, null, null, null
    from job_api.retarget_extract_job_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a7', 'irrelevant-token-12345678', 1, 'no_text_layer');
insert into t_act
  select 'retarget_queued', o_outcome, null, null, null, null, null, null, null
    from job_api.retarget_extract_job_v1(pg_temp.syn_hash('cloud-c1'),
         '95000000-0000-4000-8000-0000000000a8', 'not-a-token-at-all-1234', 0, 'no_text_layer');
insert into t_act
  select 'retarget_local_box', o_outcome, null, null, null, null, null, null, null
    from job_api.retarget_extract_job_v1(pg_temp.syn_hash('cloud-c1'),
         '95000000-0000-4000-8000-0000000000a7', 'not-a-token-at-all-1234', 1, 'no_text_layer');
insert into t_act
  select 'retarget_other_tenant', o_outcome, null, null, null, null, null, null, null
    from job_api.retarget_extract_job_v1(pg_temp.syn_hash('cloud-c1'),
         '95000000-0000-4000-8000-0000000000a3', 'not-a-token-at-all-1234', 1, 'no_text_layer');
select is((select outcome || '/' || (select outcome from t_act where case_name = 'retarget_queued')
             from t_act where case_name = 'retarget_by_box'), 'refused/refused',
  '92 a box credential never retargets, and an unleased job cannot be retargeted: the decision belongs '
  || 'to the worker that gathered the evidence, from a live lease (#134). The packet''s "already-leased" '
  || 'wording for this negative was superseded by the same ruling, which requires the lease.');
select is((select outcome || '/' || (select outcome from t_act where case_name = 'retarget_other_tenant')
             from t_act where case_name = 'retarget_local_box'), 'refused/refused',
  '93 a job already on the box is not a target — nothing in this migration can move an executor back to '
  || 'cloud_worker, which is ADR-0005 §8''s first of three reasons third-party OCR is unreachable — and '
  || 'another tenant''s job answers like an unknown one');
select is((select executor from public.ingestion_jobs
            where id = '95000000-0000-4000-8000-0000000000a3'), 'local_box',
  '94 and the refused retarget changed nothing on the row it probed');
select is(pg_temp.try_retarget(pg_temp.syn_hash('cloud-c1'), '95000000-0000-4000-8000-0000000000a2',
         'token-1234567890abcdef', 1, 'send it to a vendor'), '22023',
  '95 a reason outside the named vocabulary is refused, so "re-route to a third-party OCR service" is '
  || 'not a value anyone can express (§7.2 line 386, ADR-0005 §8)');

-- ================================================================ 94-105 the artifact table's own
-- ================================================================ constraints, and the member read path
-- (RLS, three negatives)
select is(pg_temp.try_artifact_insert('22222222-2222-4222-8222-222222222222',
         '71000000-0000-4000-8000-000000000009', 'public', 'v1', 0), '23503',
  '96 the composite FK refuses an artifact naming another tenant''s version outright (ADR-0005 §4, the '
  || 'mechanism knowledge_core.sql:263-265 uses for chunks)');
select is(pg_temp.try_artifact_insert('11111111-1111-4111-8111-111111111111',
         '71000000-0000-4000-8000-000000000002', 'public', 'v1', 1), '23514',
  '97 the guard trigger refuses an artifact below its parent''s class: a client_confidential version '
  || 'cannot yield a public artifact (§6.2, AGENTS §4.4)');
select is(pg_temp.try_artifact_insert('11111111-1111-4111-8111-111111111111',
         '71000000-0000-4000-8000-000000000009', 'restricted', 'v1', 2), '23514',
  '98 a restricted artifact is unwritable, matching the contract cut the route already honours '
  || '(src/contracts/provider-route.ts:172-175)');
select is(pg_temp.try_artifact_update('71000000-0000-4000-8000-000000000009'), '23514',
  '99 artifacts are insert-only: a correction is a new artifact set under a new generation, never an '
  || 'edit in place (§7.2)');
select is(pg_temp.try_artifact_insert('11111111-1111-4111-8111-111111111111',
         '71000000-0000-4000-8000-000000000009', 'public', 't211e', 0), '23505',
  '100 the generation-scoped unique key is what makes a double write impossible even if a compare were '
  || 'ever widened: the constraint, not the function, is the authority');

-- A client_confidential artifact set, written through the RPC by the tenant's own box, against the
-- project-scoped version — the read side is what the three AGENTS §4.2 negatives then check.
insert into t_lease
  select 8, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'extract', 300);
select is((select job_id::text from t_lease where n = 8), '95000000-0000-4000-8000-0000000000a2',
  '101 the retargeted job is now in the box''s queue and the tenant box takes it: that is what the '
  || 'one-way door is for (#66, #134) — and 9500…a1, cancelled above, is never offered again');
insert into t_done
  select 'complete_cc', o_outcome, o_artifact_count, o_event_id
    from job_api.complete_parse_job_v1(
      pg_temp.syn_hash('box-c1'), '95000000-0000-4000-8000-0000000000a7',
      (select lease_token from t_lease where n = 2), (select fence from t_lease where n = 2),
      '71000000-0000-4000-8000-000000000002', 'extract', 1,
      '[{"artifact_index":0,"body_text":"Synthetic site note, page one, read by the tenant box.",
        "locator":{"page":1,"section":"Site note"}}]'::jsonb, null, 0.95);
select is((select outcome from t_done where case_name = 'complete_cc'), 'completed',
  '102 the box clears client_confidential: it is the tenant''s own hardware (plan §13), and this is the '
  || 'path §12.4 leaves open for a confidential scan');
select is((select data_class from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000002' limit 1),
  'client_confidential', '103 and the artifact inherits the confidential class, not a milder one');

-- There is no request-role read on this table any more (test 10), so this group splits the guarantee
-- in two: the policy that will bound the eventual read is asserted against the catalog, and the three
-- AGENTS §4.2 negatives are asserted against the predicate that policy leans on, under the same
-- member identities the rest of this suite uses.
select ok(exists(select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'extraction_artifacts'
                     and policyname = 'extraction_artifacts_scoped_read'
                     and cmd = 'SELECT' and permissive),
  '104 a permissive SELECT policy exists on the artifact home, so a future grant is bounded from day one');
select ok((select count(*) from pg_policies
             where tablename = 'extraction_artifacts' and cmd <> 'SELECT') = 0
          and not has_table_privilege('authenticated', 'public.extraction_artifacts', 'insert'),
  '105 and no write path exists at either layer: no INSERT, UPDATE or DELETE policy is attached, and no '
  || 'member holds INSERT, so a later read grant cannot open a write by accident (#13(1), FAQ-0004)');
select ok((select pg_get_expr(polqual, polrelid) from pg_policy
             where polrelid = 'public.extraction_artifacts'::regclass
               and polname = 'extraction_artifacts_scoped_read') like '%is_active_member%'
          and (select pg_get_expr(polqual, polrelid) from pg_policy
                 where polrelid = 'public.extraction_artifacts'::regclass
                   and polname = 'extraction_artifacts_scoped_read') like '%current_organisation_id%',
  '106 its qual conjoins an active membership (20261105060000_tenancy_core.sql:184) with the tenant of the '
  || 'scoped request (§4.1), so it is never a bare tenant column');
select ok((select pg_get_expr(polqual, polrelid) from pg_policy
             where polrelid = 'public.extraction_artifacts'::regclass
               and polname = 'extraction_artifacts_scoped_read') like '%source_version_is_readable%',
  '107 and the parent version''s own readability, which is where the project arm lives (knowledge_core.sql:442)');
select ok((select count(*) = 1 from pg_policies
             where schemaname = 'public' and tablename = 'extraction_artifacts'),
  '108 exactly one policy is attached to the table, so 104-107 cannot be describing a stray policy while a '
  || 'looser one sits beside it');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select pg_temp.try_scope('11111111-1111-4111-8111-111111111111');
select is(public.source_version_is_readable('71000000-0000-4000-8000-000000000002')::text, 'true',
  '109 the predicate a Site A member leans on answers readable for the confidential version, so the policy '
  || 'would admit that read the day a consumer exists');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select pg_temp.try_scope('11111111-1111-4111-8111-111111111111');
select is(public.source_version_is_readable('71000000-0000-4000-8000-000000000002')::text, 'false',
  '110 a company1 member who is **not** in Site A is refused it: same tenant, different project, the second '
  || 'AGENTS §4.2 negative');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
select is(pg_temp.try_scope('11111111-1111-4111-8111-111111111111'), '28000',
  '111 a suspended membership cannot even scope the tenant (20261105060000_tenancy_core.sql:214-216): the '
  || 'deactivated-member negative bites before any read is attempted');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
select pg_temp.try_scope('22222222-2222-4222-8222-222222222222');
select is(public.source_version_is_readable('71000000-0000-4000-8000-000000000002')::text, 'false',
  '112 company2''s owner is refused company1''s version outright, the third AGENTS §4.2 negative');
reset role;

-- ================================================================ 111-117 clearance, the object
-- ================================================================ locator, the revoked credential and
-- ================================================================ the reconciler
select is(job_api.executor_clears_class('local_box', 'client_confidential')::text, 'true',
  '113 the box clears every class M1 ingests');
select is(job_api.executor_clears_class('cloud_worker', 'client_confidential')::text, 'false',
  '114 the cloud executor does not, on §12.4''s default matrix exactly as merged: provider-route.ts:81 '
  || 'lists local_box and claude for client_confidential, and ADR-0007:14 widened that matrix for '
  || 'embeddings only. This is the one stated interim in the migration — if the supervisor rules that '
  || 'extraction inside our own bounded worker clears it, that arm and this assertion change together, '
  || 'in a new migration, and the cloud worker stops retargeting confidential scans');
select ok(job_api.executor_clears_class('cloud_worker', 'internal')
          and not job_api.executor_clears_class('local_box', 'restricted'),
  '115 internal clears the cloud path, and nothing clears restricted (§12.4)');
insert into t_act
  select 'objref_ok', null, null, null, null, null, o_found, o_object_ref, o_data_class
    from job_api.object_ref_for_lease_v1(pg_temp.syn_hash('box-c2'),
         '95000000-0000-4000-8000-0000000000a3',
         (select lease_token from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'),
         (select lease_fence from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'));
select is((select found::text from t_act where case_name = 'objref_ok'), 'true',
  '116 a live lease under the matching credential gets an object key (#146)');
select is((select object_ref from t_act where case_name = 'objref_ok'),
  'knowledge/22222222-2222-4222-8222-222222222222/62000000-0000-4000-8000-000000000001/v1.pdf',
  '117 the key of the version the **lease** points at, read from the row: never a value the caller '
  || 'supplied, never a URL, and never anything a payload could carry (ingestion-job.ts:13-17, ADR-0011)');
update public.ingestion_jobs set lease_expires_at = now() - interval '1 second'
  where id = '95000000-0000-4000-8000-0000000000a3';
insert into t_act
  select 'objref_expired', null, null, null, null, null, o_found, null, null
    from job_api.object_ref_for_lease_v1(pg_temp.syn_hash('box-c2'),
         '95000000-0000-4000-8000-0000000000a3',
         (select lease_token from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'),
         (select lease_fence from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'));
select is((select found::text from t_act where case_name = 'objref_expired'), 'false',
  '118 an expired lease gets nothing: the key follows the lease, so a worker that has run out of time '
  || 'cannot keep pulling bytes (#146)');
insert into t_act
  select 'objref_other_tenant', null, null, null, null, null, o_found, null, null
    from job_api.object_ref_for_lease_v1(pg_temp.syn_hash('box-c1'),
         '95000000-0000-4000-8000-0000000000a3',
         (select lease_token from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'),
         (select lease_fence from public.ingestion_jobs where id = '95000000-0000-4000-8000-0000000000a3'));
select is((select found::text from t_act where case_name = 'objref_other_tenant'), 'false',
  '119 and another tenant''s job, presented with its real token and real fence, also returns no row — '
  || 'the credential arm is in the same statement (#134, #146)');

-- ================================================================ 118-130 the revoked credential, the
-- ================================================================ bounds, the reconciler and the stage
-- ================================================================ key the dispatcher leans on
-- Inserted here rather than with the fixtures on purpose: box1's earlier lease assertions depend on
-- there being no other queued company1 box job, and this job must be live for the revoked-credential
-- probes below.
insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class, parser_generation,
  index_generation, attempt, lease_token, lease_expires_at, lease_fence, created_at
) values (
  '95000000-0000-4000-8000-0000000000a9', '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-000000000001', 'extract', 'local_box', 'queued', 'public', 't211i', 1,
  1, null, null, 0, now() - interval '4 minutes'
);
insert into t_lease
  select 9, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-c1'), 'extract', 300);
insert into t_lease
  select 10, o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
         o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
    from job_api.lease_parse_job_v1(pg_temp.syn_hash('box-revoked'), 'extract', 300);
select is((select found::text from t_lease where n = 10), 'false',
  '120 a revoked credential leases nothing at all, and the answer is the one an empty queue gives: the '
  || 'revoked_at arm sits inside the select, not in a separate gate (#134)');
insert into t_act
  select 'revoked_renew', o_outcome, null, null, null, null, null, null, null
    from job_api.renew_parse_lease_v1(pg_temp.syn_hash('box-revoked'),
         '95000000-0000-4000-8000-0000000000a9', (select lease_token from t_lease where n = 9),
         (select fence from t_lease where n = 9), 600);
select is((select outcome from t_act where case_name = 'revoked_renew'), 'refused',
  '121 a revoked credential matches zero rows on renew, even carrying the live token and fence of the '
  || 'lease another worker still holds (ADR-0005 §3''s hole, closed by the compare arm)');
select is(pg_temp.try_complete(pg_temp.syn_hash('box-revoked'), '95000000-0000-4000-8000-0000000000a9',
         (select lease_token from t_lease where n = 9), (select fence from t_lease where n = 9),
         '71000000-0000-4000-8000-000000000001', 'extract', 1,
         '[{"artifact_index":0,"body_text":"written by a revoked credential?"}]'::jsonb), '42501',
  '122 and zero rows on complete: a revocation stops in-flight work, not only new leases (#134, '
  || 'the ruling this replaces — "revoked_at bounds new leases only" — is now false, which is the point)');
select is((select count(*) from public.extraction_artifacts
            where source_version_id = '71000000-0000-4000-8000-000000000001')::text, '0',
  '123 and it wrote nothing, which is what makes the refusal worth having');
insert into t_act
  select 'revoked_objref', null, null, null, null, null, o_found, null, null
    from job_api.object_ref_for_lease_v1(pg_temp.syn_hash('box-revoked'),
         '95000000-0000-4000-8000-0000000000a9', (select lease_token from t_lease where n = 9),
         (select fence from t_lease where n = 9));
select is((select found::text from t_act where case_name = 'revoked_objref'), 'false',
  '124 nor does a revoked credential get an object key (#146''s four refusals: foreign tenant, expired '
  || 'lease, stale fence, revoked credential — all asserted above)');
select is(job_api.max_attempts()::text || '/' || job_api.max_lease_seconds()::text, '5/1800',
  '125 the retry bound and the lease ceiling are the numbers #99 named, and they live in one place each '
  || 'because the reclaim cap and the reconciler''s stuck threshold are both read from them');

select ok(exists(select 1 from job_api.reconciler_findings
                  where finding = 'stuck_job'
                    and job_id = '95000000-0000-4000-8000-0000000000a6'),
  '126 a job older than twice the maximum lease is named as stuck (plan §7.5 reconciler)');
select is((select count(*) from job_api.reconciler_findings
            where finding = 'stuck_job')::text, '1',
  '127 and only that one: the fixtures were aged deliberately, and the seed''s queued OCR job '
  || '(supabase/seed.sql:238-239, created moments ago for company2''s box) is correctly not stuck');
select ok(exists(select 1 from job_api.reconciler_findings
                   where finding = 'recent_failure'
                     and job_id = '95000000-0000-4000-8000-0000000000a4')
          and exists(select 1 from job_api.reconciler_findings
                      where finding = 'recent_failure'
                        and job_id = '95000000-0000-4000-8000-0000000000a1'),
  '128 the dead letter and the cancellation are both visible to the reconciler within 7 days, which is '
  || 'what makes `failed` and `cancelled` states an operator can act on instead of black holes (#99)');
select ok(exists(select 1 from job_api.reconciler_findings
                   where finding = 'missing_job'
                     and source_version_id = '71000000-0000-4000-8000-000000000010'),
  '129 a version sitting in a live pipeline state with no job row is named, which is the case a queue '
  || 'by itself can never report (plan §7.5: "stuck/missing jobs")');
select is((select count(*) from job_api.reconciler_findings
            where finding = 'missing_job'
              and source_version_id = '71000000-0000-4000-8000-000000000009')::text, '0',
  '130 and the sibling version that **does** have a job is not: the arm distinguishes, it does not '
  || 'simply list every non-published version');

create function pg_temp.try_read_reconciler() returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from job_api.reconciler_findings;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_read_reconciler(), '42501',
  '131 a signed-in tenant admin cannot read the reconciler either: reconciliation is an owner path '
  || 'through a privileged connection, and the dashboard that makes it legible is T-405');
reset role;

-- The dispatcher''s half of idempotency: at-least-once delivery re-enqueues, and the stage key is what
-- turns that into a no-op. This is the statement 20261106100000_knowledge_uploads.sql:470-478 runs.
create function pg_temp.try_dispatch_enqueue(p_organisation_id uuid, p_source_version_id uuid,
                                             p_parser_generation text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.ingestion_jobs (
      organisation_id, source_version_id, stage, executor, status, data_class,
      parser_generation, index_generation
    ) values (
      p_organisation_id, p_source_version_id, 'extract', 'cloud_worker', 'queued', 'public',
      p_parser_generation, 1
    )
    on conflict (organisation_id, source_version_id, stage, parser_generation, index_generation)
      do nothing;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;
select is(pg_temp.try_dispatch_enqueue('11111111-1111-4111-8111-111111111111',
         '71000000-0000-4000-8000-000000000001', 't211b'), 'ok',
  '132 a repeated dispatch of the same stage is a no-op rather than an error (#99: the dispatcher '
  || 'relies on the stage key)');
select is((select count(*) from public.ingestion_jobs
            where organisation_id = '11111111-1111-4111-8111-111111111111'
              and source_version_id = '71000000-0000-4000-8000-000000000001'
              and stage = 'extract' and parser_generation = 't211b'
              and index_generation = 1)::text, '1',
  '133 and it created no second job row: one row per (tenant, version, stage, parser, index), with '
  || 'attempt deliberately outside the key (knowledge_core.sql:398, #68, #16 N3)');

select * from finish();
rollback;
