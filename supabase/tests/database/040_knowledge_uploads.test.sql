-- T-112 upload sessions and the capture write path (supabase/migrations/20261106100000_knowledge_uploads.sql).
-- Plan §7.2 steps 1–2, §9.2.1, §6.2, §4.3; F09, F10; #13(1) (only the scoped RPC writes), #13(2)
-- (dedup is per collection and never an existence oracle), FAQ-0004, and the publish predicate that
-- issue #39 will seed.
--
-- Structure follows the supervisor's review of PR #12 (B5): every mutation a *member* must not be
-- able to make is asserted as `authenticated` inside a tenant scope, and the privileged-path
-- assertions pin the guard trigger, so dropping a grant or a guard fails a test rather than quietly
-- passing. Fixtures seed.sql does not carry — a `publisher` role holding `knowledge.write` — are
-- inserted in this transaction and rolled back with it, which pins the #39 predicate without
-- deciding #39 or touching the seed.
--
-- Synthetic hashes only (AGENTS.md §4.7): md5 of a marker string, doubled to the 64-hex shape the
-- column requires. They are digests of nothing.
begin;
create extension if not exists pgtap with schema extensions;

select plan(61);

-- ---------------------------------------------------------------- helpers
create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t112-synthetic-' || p_seed) || md5('t112-synthetic-' || p_seed || '-tail');
$fn$;

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

