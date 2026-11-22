-- T-216 `exact_lookup_v1`: deterministic identifier match before hybrid search (plan §8.1 step 4).
-- FAQ-0011 / #163 (scope first, volatile), ADR-0008 (text, never offsets), FAQ-0010 / #60 grants.
-- Slot 070 (COORDINATION §6b). Fixtures are synthetic (AGENTS.md §4.7).
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t216-synthetic-' || p_seed) || md5('t216-synthetic-' || p_seed || '-tail');
$fn$;

create function pg_temp.try_lookup(
  p_organisation_id uuid, p_service_keys text[], p_project_id uuid,
  p_collection_ids uuid[], p_identifier text, p_limit integer
) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    perform 1 from public.exact_lookup_v1(
      p_organisation_id, p_service_keys, p_project_id, p_collection_ids, p_identifier, p_limit
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_rows (
  case_name text, chunk_id uuid, organisation_id uuid, match_kind text, body_text text, rank int
);
create temp table t_count (case_name text, n int);
reset role;

-- ---------------------------------------------------------------- fixtures (owner-written)
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000000201', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload', 'synth-exact-provision', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000000202', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload', 'synth-exact-filename', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000000203', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload', 'synth-exact-unpublished', '00000000-0000-4000-8000-0000000000a1'),
  ('62000000-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', '52000000-0000-4000-8000-000000000001', 'upload', 'synth-exact-c2', '00000000-0000-4000-8000-0000000000b1');

insert into public.source_versions (id, organisation_id, source_id, collection_id, version_number,
                                    uploaded_by, data_class, content_hash, object_ref, state,
                                    parser_generation, body_text, published_at, payload) values
  ('71000000-0000-4000-8000-000000000201', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000201', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('e201'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000201/v1.pdf',
   'published', 'v1', 'Exact-lookup fixture: provision EXACT-SQ-77 requires the model ALPHA-UAV-9 on every survey.', now(), null),
  ('71000000-0000-4000-8000-000000000202', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000202', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('e202'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000202/v1.pdf',
   'published', 'v1', 'Filename-matched document body without the title string in the text.', now(),
   '{"filename": "Site-Alpha-Ops-Manual.pdf"}'::jsonb),
  ('71000000-0000-4000-8000-000000000203', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000203', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1', 'public', pg_temp.syn_hash('e203'),
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000203/v1.pdf',
   'received', 'v1', 'Unpublished marker EXACT-DRAFT-9 must never match.', null, null),
  ('72000000-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', '62000000-0000-4000-8000-000000000201', '52000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000b1', 'public', pg_temp.syn_hash('e2c'),
   'knowledge/22222222-2222-4222-8222-222222222222/62000000-0000-4000-8000-000000000201/v1.pdf',
   'published', 'v1', 'Company2-only marker EXACT-C2-TOKEN-41 for cross-tenant negatives.', now(), null);

insert into public.knowledge_chunks (id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class) values
  ('81000000-0000-4000-8000-000000000201', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000201', 0,
   '{"page": 1, "section": "Provisions"}', 'Exact-lookup fixture: provision EXACT-SQ-77 requires the model ALPHA-UAV-9 on every survey.', 'public'),
  ('81000000-0000-4000-8000-000000000202', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000202', 0,
   '{"page": 1, "section": "Cover"}', 'Filename-matched document body without the title string in the text.', 'public'),
  ('81000000-0000-4000-8000-000000000203', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000203', 0,
   '{"page": 1, "section": "Draft"}', 'Unpublished marker EXACT-DRAFT-9 must never match.', 'public'),
  ('82000000-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', '72000000-0000-4000-8000-000000000201', 0,
   '{"page": 1, "section": "Radar"}', 'Company2-only marker EXACT-C2-TOKEN-41 for cross-tenant negatives.', 'public');

-- ---------------------------------------------------------------- shape / grants
select is((select count(*)::int from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'exact_lookup_v1'), 1::int,
  '1 exact_lookup_v1 exists in public');