-- SECURITY INVOKER on purpose: the RPCs are SECURITY DEFINER, but every call below happens under the
-- role and JWT the block is simulating, so a missing grant or a failed predicate surfaces as a
-- SQLSTATE instead of a pass.
create function pg_temp.try_begin(p_collection_id uuid, p_idempotency_key text,
                                  p_filename text, p_declared_size bigint) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.begin_upload_session_v1(p_collection_id, p_idempotency_key,
                                                  p_filename, p_declared_size);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_register(p_session_id uuid, p_content_hash text,
                                     p_size_bytes bigint, p_media_type text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.register_source_version_v1(p_session_id, p_content_hash,
                                                     p_size_bytes, p_media_type);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_outcome(p_session_id uuid, p_state text, p_reason text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.record_upload_outcome_v1(p_session_id, p_state, p_reason);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Direct writes as the calling role: these are the mutations the scoped RPCs exist to prevent.
create function pg_temp.try_direct_source_insert(p_organisation_id uuid, p_collection_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.knowledge_sources (organisation_id, collection_id, kind)
      values (p_organisation_id, p_collection_id, 'upload');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_direct_version_insert(p_organisation_id uuid, p_collection_id uuid) returns text
language plpgsql security invoker as $fn$
declare
  v_source uuid;
begin
  begin
    -- With a real source id from the seed fixtures, a member write is still refused: provenance and
    -- immutability are not client-writable (issue #8, B1).
    select id into v_source from public.knowledge_sources
     where organisation_id = p_organisation_id limit 1;
    insert into public.source_versions (
      organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
      content_hash, object_ref
    ) values (
      p_organisation_id, v_source, p_collection_id, 900,
      '00000000-0000-4000-8000-0000000000a2', 'public',
      pg_temp.syn_hash('direct-insert'),
      'knowledge/11111111-1111-4111-8111-111111111111/probe-direct/v1.pdf'
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_direct_session_insert(p_organisation_id uuid, p_collection_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    insert into public.knowledge_upload_sessions (
      organisation_id, collection_id, created_by, idempotency_key, filename, object_ref,
      max_size_bytes, expires_at
    ) values (
      p_organisation_id, p_collection_id, '00000000-0000-4000-8000-0000000000a1',
      'probekey0001', 'probe.pdf',
      'knowledge/11111111-1111-4111-8111-111111111111/probe-session/object', 1024,
      now() + interval '5 minutes'
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_session_update(p_session_id uuid, p_state text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.knowledge_upload_sessions set state = p_state where id = p_session_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_publish_predicate(p_collection_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.user_may_publish_into(p_collection_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Owner-run updates, to pin what the guard trigger stops even on a privileged path (§4.3).
create function pg_temp.try_owner_update(p_sql text) returns text
language plpgsql set search_path = public, pg_temp as $fn$
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Temp result tables are created by the role that will fill them, so RLS and grants apply to the
-- reads and the RPC output is seen the way a real caller sees it.
set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_sessions (case_name text, id uuid, object_ref text, max_size bigint,
                              state text, reused boolean);
create temp table t_versions (case_name text, source_id uuid, source_version_id uuid,
                              state text, already boolean);
create temp table t_count (case_name text, n int);
reset role;

-- ---------------------------------------------------------------- publisher fixture (issue #39)
-- A `publisher` role holding `knowledge.write` at level `write`, granted to company1's field member
-- and to company2's owner (who otherwise holds no knowledge permission at all in the seed). It lives
-- only in this rolled-back transaction, so the predicate is pinned without a seed change and without
-- pre-empting #39.
insert into public.organisation_roles (id, organisation_id, key, name) values
  ('31000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'publisher', 'Knowledge publisher'),
  ('32000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'publisher', 'Knowledge publisher');
insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000003', 'knowledge.write', 'write'),
  ('22222222-2222-4222-8222-222222222222', '32000000-0000-4000-8000-000000000002', 'knowledge.write', 'write');
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, r.id
  from public.organisation_memberships m
  join public.organisation_roles r on r.organisation_id = m.organisation_id and r.key = 'publisher'
 where m.user_id = '00000000-0000-4000-8000-0000000000b1';

-- ---------------------------------------------------------------- 1-6 the member write surface
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values
  ('direct_source_insert', pg_temp.try_direct_source_insert('11111111-1111-4111-8111-111111111111',
      '51000000-0000-4000-8000-000000000001')),
  ('direct_version_insert', pg_temp.try_direct_version_insert('11111111-1111-4111-8111-111111111111',
      '51000000-0000-4000-8000-000000000001')),
  ('direct_session_insert', pg_temp.try_direct_session_insert('11111111-1111-4111-8111-111111111111',
      '51000000-0000-4000-8000-000000000001')),
  ('publish_predicate_call', pg_temp.try_publish_predicate('51000000-0000-4000-8000-000000000001')),
  ('session_rpc_execute', case when has_function_privilege('authenticated',
      'begin_upload_session_v1(uuid,text,text,bigint)', 'execute') then 'ok' else 'no' end),
  ('helper_rpc_execute', case when has_function_privilege('authenticated',
      'user_may_publish_into(uuid)', 'execute') then 'ok' else 'no' end);
reset role;

select is((select result from t_out where case_name = 'direct_source_insert'), '42501',
  '1 a direct insert into knowledge_sources as authenticated is a permission error (42501): only the scoped RPC writes (#13(1), FAQ-0004)');
select is((select result from t_out where case_name = 'direct_version_insert'), '42501',
  '2 a direct insert into source_versions as authenticated is refused too, so a client cannot mint a version with its own uploaded_by (issue #8)');
select is((select result from t_out where case_name = 'direct_session_insert'), '42501',
  '3 a member cannot open an upload session by writing a row: the grant comes only from begin_upload_session_v1 and its checks');
select is((select result from t_out where case_name = 'publish_predicate_call'), '42501',
  '4 the publish predicate is revoked from request roles: it is an internal predicate of the capture RPCs, not an endpoint to probe');
select is((select result from t_out where case_name = 'session_rpc_execute'), 'ok',
  '5 the capture RPCs are granted to authenticated per function, which is the path the application calls');
select is((select result from t_out where case_name = 'helper_rpc_execute'), 'no',
  '6 and the helper is not, so this PR''s per-function grants do not widen the function surface (the older EXECUTE gap is the supervisor''s call, not this migration''s)');

-- ---------------------------------------------------------------- 7-16 opening a session
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('begin_without_scope', pg_temp.try_begin('51000000-0000-4000-8000-000000000001',
  't112noscope1', 'noscope.pdf', null));
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values
  ('begin_foreign_collection', pg_temp.try_begin('52000000-0000-4000-8000-000000000001',
      't112foreign1', 'foreign.pdf', null)),
  ('begin_bad_filename', pg_temp.try_begin('51000000-0000-4000-8000-000000000001',
      't112filename1', '../escape.pdf', null)),
  ('begin_bad_key', pg_temp.try_begin('51000000-0000-4000-8000-000000000001',
      'x', 'short-key.pdf', null));
insert into t_sessions
  select 'a1_first', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112a1first', 'quarterly-site-report.pdf', null);
insert into t_sessions
  select 'a1_retry', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112a1first', 'quarterly-site-report.pdf', null);
insert into t_sessions
  select 'a1_small', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112a1small', 'small.pdf', 4096);
insert into t_sessions
  select 'a1_bigclaim', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112a1bigclaim', 'huge.pdf', 999999999999);
reset role;

select is((select result from t_out where case_name = 'begin_without_scope'), '28000',
  '7 an upload session cannot be opened with no tenant scope: there is no unscoped write path (F03, §4.3)');
select is((select result from t_out where case_name = 'begin_foreign_collection'), '42501',
  '8 another tenant''s collection id is refused with the same code as a permission failure, so the endpoint is not a collection-existence oracle (§4.2, #13(2))');
select is((select result from t_out where case_name = 'begin_bad_filename'), '22023',
  '9 a file name carrying a path separator is refused: it is a label, and it can never become a path (F09)');
select is((select result from t_out where case_name = 'begin_bad_key'), '22023',
  '10 a malformed idempotency key is refused at the boundary instead of being stored as an opaque retry handle');
select is((select count(*)::int from t_sessions where case_name = 'a1_retry' and reused), 1::int,
  '11 retrying the same logical begin reuses the session instead of issuing a second object key (§9.2.1: retryable mutations are idempotent)');
select is((select object_ref from t_sessions where case_name = 'a1_retry'),
          (select object_ref from t_sessions where case_name = 'a1_first'),
  '12 and the retry hands back the identical server-issued key');
select is((select position('quarterly' in object_ref) from t_sessions where case_name = 'a1_first'), 0::int,
  '13 the issued key contains no part of the client''s file name: the client cannot choose it, it can only be handed one (F09)');
select is((select object_ref ~ '^knowledge/11111111-1111-4111-8111-111111111111/uploads/'
             from t_sessions where case_name = 'a1_first'), true,
  '14 the key is prefixed with the transaction''s tenant, not with anything the caller named (§4.1)');
select is((select max_size from t_sessions where case_name = 'a1_small'), 4096::bigint,
  '15 a declared size may narrow the grant of one session');
select is((select max_size from t_sessions where case_name = 'a1_bigclaim'), 20971520::bigint,
  '16 and may never widen it past the plan §7.5 meter: an uploader cannot grant itself a bigger object');

-- ---------------------------------------------------------------- 17-19 permission and audience
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values ('member_read_only_begin', pg_temp.try_begin('51000000-0000-4000-8000-000000000001',
  't112a2before', 'before-publisher.pdf', null));
reset role;

select is((select result from t_out where case_name = 'member_read_only_begin'), '42501',
  '17 a member whose only knowledge permission is `knowledge.read` cannot open a session at all: reading a corpus is not publishing into it (issue #39)');

-- Same person, same call; the only thing that changes is the role.
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, r.id
  from public.organisation_memberships m
  join public.organisation_roles r on r.organisation_id = m.organisation_id and r.key = 'publisher'
 where m.user_id = '00000000-0000-4000-8000-0000000000a2';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values ('publisher_begin_ok', pg_temp.try_begin('51000000-0000-4000-8000-000000000001',
  't112a2publisher', 'field-note.pdf', null));
insert into t_out values ('publisher_begin_project', pg_temp.try_begin('51000000-0000-4000-8000-000000000002',
  't112a2project', 'site-a-note.pdf', null));
insert into t_sessions
  select 'a2_small', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112a2small', 'a2-small.pdf', 4096);
reset role;

select is((select result from t_out where case_name = 'publisher_begin_ok'), 'ok',
  '18 `knowledge.write` at level `write` is what opens a tenant-wide corpus (the #39 predicate, pinned without a seed change)');
select is((select result from t_out where case_name = 'publisher_begin_project'), '42501',
  '19 and it does not reach a project corpus the caller is not a member of: publish permission never overrides audience (§6.2, §7.2 step 5)');

-- ---------------------------------------------------------------- 20-27 one capture, one version, one event
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_sessions
  select 'capture', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112capture1', 'synthetic-manual.pdf', null);
insert into t_versions
  select 'capture_first', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1((select id from t_sessions where case_name = 'capture'),
      pg_temp.syn_hash('capture'), 2048, 'application/pdf');
insert into t_versions
  select 'capture_replay', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1((select id from t_sessions where case_name = 'capture'),
      pg_temp.syn_hash('capture'), 2048, 'application/pdf');
reset role;

select is((select state from t_versions where case_name = 'capture_first'), 'received',
  '20 a verified capture enters the state machine at `received` (§7.2)');
select is((select already from t_versions where case_name = 'capture_first'), false,
  '21 and it is not reported as a duplicate');
select is((select count(*)::int from public.source_versions
            where id = (select source_version_id from t_versions where case_name = 'capture_first')), 1::int,
  '22 exactly one source version row exists after the completion');
select is((select uploaded_by::text from public.source_versions
            where id = (select source_version_id from t_versions where case_name = 'capture_first')),
  '00000000-0000-4000-8000-0000000000a1',
  '23 uploaded_by is the calling auth.uid(), never a body value: this is the column T-213 compares a reviewer against (issue #8, AGENTS.md §4.1)');
select is((select organisation_id::text from public.source_versions
            where id = (select source_version_id from t_versions where case_name = 'capture_first')),
  '11111111-1111-4111-8111-111111111111',
  '24 the tenant is the host-resolved organization of the transaction, not a parameter (§4.1)');
select is((select object_ref from public.source_versions
            where id = (select source_version_id from t_versions where case_name = 'capture_first')),
  (select object_ref from t_sessions where case_name = 'capture'),
  '25 the version points at the session''s own server-issued key: register_source_version_v1 has no object-key parameter to lie with (F09)');
select is((select data_class from public.source_versions
            where id = (select source_version_id from t_versions where case_name = 'capture_first')),
  'public',
  '26 the data class is inherited from the collection, never chosen by the uploader (§6.2)');
select is((select count(*)::int from public.outbox_events
            where aggregate_type = 'source_version'
              and aggregate_id = (select source_version_id from t_versions where case_name = 'capture_first')
              and event_type = 'knowledge.source_version.received'), 1::int,
  '27 the capture commits exactly one outbox event, written by the merged capture trigger in the same transaction (§7.2 step 1)');

-- ---------------------------------------------------------------- 28-37 idempotency, the stage row and the pin
select is((select already from t_versions where case_name = 'capture_replay'), true,
  '28 posting the same completion again replays instead of capturing twice (§7.5: queues are at-least-once)');
select is((select source_version_id from t_versions where case_name = 'capture_replay'),
          (select source_version_id from t_versions where case_name = 'capture_first'),
  '29 and the replay returns the same version id, so the client converges on one processing handle');
select is((select count(*)::int from public.source_versions
            where content_hash = pg_temp.syn_hash('capture')
              and collection_id = '51000000-0000-4000-8000-000000000001'), 1::int,
  '30 still exactly one version for that content in that collection');
select is((select count(*)::int from public.ingestion_jobs
            where source_version_id = (select source_version_id from t_versions where case_name = 'capture_first')), 1::int,
  '31 and exactly one stage row for that version, on the unique stage key that leaves `attempt` out (§7.5, issue #16 N3)');
select is((select count(*)::int from public.outbox_events
            where aggregate_id = (select source_version_id from t_versions where case_name = 'capture_first')), 1::int,
  '32 and exactly one event: the retry wrote nothing anywhere');
select is((select stage || '/' || executor || '/' || status from public.ingestion_jobs
            where source_version_id = (select source_version_id from t_versions where case_name = 'capture_first')),
  'extract/cloud_worker/queued',
  '33 the enqueued stage is the cloud extractor: the validating step already ran as part of the capture (§7.2 steps 2–3)');

update public.embedding_indexes set generation = 2 where id = '91000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_sessions
  select 'gen2', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112gen2', 'synthetic-gen2.pdf', null);
insert into t_versions
  select 'gen2', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1((select id from t_sessions where case_name = 'gen2'),
      pg_temp.syn_hash('gen2'), 1024, 'application/pdf');
reset role;
select is((select index_generation from public.ingestion_jobs
            where source_version_id = (select source_version_id from t_versions where case_name = 'gen2')), 2::int,
  '34 the stage row carries the tenant''s active `corpus` generation — moved to 2 here — rather than a constant the code invented (§8.3)');

update public.embedding_indexes set status = 'retired' where id = '91000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_sessions
  select 'nogen', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112nogen', 'synthetic-nogen.pdf', null);
insert into t_out values ('no_active_index', pg_temp.try_register(
  (select id from t_sessions where case_name = 'nogen'), pg_temp.syn_hash('nogen'), 1024, 'application/pdf'));
insert into t_count select 'nogen_versions', (select count(*)::int from public.source_versions
                                               where content_hash = pg_temp.syn_hash('nogen'));
insert into t_count select 'nogen_jobs', (select count(*)::int
                                            from public.ingestion_jobs j
                                            join public.source_versions v on v.id = j.source_version_id
                                           where v.content_hash = pg_temp.syn_hash('nogen'));
reset role;
update public.embedding_indexes set status = 'active' where id = '91000000-0000-4000-8000-000000000001';

select is((select result from t_out where case_name = 'no_active_index'), '55000',
  '35 with no active embedding generation the capture is refused instead of inventing a generation the open pin decision (#6) has not authorized');
select is((select n from t_count where case_name = 'nogen_versions'), 0::int,
  '36 and the refusal wrote no version: capture is atomic, there is no half-captured source (§7.2 step 1)');
select is((select n from t_count where case_name = 'nogen_jobs'), 0::int,
  '37 and no stage row either, so no worker is ever asked to run a stage against a generation that does not exist');

-- ---------------------------------------------------------------- 38-44 dedup is per collection, never an oracle
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_sessions
  select 'dupe_same', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112dupesame', 'same-again.pdf', null);
insert into t_versions
  select 'dupe_same', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1((select id from t_sessions where case_name = 'dupe_same'),
      pg_temp.syn_hash('capture'), 2048, 'application/pdf');
insert into t_sessions
  select 'dupe_other_coll', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000002',
      't112dupeother', 'same-in-project.pdf', null);
insert into t_versions
  select 'dupe_other_coll', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1((select id from t_sessions where case_name = 'dupe_other_coll'),
      pg_temp.syn_hash('capture'), 2048, 'application/pdf');
reset role;

-- Seed-side: company1 holds a copy in the Site A project corpus that company2 cannot read at all.
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id)
  values ('61000000-0000-4000-8000-000000000099', '11111111-1111-4111-8111-111111111111',
          '51000000-0000-4000-8000-000000000002', 'upload', 'synthetic-hidden-copy',
          '00000000-0000-4000-8000-0000000000a1');
insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text
) values (
  '71000000-0000-4000-8000-000000000099', '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-000000000099', '51000000-0000-4000-8000-000000000002', 1,
  '00000000-0000-4000-8000-0000000000a1', 'client_confidential',
  pg_temp.syn_hash('hidden'),
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000099/v1.pdf',
  'published', 'v1', 'Synthetic hidden copy written by the pgTAP fixture only.'
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_sessions
  select 'a2_hidden_attempt', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('51000000-0000-4000-8000-000000000001',
      't112a2hidden', 'a2-copy.pdf', null);
insert into t_versions
  select 'a2_hidden_attempt', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1((select id from t_sessions where case_name = 'a2_hidden_attempt'),
      pg_temp.syn_hash('hidden'), 2048, 'application/pdf');
reset role;

select is((select already from t_versions where case_name = 'dupe_same'), true,
  '38 the same content re-posted into the same collection is reported once, as a hint this uploader can act on (#13(2))');
select is((select source_version_id from t_versions where case_name = 'dupe_same'),
          (select source_version_id from t_versions where case_name = 'capture_first'),
  '39 and the hint names the copy that is readable to this uploader rather than creating a second row');
select is((select already from t_versions where case_name = 'dupe_other_coll'), false,
  '40 in a different collection the same hash is its own capture: dedup is collection-scoped, so it cannot be a cross-corpus oracle (§6.2, #13(2))');
select is((select count(*)::int from public.source_versions where content_hash = pg_temp.syn_hash('capture')), 2::int,
  '41 exactly two versions hold that content, one per collection: the key is (collection_id, content_hash), not tenant-wide');
select is((select already from t_versions where case_name = 'a2_hidden_attempt'), false,
  '42 an uploader who cannot read the collection holding a copy gets the ordinary result: no existence signal, no reference to the hidden version (§4.2, #13(2))');
select is((select count(*)::int from public.source_versions
            where content_hash = pg_temp.syn_hash('hidden')
              and collection_id = '51000000-0000-4000-8000-000000000001'), 1::int,
  '43 and the copy they just captured is theirs in the collection they published into, exactly one row');
select is((select count(*)::int from public.source_versions v
            where v.content_hash = pg_temp.syn_hash('hidden')
              and v.collection_id = '51000000-0000-4000-8000-000000000002'), 1::int,
  '44 the unreadable project copy is untouched and unmentioned: the two rows are distinct because dedup never crosses a collection boundary');

-- ---------------------------------------------------------------- 45-53 refusals and session states
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values
  ('other_users_session', pg_temp.try_register((select id from t_sessions where case_name = 'capture'),
      pg_temp.syn_hash('steal'), 2048, 'application/pdf')),
  ('unknown_session', pg_temp.try_register(gen_random_uuid(), pg_temp.syn_hash('unknown'), 2048, 'application/pdf')),
  ('bad_hash', pg_temp.try_register((select id from t_sessions where case_name = 'a2_small'),
      'notahash', 1024, 'application/pdf')),
  ('bad_media_type', pg_temp.try_register((select id from t_sessions where case_name = 'a2_small'),
      pg_temp.syn_hash('media'), 1024, 'application/pdf; charset=utf-8')),
  ('over_bound', pg_temp.try_register((select id from t_sessions where case_name = 'a2_small'),
      pg_temp.syn_hash('toobig'), 500000, 'application/pdf')),
  ('outcome_by_other', pg_temp.try_outcome((select id from t_sessions where case_name = 'a1_first'),
      'failed', 'hash_mismatch')),
  ('outcome_unknown_code', pg_temp.try_outcome((select id from t_sessions where case_name = 'a2_small'),
      'failed', 'clientsaidso')),
  ('outcome_bad_state', pg_temp.try_outcome((select id from t_sessions where case_name = 'a2_small'),
      'published', 'hash_mismatch'));
reset role;

select is((select result from t_out where case_name = 'other_users_session'), '42501',
  '45 a session is bound to its uploader: another member of the same tenant cannot complete it (§4.2)');
select is((select result from t_out where case_name = 'unknown_session'), '42501',
  '46 an unknown session id answers exactly like a foreign or somebody-else''s one, so ids cannot be probed');
select is((select result from t_out where case_name = 'bad_hash'), '22023',
  '47 a malformed content hash is refused before anything is written: the column shape is enforced in SQL as well as in the application (F10)');
select is((select result from t_out where case_name = 'bad_media_type'), '22023',
  '48 the media type is validated as a bare type/subtype token, so a capture cannot smuggle markup or a URL into the version payload metadata (AGENTS.md §4.8)');
select is((select result from t_out where case_name = 'over_bound'), '22023',
  '49 the measured size is re-checked against the session''s bound in SQL, independently of what the application measured (§7.2 step 2)');
select is((select result from t_out where case_name = 'outcome_by_other'), '42501',
  '50 no one else''s session can be marked failed by a different member of the tenant');
select is((select result from t_out where case_name = 'outcome_unknown_code'), '22023',
  '51 the reason vocabulary is closed, so an arbitrary string can never become a user-visible failure label');
select is((select result from t_out where case_name = 'outcome_bad_state'), '22023',
  '52 an outcome is quarantined or failed: this RPC can never move a session into a knowledge state');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values ('quarantine', pg_temp.try_outcome(
  (select id from t_sessions where case_name = 'a1_small'), 'quarantined', 'signature_mismatch'));
insert into t_out values ('closed_session', pg_temp.try_register(
  (select id from t_sessions where case_name = 'a1_small'), pg_temp.syn_hash('closed'), 1024, 'application/pdf'));
reset role;

select is((select state || '/' || coalesce(reason_code, 'none') from public.knowledge_upload_sessions
            where id = (select id from t_sessions where case_name = 'a1_small')),
  'quarantined/signature_mismatch',
  '53 a refused object leaves a visible quarantine with a safe reason code instead of a silently empty source (§7.2)');

-- ---------------------------------------------------------------- 54-58 RLS on sessions and the guard trigger
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_count select 'a2_visible_sessions', (select count(*)::int from public.knowledge_upload_sessions);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('scope', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_count select 'b1_company1_sessions', (select count(*)::int from public.knowledge_upload_sessions);
reset role;

insert into t_out values
  ('guard_object_ref', pg_temp.try_owner_update(
    'update public.knowledge_upload_sessions set object_ref = ''knowledge/22222222-2222-4222-8222-222222222222/attacker/object'' where id = (select id from t_sessions where case_name = ''a1_first'')')),
  ('guard_created_by', pg_temp.try_owner_update(
    'update public.knowledge_upload_sessions set created_by = ''00000000-0000-4000-8000-0000000000a4'' where id = (select id from t_sessions where case_name = ''a1_first'')')),
  ('guard_reopen', pg_temp.try_owner_update(
    'update public.knowledge_upload_sessions set state = ''awaiting_upload'' where id = (select id from t_sessions where case_name = ''capture'')'));

select is((select n from t_count where case_name = 'a2_visible_sessions'),
  (select count(*)::int from public.knowledge_upload_sessions where created_by = '00000000-0000-4000-8000-0000000000a2'),
  '54 a member reads only their own sessions in their own tenant scope: the policy names created_by, not just membership (§8.2)');
select is((select n from t_count where case_name = 'b1_company1_sessions'), 0::int,
  '55 a company2 member reads no session rows at all in their own scope: another tenant''s object keys and expiry times are not information they are given (§4.2)');
select is((select result from t_out where case_name = 'guard_object_ref'), '23514',
  '56 even the owner-run path cannot re-point a session''s object key at another tenant''s prefix (guard trigger, §4.3)');
select is((select result from t_out where case_name = 'guard_created_by'), '23514',
  '57 nor re-attribute it to another member: provenance of the grant is fixed at issue time (issue #8)');
select is((select result from t_out where case_name = 'guard_reopen'), '23514',
  '58 and a completed capture cannot be reopened, so a replayed or malicious update cannot resume writing into a closed session (§7.2)');

-- ---------------------------------------------------------------- 59-61 the same bytes in another tenant
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('scope', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_sessions
  select 'b1_same_hash', o_session_id, o_object_ref, o_max_size_bytes, o_state, o_reused
    from public.begin_upload_session_v1('52000000-0000-4000-8000-000000000001',
      't112b1same', 'company2-copy.pdf', null);
insert into t_versions
  select 'b1_same_hash', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1((select id from t_sessions where case_name = 'b1_same_hash'),
      pg_temp.syn_hash('hidden'), 2048, 'application/pdf');
reset role;

select is((select already from t_versions where case_name = 'b1_same_hash'), false,
  '59 company2 uploading bytes company1 already holds gets the ordinary result: no hint, and nothing naming the other tenant''s copy (§4.2, #13(2))');
select is(((select source_version_id from t_versions where case_name = 'b1_same_hash') = '71000000-0000-4000-8000-000000000099'), false,
  '60 and the version it received is its own row, never the hidden company1 version id (§6.2 composite keys)');
select is((select count(*)::int from public.source_versions where content_hash = pg_temp.syn_hash('hidden')), 3::int,
  '61 three rows hold that content — one per collection — which is exactly what the per-collection dedup key guarantees and a tenant-wide key would have destroyed (§6.2)');

select * from finish();
rollback;