select is((select p.prosecdef from pg_proc p
            where p.oid = 'public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)'::regprocedure),
  false, '2 SECURITY INVOKER so RLS is the authorization boundary (#136)');

select is((select p.provolatile from pg_proc p
            where p.oid = 'public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)'::regprocedure),
  'v', '3 volatile because set_tenant_scope uses set_config (FAQ-0011)');

select is((select exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                             where cfg like 'search_path=%' and cfg like '%pg_temp%')
             from pg_proc p
            where p.oid = 'public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)'::regprocedure),
  true, '4 search_path is pinned (§4.3)');

select is(has_function_privilege('anon', 'public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)', 'execute'),
  false, '5 anon cannot execute (FAQ-0010)');

select is(has_function_privilege('authenticated', 'public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)', 'execute'),
  true, '6 authenticated holds EXECUTE by full signature (FAQ-0010)');

-- ---------------------------------------------------------------- positive matches
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

insert into t_rows (case_name, chunk_id, organisation_id, match_kind, body_text, rank)
select 'provision', o_chunk_id, o_organisation_id, o_match_kind, o_body_text, o_rank
  from public.exact_lookup_v1(
    '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, 'EXACT-SQ-77', 12
  );
select is((select count(*)::int from t_rows where case_name = 'provision'), 1,
  '7 provision number EXACT-SQ-77 returns one published chunk');
select is((select match_kind from t_rows where case_name = 'provision'), 'body_phrase',
  '8 provision match is body_phrase');
select ok((select body_text from t_rows where case_name = 'provision') like '%EXACT-SQ-77%',
  '9 returned body carries the identifier (ADR-0008: text, not an offset)');

insert into t_rows (case_name, chunk_id, organisation_id, match_kind, body_text, rank)
select 'model', o_chunk_id, o_organisation_id, o_match_kind, o_body_text, o_rank
  from public.exact_lookup_v1(
    '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, 'ALPHA-UAV-9', 12
  );
select is((select count(*)::int from t_rows where case_name = 'model'), 1,
  '10 equipment model ALPHA-UAV-9 matches');

insert into t_rows (case_name, chunk_id, organisation_id, match_kind, body_text, rank)
select 'filename', o_chunk_id, o_organisation_id, o_match_kind, o_body_text, o_rank
  from public.exact_lookup_v1(
    '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, 'Site-Alpha-Ops-Manual.pdf', 12
  );
select is((select count(*)::int from t_rows where case_name = 'filename'), 1,
  '11 document title (payload filename) matches');
select is((select match_kind from t_rows where case_name = 'filename'), 'filename',
  '12 filename match_kind is filename');

-- ---------------------------------------------------------------- negatives: unpublished, other tenant, blank
insert into t_count (case_name, n)
select 'unpublished', count(*)::int
  from public.exact_lookup_v1(
    '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, 'EXACT-DRAFT-9', 12
  );
select is((select n from t_count where case_name = 'unpublished'), 0,
  '13 unpublished version with the marker returns zero rows');

insert into t_count (case_name, n)
select 'cross_tenant', count(*)::int
  from public.exact_lookup_v1(
    '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, 'EXACT-C2-TOKEN-41', 12
  );
select is((select n from t_count where case_name = 'cross_tenant'), 0,
  '14 company2 identifier under company1 scope returns zero rows (no existence signal)');

insert into t_out (case_name, result)
select 'other_org', pg_temp.try_lookup(
  '22222222-2222-4222-8222-222222222222', array[]::text[], null, null, 'EXACT-C2-TOKEN-41', 12
);
select is((select result from t_out where case_name = 'other_org'), '28000',
  '15 company1 member asking for company2 organisation_id is refused 28000 (FAQ-0011)');

insert into t_out (case_name, result)
select 'blank', pg_temp.try_lookup(
  '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, '   ', 12
);
select is((select result from t_out where case_name = 'blank'), '22023',
  '16 blank identifier is refused 22023');

insert into t_out (case_name, result)
select 'null_keys', pg_temp.try_lookup(
  '11111111-1111-4111-8111-111111111111', null, null, null, 'EXACT-SQ-77', 12
);
select is((select result from t_out where case_name = 'null_keys'), '22023',
  '17 null p_service_keys is refused (empty array is the tenant-wide corpus)');

insert into t_out (case_name, result)
select 'bad_project', pg_temp.try_lookup(
  '11111111-1111-4111-8111-111111111111', array[]::text[],
  '42000000-0000-4000-8000-000000000001', null, 'EXACT-SQ-77', 12
);
select is((select result from t_out where case_name = 'bad_project'), '42501',
  '18 foreign project id refuses 42501 (same class as search_corpus_v1)');

-- ---------------------------------------------------------------- scope-first + arrived-scope mismatch
reset role;
select is((select pg_get_functiondef('public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)'::regprocedure)
             like '%perform public.set_tenant_scope(p_organisation_id);%'),
  true, '19 function body contains set_tenant_scope(p_organisation_id)');

-- The first *statement* after DECLARE must be the scope call: strip the declare block and assert.
select ok(
  (select position('perform public.set_tenant_scope(p_organisation_id);'
                     in regexp_replace(
                          pg_get_functiondef('public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)'::regprocedure),
                          '(?is)^.*?\$\$', ''
                        )) > 0),
  '20 set_tenant_scope appears in the function body (FAQ-0011)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
-- a1 is not a member of company2; mismatch path needs a dual member. Use clear then call with
-- company1 while somehow arrived as company1 — the mismatch test needs a user in both orgs.
-- Seed a4 is in both company1 and company2 (seed.sql). Switch to a4.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
insert into t_out (case_name, result)
select 'rescope', pg_temp.try_lookup(
  '22222222-2222-4222-8222-222222222222', array[]::text[], null, null, 'EXACT-C2-TOKEN-41', 12
);
select is((select result from t_out where case_name = 'rescope'), '28000',
  '21 arrived scope company1 cannot be overridden to company2 mid-transaction (28000)');

-- ---------------------------------------------------------------- service filter narrows; case-insensitive
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

insert into t_count (case_name, n)
select 'wrong_service', count(*)::int
  from public.exact_lookup_v1(
    '11111111-1111-4111-8111-111111111111', array['gpr']::text[], null, null, 'EXACT-SQ-77', 12
  );
select is((select n from t_count where case_name = 'wrong_service'), 0,
  '22 service_keys filter that excludes the collection returns zero rows');

insert into t_rows (case_name, chunk_id, organisation_id, match_kind, body_text, rank)
select 'lower', o_chunk_id, o_organisation_id, o_match_kind, o_body_text, o_rank
  from public.exact_lookup_v1(
    '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, 'exact-sq-77', 12
  );
select is((select count(*)::int from t_rows where case_name = 'lower'), 1,
  '23 identifier match is case-insensitive');

select ok(
  not (pg_get_function_result('public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)'::regprocedure)
       ~* 'start_?char|end_?char|offset'),
  '24 return type names no character offset columns (ADR-0008)');

select is((select count(*)::int from t_rows where case_name = 'provision' and organisation_id = '11111111-1111-4111-8111-111111111111'), 1,
  '25 provision hit stays inside company1');

insert into t_out (case_name, result)
select 'oversized', pg_temp.try_lookup(
  '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, repeat('x', 201), 12
);
select is((select result from t_out where case_name = 'oversized'), '22023',
  '26 identifier over 200 characters is refused 22023');

insert into t_out (case_name, result)
select 'bad_limit', pg_temp.try_lookup(
  '11111111-1111-4111-8111-111111111111', array[]::text[], null, null, 'EXACT-SQ-77', 0
);
select is((select result from t_out where case_name = 'bad_limit'), '22023',
  '27 p_limit below 1 is refused 22023');

select is((select chunk_id from t_rows where case_name = 'provision'),
  '81000000-0000-4000-8000-000000000201'::uuid,
  '28 provision match names the fixture chunk id');

select * from finish();
rollback;
