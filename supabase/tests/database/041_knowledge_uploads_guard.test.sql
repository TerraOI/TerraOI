-- T-112c: the capture RPCs establish their own tenant scope (#163 / FAQ-0011), and the replay + session
-- guard holes from #96 close. pgTAP slot 041 — the name registered in docs/COORDINATION.md §6b
-- (`041_knowledge_uploads_guard`, owner T-112c / #96), not the name that appeared in the task briefing.
-- Migration: supabase/migrations/20261116213000_capture_scope.sql (a **new** migration; the merged
-- 20261106100000_knowledge_uploads.sql is never edited, AGENTS.md §6).
--
-- What this file deliberately does NOT re-do: 040_knowledge_uploads.test.sql owns the capture-path
-- behaviour suite (63 assertions, owner "T-112 (merged)" in §6b:128). Slot 041 pins only what *this*
-- slice changes — the new signatures, the volatility, the scope-before-read ordering, the tenant
-- argument's membership gate, the #96 replay refusal, and the guard's two new clauses — so a reviewer
-- can read one file and see one ruling each.
--
-- Fixtures are supabase/seed.sql's synthetic rows: orgs company1 11111111-…-1111 / company2
-- 22222222-…-2222; people …a1 company1 admin (Site A project member), …a2 company1 member
-- (knowledge.read only), …a3 company1 suspended, …a4 member of BOTH orgs (no knowledge permission in
-- either), …b1 company2 admin; collections 51000000-…-001 (company1, tenant-wide `public`) and
-- 51000000-…-002 (company1, Site A project, `client_confidential`), 52000000-…-001 (company2,
-- tenant-wide); an *active* `corpus` index generation per tenant (seed.sql:219-226), which
-- register_source_version_v1 requires before it will write anything (§6, #6 pinned in T-113).
--
-- The publisher role 040 seeds for the #39 predicate is NOT seeded here: every successful capture below
-- is done by …a1, a tenant admin holding `knowledge.admin` at `admin`, which the merged publish
-- predicate already accepts — so 041 adds no role fixture and cannot drift the counts another slot makes.
-- The file still ends with `rollback;`: pg_prove runs one session per file against a freshly reset
-- database, and a mutated fixture (this file deletes and restores a project membership) left behind
-- would make the suite order-dependent.
begin;
create extension if not exists pgtap with schema extensions;

-- ---------------------------------------------------------------- helpers (pg_temp, security invoker)
create function pg_temp.syn_hash(p_seed text) returns text
language sql immutable as $fn$
  select md5('t112c-synthetic-' || p_seed) || md5('t112c-synthetic-' || p_seed || '-tail');
$fn$;

-- SQLSTATE only: the shape 040's helpers use, kept identical so a reader comparing the two files is
-- comparing the same instrument.
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

create function pg_temp.try_clear_scope() returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.clear_tenant_scope();
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- The helpers take p_organisation_id first, exactly as the RPCs now do: a test that gets the order
-- wrong fails on types rather than passing by accident.
create function pg_temp.try_begin(p_organisation_id uuid, p_collection_id uuid,
                                  p_idempotency_key text, p_filename text,
                                  p_declared_size bigint) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.begin_upload_session_v1(p_organisation_id, p_collection_id,
                                                  p_idempotency_key, p_filename, p_declared_size);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- The sqlstate alone cannot show that two refusals are indistinguishable, so this helper keeps the
-- message as well (#169: the foreign-collection answer must be the unknown-collection answer).
create function pg_temp.try_begin_err(p_organisation_id uuid, p_collection_id uuid,
                                      p_idempotency_key text, p_filename text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.begin_upload_session_v1(p_organisation_id, p_collection_id,
                                                  p_idempotency_key, p_filename, null);
    return 'ok';
  exception when others then
    return sqlstate::text || '|' || sqlerrm;
  end;
end;
$fn$;

create function pg_temp.try_register(p_organisation_id uuid, p_session_id uuid, p_content_hash text,
                                     p_size_bytes bigint, p_media_type text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.register_source_version_v1(p_organisation_id, p_session_id,
                                                     p_content_hash, p_size_bytes, p_media_type);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_outcome(p_organisation_id uuid, p_session_id uuid,
                                    p_state text, p_reason text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.record_upload_outcome_v1(p_organisation_id, p_session_id, p_state, p_reason);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- The #96 indistinguishability test needs the whole refusal, not just its code: state that the answer
-- for "you may not read this any more" is byte-identical to the answer for "you may never have
-- published here", the only way to prove no existence signal survives.
create function pg_temp.refusal_of(p_sql text) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    return sqlstate::text || '|' || sqlerrm;
  end;
end;
$fn$;

-- Owner-run mutations: the only way to reach a fixture state no member can produce (a removed project
-- membership, a closed session state), and the surface the guard trigger exists to constrain (§4.3).
create function pg_temp.try_owner_sql(p_sql text) returns text
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

-- The same mutation attempted *as a member*, so 48 measures the missing policy rather than the guard:
-- the role switch is inside the function and is undone on both paths, so no later assertion inherits it.
create function pg_temp.try_as_authenticated(p_sql text) returns text
language plpgsql set search_path = public, pg_temp as $fn$
begin
  begin
    set local role authenticated;
    execute p_sql;
    reset role;
    return 'ok';
  exception when others then
    begin
      reset role;
    exception when others then
      null;
    end;
    return sqlstate::text;
  end;
end;
$fn$;

-- Body pins, by full signature: a function's source is what a later "convenience" edit changes first.
create function pg_temp.priv_of(p_role text, p_signature text) returns text
language plpgsql security invoker as $fn$
declare v_proc regprocedure := to_regprocedure(p_signature);
begin
  if v_proc is null then
    return 'no such function: ' || p_signature;
  end if;
  return has_function_privilege(p_role, v_proc, 'execute')::text;
exception when others then
  return 'error:' || sqlstate;
end;
$fn$;

create function pg_temp.prosrc_of(p_signature text) returns text
language plpgsql security invoker as $fn$
declare v_proc regprocedure := to_regprocedure(p_signature);
begin
  if v_proc is null then
    return 'no such function: ' || p_signature;
  end if;
  return (select p.prosrc from pg_proc p where p.oid = v_proc);
end;
$fn$;

create function pg_temp.args_of(p_signature text) returns text
language plpgsql security invoker as $fn$
declare v_proc regprocedure := to_regprocedure(p_signature);
begin
  if v_proc is null then
    return 'no such function: ' || p_signature;
  end if;
  return pg_get_function_arguments(v_proc);
end;
$fn$;

create function pg_temp.vol_of(p_signature text) returns text
language plpgsql security invoker as $fn$
declare v_proc regprocedure := to_regprocedure(p_signature);
begin
  if v_proc is null then
    return 'no such function: ' || p_signature;
  end if;
  return (select p.provolatile::text from pg_proc p where p.oid = v_proc);
end;
$fn$;

-- Temp result tables are created by the role that fills them (the 010/040 idiom CI taught on #157:
-- a temp table belongs to the role that created it, and writing it under `set local role authenticated`
-- as the migration owner answers `permission denied for table`).
set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_sessions (case_name text, id uuid, object_ref text, state text, reused boolean);
create temp table t_versions (case_name text, source_id uuid, source_version_id uuid,
                              state text, already boolean);
create temp table t_count (case_name text, n int);
reset role;

select plan(57);

-- ---------------------------------------------------------------- 1-20 the shape the two rulings ask for
select is(pg_temp.args_of('public.begin_upload_session_v1(uuid,uuid,text,text,bigint)'),
  'p_organisation_id uuid, p_collection_id uuid, p_idempotency_key text, p_filename text, p_declared_size_bytes bigint',
  '1 begin_upload_session_v1 takes p_organisation_id **first** and keeps every other parameter as it was: '
  || 'the tenant argument is the only new thing, and there is still no object key, uploader, class or '
  || 'audience parameter to forge (#163 rule 1, F09, §4.1)');

select is(pg_temp.args_of('public.register_source_version_v1(uuid,uuid,text,bigint,text)'),
  'p_organisation_id uuid, p_upload_session_id uuid, p_content_hash text, p_size_bytes bigint, p_media_type text',
  '2 register_source_version_v1 the same way, and it is still the only capture write path (#13(1), FAQ-0004)');

select is(pg_temp.args_of('public.record_upload_outcome_v1(uuid,uuid,text,text)'),
  'p_organisation_id uuid, p_upload_session_id uuid, p_state text, p_reason_code text',
  '3 and record_upload_outcome_v1 too, so all three entry points of the capture path move together — a '
  || 'half-moved capture path is a half-enforced tenancy rule (#163)');

-- Volatility is read from the catalog, never inferred from the `create function` text: plpgsql defaults
-- to volatile, so the file would pass by accident today and lose the fact the moment someone writes
-- `stable` into one of these bodies (the trap #163 rule 4 names).
select is(pg_temp.vol_of('public.begin_upload_session_v1(uuid,uuid,text,text,bigint)'), 'v',
  '4 begin_upload_session_v1 is VOLATILE: its first statement calls set_tenant_scope, whose set_config is '
  || 'volatile, so `stable` would be a promise the planner is entitled to rely on inside one statement (#163 rule 4)');
select is(pg_temp.vol_of('public.register_source_version_v1(uuid,uuid,text,bigint,text)'), 'v',
  '5 and register_source_version_v1, which also writes — it was already volatile as a writer, and now it '
  || 'is volatile for both reasons');
select is(pg_temp.vol_of('public.record_upload_outcome_v1(uuid,uuid,text,text)'), 'v',
  '6 and record_upload_outcome_v1');

-- Scope before read, mirroring 037:72: the ordering is what makes an unscoped or mis-scoped read
-- structurally impossible rather than merely declined by a later check.
select ok(position('perform public.set_tenant_scope(p_organisation_id);' in pg_temp.prosrc_of('public.begin_upload_session_v1(uuid,uuid,text,text,bigint)')) between 1
             and position('from public.knowledge_upload_sessions' in pg_temp.prosrc_of('public.begin_upload_session_v1(uuid,uuid,text,text,bigint)')),
  '7 in begin_upload_session_v1 the scope call sits in the body before the first read of a tenant table, so '
  || 'the retry lookup, the collection lookup and the insert all run under a scope that was verified (#163 rule 2, FAQ-0011)');
select ok(position('perform public.set_tenant_scope(p_organisation_id);' in pg_temp.prosrc_of('public.register_source_version_v1(uuid,uuid,text,bigint,text)')) between 1
             and position('from public.knowledge_upload_sessions' in pg_temp.prosrc_of('public.register_source_version_v1(uuid,uuid,text,bigint,text)')),
  '8 and in register_source_version_v1 before the session lookup that decides whose capture this is');
select ok(position('perform public.set_tenant_scope(p_organisation_id);' in pg_temp.prosrc_of('public.record_upload_outcome_v1(uuid,uuid,text,text)')) between 1
             and position('from public.knowledge_upload_sessions' in pg_temp.prosrc_of('public.record_upload_outcome_v1(uuid,uuid,text,text)')),
  '9 and in record_upload_outcome_v1, so the three entry points cannot diverge on which statement runs first');

-- The old signatures are gone, not shadowed: #163 drops them, and a leftover overload would be a live
-- REST endpoint whose tenant is *not* verified by the membership check — six capture endpoints instead
-- of three, and the whole property of the ruling lost.
select is((select count(*)::int from (values
             ('public.begin_upload_session_v1(uuid, text, text, bigint)'),
             ('public.register_source_version_v1(uuid, text, bigint, text)'),
             ('public.record_upload_outcome_v1(uuid, text, text)')) as dropped(sig)
            where to_regprocedure(dropped.sig) is not null), 0::int,
  '10 no old-signature capture function survives this migration: the three pre-#163 shapes are dropped by '
  || 'full signature, so nothing can call a capture path whose tenant came from a scope it never verified');

select is((select count(*)::int from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('begin_upload_session_v1', 'register_source_version_v1', 'record_upload_outcome_v1')), 3::int,
  '11 and exactly one live overload per name: the allow-list, the adapter and the reader all agree there is '
  || 'one capture path, not two that differ on tenancy (#163, FAQ-0010)');

-- Privileges, re-pinned for the new shapes (the merged migration revoked and granted by full signature;
-- a new signature starts with the PUBLIC default grant, which a migration cannot close — FAQ-0010).
select is(pg_temp.priv_of('anon', 'public.begin_upload_session_v1(uuid,uuid,text,text,bigint)'), 'false',
  '12 anon cannot execute the new begin_upload_session_v1 (#60, FAQ-0010: revoked by full signature in the '
  || 'creating migration, which is also why the PUBLIC default did not survive it)');
select is(pg_temp.priv_of('anon', 'public.register_source_version_v1(uuid,uuid,text,bigint,text)'), 'false',
  '13 anon cannot execute the new register_source_version_v1');
select is(pg_temp.priv_of('anon', 'public.record_upload_outcome_v1(uuid,uuid,text,text)'), 'false',
  '14 anon cannot execute the new record_upload_outcome_v1');
select is(pg_temp.priv_of('authenticated', 'public.begin_upload_session_v1(uuid,uuid,text,text,bigint)'), 'true',
  '15 authenticated keeps the per-function grant on the new begin_upload_session_v1, and 001''s rule-32 '
  || 'allow-list names the same signature in this PR (AGENTS.md §4.2)');
select is(pg_temp.priv_of('authenticated', 'public.register_source_version_v1(uuid,uuid,text,bigint,text)'), 'true',
  '16 and on the new register_source_version_v1 — the capture path stays the only write surface for a request role');
select is(pg_temp.priv_of('authenticated', 'public.record_upload_outcome_v1(uuid,uuid,text,text)'), 'true',
  '17 and on the new record_upload_outcome_v1');
select is(pg_temp.priv_of('authenticated', 'public.user_may_publish_into(uuid)'), 'false',
  '18 the publish predicate is still closed to request roles: an internal predicate is not an endpoint to '
  || 'probe, and this PR does not widen it while moving everything around it (#39)');

-- #96 half 2, pinned in the guard body: the two new clauses exist, and the merged identity clauses stay.
select ok(position('new.expires_at is distinct from old.expires_at' in pg_temp.prosrc_of('public.knowledge_upload_sessions_guard()')) > 0,
  '19 the session guard pins expires_at: a stuck upload is re-opened by issuing a **new** session, never by '
  || 'extending a grant that already went out (#96 clause 2)');
select ok(position('old.state <> ''awaiting_upload''' in pg_temp.prosrc_of('public.knowledge_upload_sessions_guard()')) > 0,
  '20 and it makes completed, quarantined, failed and expired final by rule rather than by one function''s '
  || 'early return, so "first refusal wins" holds for every writer including the future expiry sweep (#96 clause 2)');

-- ---------------------------------------------------------------- 21-31 the tenant argument is verified, not trusted
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('clear_first', pg_temp.try_clear_scope());
insert into t_sessions
  select 'selfscoped', o_session_id, o_object_ref, o_state, o_reused
    from public.begin_upload_session_v1('11111111-1111-4111-8111-111111111111',
                                        '51000000-0000-4000-8000-000000000001',
                                        't112cselfscope', 'self-scope.pdf', null);
insert into t_out values
  ('clear_after', pg_temp.try_clear_scope()),
  ('foreign_tenant', pg_temp.try_begin('22222222-2222-4222-8222-222222222222',
      '52000000-0000-4000-8000-000000000001', 't112cforeign', 'foreign-tenant.pdf', null)),
  ('null_tenant', pg_temp.try_begin(null,
      '51000000-0000-4000-8000-000000000001', 't112cnull', 'null-tenant.pdf', null));
reset role;

select is((select count(*)::int from t_sessions where case_name = 'selfscoped' and id is not null), 1::int,
  '21 with the session scope cleared away first, the RPC establishes its own scope and the call answers: '
  || '"no scope set" is no longer a caller error, it is a step the RPC performs itself (FAQ-0011, §4.3:245-247)');
select is((select organisation_id from public.knowledge_upload_sessions
             where id = (select id from t_sessions where case_name = 'selfscoped')),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '22 the session row landed in the tenant the argument named and membership allowed — the tenant still '
  || 'comes from the scope, and the scope now comes from that argument plus the membership check (#163, §4.1)');
select is((select object_ref ~ '^knowledge/11111111-1111-4111-8111-111111111111/uploads/'
             from t_sessions where case_name = 'selfscoped'), true,
  '23 and the server-issued object key is prefixed with that tenant: an argument that was not verified '
  || 'would prefix the key with whatever someone typed (F09)');
select is((select result from t_out where case_name = 'foreign_tenant'), '28000',
  '24 naming a tenant the caller is not an active member of raises 28000 from set_tenant_scope itself, '
  || '**before** any collection lookup: the argument never confers membership, which is the sentence '
  || '§4.3:245 hangs the whole pattern on (#163 rule 2, tenancy_core.sql:203-220)');
insert into t_count select 'foreign_session_rows',
  (select count(*)::int from public.knowledge_upload_sessions
    where idempotency_key = 't112cforeign');
select is((select n from t_count where case_name = 'foreign_session_rows'), 0::int,
  '25 the refusal wrote nothing in either tenant: a denied tenant argument cannot even leave a session row '
  || 'behind to be probed later (§4.2, #13(2))');
select is((select result from t_out where case_name = 'null_tenant'), '22023',
  '26 a null tenant is a malformed argument (22023), not a request to guess: set_tenant_scope refuses it '
  || 'outright rather than falling back to whatever the session happens to hold (tenancy_core.sql:210-212)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_out values ('suspended_begin', pg_temp.try_begin('11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001', 't112csuspended', 'suspended.pdf', null));
reset role;
select is((select result from t_out where case_name = 'suspended_begin'), '28000',
  '27 a deactivated (suspended) membership is refused the tenant itself — the membership check inside the '
  || 'RPC, not a policy somewhere else, is what stops it, and the refusal is the same one any non-member '
  || 'gets (§4.2, AGENTS.md §4.1)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('foreign_collection', pg_temp.try_begin('11111111-1111-4111-8111-111111111111',
      '52000000-0000-4000-8000-000000000001', 't112cforecoll', 'foreign-collection.pdf', null)),
  ('unknown_collection', pg_temp.try_begin('11111111-1111-4111-8111-111111111111',
      '59000000-0000-4000-8000-000000000099', 't112cunkncoll', 'unknown-collection.pdf', null));
reset role;
select is((select result from t_out where case_name = 'foreign_collection'), '42501',
  '28 once the tenant is allowed, another tenant''s collection id is still refused exactly as before, with '
  || 'the code a permission failure uses (#13(2), §4.2)');
select is((select result from t_out where case_name = 'unknown_collection'), '42501',
  '29 and so is a collection that does not exist: the RPC is not a collection-existence oracle, and '
  || 'moving the tenant into an argument changed nothing about that');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('member_begin', pg_temp.try_begin('11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001', 't112cmember', 'member.pdf', null));
reset role;
select is((select result from t_out where case_name = 'member_begin'), '42501',
  '30 a member holding only `knowledge.read` passes the membership gate and is refused at the publish '
  || 'predicate: reading a corpus is not publishing into it (#39), and 28000-vs-42501 is why 24 and 30 are '
  || 'not the same door');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
insert into t_out values ('scope_company1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_out values ('a4_name_company2', pg_temp.try_begin('22222222-2222-4222-8222-222222222222',
  '52000000-0000-4000-8000-000000000001', 't112ca4company2', 'dual-member.pdf', null));
reset role;
select is((select result from t_out where case_name = 'a4_name_company2'), '42501',
  '31 the tenant argument is governed by **membership**, not by the scope the transaction arrived with: '
  || '…a4 belongs to both orgs, so naming company2 clears the membership gate and is refused one step '
  || 'later for lacking publish permission — the same call gives 28000 for …a1 (test 24). A capture RPC '
  || 'has no "arrived scope mismatch" guard: #163 requires that guard for search_corpus_v1 only, and '
  || 'inventing one here would be a decision this slice does not get to make (asserted, not assumed)');

-- ---------------------------------------------------------------- 32-45 #96: the replay stops disclosing
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_sessions
  select 'conf_capture', o_session_id, o_object_ref, o_state, o_reused
    from public.begin_upload_session_v1('11111111-1111-4111-8111-111111111111',
                                        '51000000-0000-4000-8000-000000000002',
                                        't112ccapture1', 'site-a-field-report.pdf', null);
insert into t_out values ('capture', pg_temp.try_register('11111111-1111-4111-8111-111111111111',
  (select id from t_sessions where case_name = 'conf_capture'),
  pg_temp.syn_hash('site-a-report'), 4096, 'application/pdf'));
insert into t_versions
  select 'capture', o_source_id, o_source_version_id, o_state, o_already_uploaded
    from public.register_source_version_v1('11111111-1111-4111-8111-111111111111',
      (select id from t_sessions where case_name = 'conf_capture'),
      pg_temp.syn_hash('site-a-report'), 4096, 'application/pdf');
-- A second grant into the same collection, deliberately left `awaiting_upload`: after 35 removes the
-- project membership, completing *this* one is the "may never publish here" case that 37 compares the
-- replay refusal against — same RPC, same tenant argument, same hash, one different session state.
insert into t_sessions
  select 'conf_await', o_session_id, o_object_ref, o_state, o_reused
    from public.begin_upload_session_v1('11111111-1111-4111-8111-111111111111',
                                        '51000000-0000-4000-8000-000000000002',
                                        't112ccapture2', 'site-a-second-report.pdf', null);
reset role;

select is((select result from t_out where case_name = 'capture'), 'ok',
  '32 the capture itself still works end to end with the tenant as an argument: 33-44 are about identity, '
  || 'not about a path that stopped functioning');
select is((select count(*)::int from t_versions where case_name = 'capture'
             and source_version_id is not null and already), 1::int,
  '33 the replay of a completed session answers with the same ids and `already_uploaded = true`, so a '
  || 'double-posted completion is still idempotent (§7.5, #16 N3)');
insert into t_count select 'version_tenant_ok',
  (select count(*)::int from public.source_versions sv
    join public.knowledge_sources ks on ks.id = sv.source_id
   where sv.id = (select source_version_id from t_versions where case_name = 'capture')
     and sv.organisation_id = '11111111-1111-4111-8111-111111111111'
     and ks.collection_id = '51000000-0000-4000-8000-000000000002');
select is((select n from t_count where case_name = 'version_tenant_ok'), 1::int,
  '34 the version really exists in company1, in the collection the session was issued for — which is what '
  || 'makes 37-39 a refusal by the read path rather than an empty result because nothing was written');

-- …a1 loses the Site A project membership. No member can do this (there is no member write policy on
-- project_memberships), so it is an owner mutation: the state a departing field engineer is actually in.
insert into t_out values ('drop_membership', pg_temp.try_owner_sql(
  'delete from public.project_memberships where project_id = ''41000000-0000-4000-8000-000000000001'' '
  || 'and user_id = ''00000000-0000-4000-8000-0000000000a1'''));
reset role;
select is((select result from t_out where case_name = 'drop_membership'), 'ok',
  '35 the fixture is reachable (owner-run): a tenant admin who is no longer a member of the project whose '
  || 'confidential corpus they captured into. 36-39 are about that person, and 40 puts it back');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('replay_after_loss', pg_temp.refusal_of(
  'select 1 from public.register_source_version_v1(''11111111-1111-4111-8111-111111111111'', '''
  || (select id from t_sessions where case_name = 'conf_capture') || ''', '''
  || pg_temp.syn_hash('site-a-report') || ''', 4096, ''application/pdf'')'));
insert into t_out values ('fresh_after_loss', pg_temp.refusal_of(
  'select 1 from public.register_source_version_v1(''11111111-1111-4111-8111-111111111111'', '''
  || (select id from t_sessions where case_name = 'conf_await') || ''', '''
  || pg_temp.syn_hash('site-a-report') || ''', 4096, ''application/pdf'')'));
insert into t_out values ('replay_ids_leak', pg_temp.refusal_of(
  'select o_source_id, o_source_version_id from public.register_source_version_v1('
  || '''11111111-1111-4111-8111-111111111111'', '''
  || (select id from t_sessions where case_name = 'conf_capture') || ''', '''
  || pg_temp.syn_hash('site-a-report') || ''', 4096, ''application/pdf'')'));
reset role;

select is(split_part((select result from t_out where case_name = 'replay_after_loss'), '|', 1), '42501',
  '36 the replay after the caller loses read access is a refusal — the ids of a capture they may no longer '
  || 'see are not returned to them: "you captured it, so you may always see it" was never the rule (#96 clause 1)');
select is((select result from t_out where case_name = 'replay_after_loss'),
          (select result from t_out where case_name = 'fresh_after_loss'),
  '37 the refusal is byte-identical — same SQLSTATE **and** same message — to the refusal a caller who may '
  || 'never publish here gets, so "already here" and "not allowed here" cannot be told apart and the '
  || 'replay branch is not an existence oracle (#96 clause 1, :422-427 and :497-499)');
select is((select result from t_out where case_name = 'replay_ids_leak'),
          (select result from t_out where case_name = 'replay_after_loss'),
  '38 and asking for the ids explicitly changes nothing: the read check runs before any id or state is '
  || 'placed on the result, so nothing leaks through the column list either');

insert into t_out values ('restore_membership', pg_temp.try_owner_sql(
  'insert into public.project_memberships (organisation_id, project_id, user_id) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''41000000-0000-4000-8000-000000000001'', '
  || '''00000000-0000-4000-8000-0000000000a1'')'));
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('replay_restored', pg_temp.try_register('11111111-1111-4111-8111-111111111111',
  (select id from t_sessions where case_name = 'conf_capture'),
  pg_temp.syn_hash('site-a-report'), 4096, 'application/pdf'));
reset role;
select is((select result from t_out where case_name = 'replay_restored'), 'ok',
  '39 with the membership restored the same replay answers again, so 36-38 measured the read predicate and '
  || 'not a broken fixture, and no second version was minted by the retries (§7.5)');

select ok(position('sv.organisation_id = v_organisation' in pg_temp.prosrc_of('public.register_source_version_v1(uuid,uuid,text,bigint,text)')) > 0,
  '40 the replay''s version lookup carries the tenant predicate rather than trusting the id on the session '
  || 'row — the composite FK makes a cross-tenant version id unrepresentable, and this is the belt behind '
  || 'that braces, pinned in the body because no member-reachable fixture can reach it (#96 clause 1)');
select ok(position('public.source_is_readable(v_replay_version.source_id)' in pg_temp.prosrc_of('public.register_source_version_v1(uuid,uuid,text,bigint,text)')) between 1
             and position('o_already_uploaded := true' in pg_temp.prosrc_of('public.register_source_version_v1(uuid,uuid,text,bigint,text)')),
  '41 and the read check sits before the replay puts anything on the result, which is why 38 could not '
  || 'smuggle ids out through the column list (#96 clause 1)');

select is((select count(*)::int from public.source_versions
             where collection_id = '51000000-0000-4000-8000-000000000002'
               and content_hash = pg_temp.syn_hash('site-a-report')), 1::int,
  '42 exactly one version exists for that content in that collection after a capture, a refused replay, an '
  || 'identical replay and a restored replay: the tenant argument did not cost the path its idempotence');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('register_other_tenant_arg', pg_temp.try_register('22222222-2222-4222-8222-222222222222',
  (select id from t_sessions where case_name = 'conf_capture'),
  pg_temp.syn_hash('site-a-report'), 4096, 'application/pdf'));
insert into t_out values ('outcome_other_tenant_arg', pg_temp.try_outcome('22222222-2222-4222-8222-222222222222',
  (select id from t_sessions where case_name = 'conf_capture'), 'quarantined', 'hash_mismatch'));
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('b1_foreign_session', pg_temp.try_outcome('11111111-1111-4111-8111-111111111111',
  (select id from t_sessions where case_name = 'conf_capture'), 'quarantined', 'hash_mismatch'));
reset role;

select is((select result from t_out where case_name = 'register_other_tenant_arg'), '28000',
  '43 a company1 member cannot complete a company1 session through a company2 argument: the membership gate '
  || 'fires before the session is ever looked up, so the session id is not a way to reach another tenant (§4.2)');
select is((select result from t_out where case_name = 'outcome_other_tenant_arg'), '28000',
  '44 and the same for the outcome path: three entry points, one rule, no entry point where the tenant '
  || 'argument is taken on trust');
select is((select result from t_out where case_name = 'b1_foreign_session'), '28000',
  '45 a company2 admin naming company1 gets the membership refusal too — the answer a foreign tenant gets '
  || 'never varies by which capture RPC they tried, so the pair 43-45 gives a probe nothing (#13(2))');

-- ---------------------------------------------------------------- 46-54 the guard closes the state machine
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_sessions
  select 'guard_open', o_session_id, o_object_ref, o_state, o_reused
    from public.begin_upload_session_v1('11111111-1111-4111-8111-111111111111',
                                        '51000000-0000-4000-8000-000000000001',
                                        't112cguardopen', 'guard-open.pdf', null);
insert into t_sessions
  select 'guard_quar', o_session_id, o_object_ref, o_state, o_reused
    from public.begin_upload_session_v1('11111111-1111-4111-8111-111111111111',
                                        '51000000-0000-4000-8000-000000000001',
                                        't112cguardquar', 'guard-quarantine.pdf', null);
insert into t_sessions
  select 'guard_fail', o_session_id, o_object_ref, o_state, o_reused
    from public.begin_upload_session_v1('11111111-1111-4111-8111-111111111111',
                                        '51000000-0000-4000-8000-000000000001',
                                        't112cguardfail', 'guard-fail.pdf', null);
insert into t_out values
  ('quarantine_it', pg_temp.try_outcome('11111111-1111-4111-8111-111111111111',
      (select id from t_sessions where case_name = 'guard_quar'), 'quarantined', 'encrypted_pdf')),
  ('fail_it', pg_temp.try_outcome('11111111-1111-4111-8111-111111111111',
      (select id from t_sessions where case_name = 'guard_fail'), 'failed', 'hash_mismatch'));
reset role;

select is((select result from t_out where case_name = 'quarantine_it') || '/'
       || (select result from t_out where case_name = 'fail_it'), 'ok/ok',
  '46 the RPC can still close a session (awaiting_upload → quarantined / failed): 47-54 refuse moves *out* '
  || 'of a closed state, they do not seal the machine shut (#96 clause 2, §7.2 step 2)');

-- Separate statements, not one multi-row VALUES list: 49-51 depend on the transition before them having
-- happened, and a multi-row VALUES list makes the reader guess at evaluation order.
insert into t_out values ('owner_expiry', pg_temp.try_owner_sql(
  'update public.knowledge_upload_sessions set expires_at = now() - interval ''1 hour'' '
  || 'where id = (select id from t_sessions where case_name = ''guard_open'')'));
insert into t_out values ('member_state_update', pg_temp.try_as_authenticated(
  'update public.knowledge_upload_sessions set state = ''completed'' '
  || 'where id = (select id from t_sessions where case_name = ''guard_open'')'));
insert into t_out values ('expire_open', pg_temp.try_owner_sql(
  'update public.knowledge_upload_sessions set state = ''expired'' '
  || 'where id = (select id from t_sessions where case_name = ''guard_open'')'));
insert into t_out values ('expired_back_to_open', pg_temp.try_owner_sql(
  'update public.knowledge_upload_sessions set state = ''awaiting_upload'' '
  || 'where id = (select id from t_sessions where case_name = ''guard_open'')'));
insert into t_out values ('expired_to_completed', pg_temp.try_owner_sql(
  'update public.knowledge_upload_sessions set state = ''completed'', source_version_id = '
  || '(select source_version_id from t_versions where case_name = ''capture'') '
  || 'where id = (select id from t_sessions where case_name = ''guard_open'')'));
insert into t_out values ('quarantined_back_to_open', pg_temp.try_owner_sql(
  'update public.knowledge_upload_sessions set state = ''awaiting_upload'' '
  || 'where id = (select id from t_sessions where case_name = ''guard_quar'')'));
insert into t_out values ('failed_to_completed', pg_temp.try_owner_sql(
  'update public.knowledge_upload_sessions set state = ''completed'', source_version_id = '
  || '(select source_version_id from t_versions where case_name = ''capture'') '
  || 'where id = (select id from t_sessions where case_name = ''guard_fail'')'));
select is((select result from t_out where case_name = 'owner_expiry'), '23514',
  '47 expires_at cannot be moved at all, not even by the owner role the RPCs run as: extending a grant that '
  || 'already went out to a client is how a stale object key becomes a live one (#96 clause 2)');
select is((select result from t_out where case_name = 'member_state_update'), '42501',
  '48 a member still has no write path to a session row at all — the guard is the second net, not the first: '
  || 'the 42501 here is the table grant (`revoke all on public.knowledge_upload_sessions from anon, '
  || 'authenticated` at 20261106100000_knowledge_uploads.sql:595-596), with RLS as the net behind it (§6.2, B1)');
select is((select result from t_out where case_name = 'expire_open'), 'ok',
  '49 awaiting_upload → expired is the one move the future expiry sweep needs, and the guard allows it: the '
  || 'ruling closes the machine, it does not freeze the table (#96 clause 2)');
select is((select result from t_out where case_name = 'expired_back_to_open'), '23514',
  '50 expired is final: a re-opened upload issues a **new** session with a new key, it does not revive this one');
select is((select result from t_out where case_name = 'expired_to_completed'), '23514',
  '51 and an expired session cannot be completed after the fact, so "the grant had lapsed" stays the '
  || 'recorded truth even for a privileged writer (§7.2, §4.3)');
select is((select result from t_out where case_name = 'quarantined_back_to_open'), '23514',
  '52 quarantined is final: the reason an object was kept out of the corpus is audit information, and the '
  || 'constraint now guarantees "first refusal wins" for every writer instead of one function''s early return');
select is((select result from t_out where case_name = 'failed_to_completed'), '23514',
  '53 and failed cannot become completed: a refused capture that later arrives is a new session, which is '
  || 'also what the #40 delete-on-quarantine path assumes when it removes the stored object');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('outcome_twice', pg_temp.try_outcome('11111111-1111-4111-8111-111111111111',
  (select id from t_sessions where case_name = 'guard_quar'), 'failed', 'decompression_bomb'));
reset role;
select is((select result from t_out where case_name = 'outcome_twice') || '/'
       || (select state || ':' || coalesce(reason_code, '(none)') from public.knowledge_upload_sessions
            where id = (select id from t_sessions where case_name = 'guard_quar')),
  'ok/quarantined:encrypted_pdf',
  '54 a second outcome call on a quarantined session is still accepted by the RPC and still changes '
  || 'nothing — the first reason survives, and now the guard would have refused the write even if this '
  || 'function''s early return were ever removed (#96 clause 2, :561-563)');

select is((select string_agg(case_name || '=' || result, ' ' order by case_name) from t_out
            where case_name in ('clear_first', 'clear_after')),
  'clear_after=ok clear_first=ok',
  '55 both scope clears really ran and succeeded: assertion 21 claims the scope was cleared away first, '
  || 'and that claim is pinned here rather than left to a fixture nobody reads — it is also what makes 21 '
  || 'prove self-scoping rather than a scope inherited from an earlier call');

-- ------------------------------------------------------------ 56-57 the two cases #169 asked 041 to add
-- An active member of org A names org A correctly and reaches for a collection in org B, then for a
-- collection that does not exist at all. #169: those two answers must be one answer, so the RPC never
-- becomes a collection-existence oracle for a caller who is allowed one tenant and not another.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('err_foreign', pg_temp.try_begin_err('11111111-1111-4111-8111-111111111111',
      '52000000-0000-4000-8000-000000000001', 't112cerrfore', 'foreign.pdf')),
  ('err_unknown', pg_temp.try_begin_err('11111111-1111-4111-8111-111111111111',
      '59000000-0000-4000-8000-000000000099', 't112cerrunkn', 'unknown.pdf'));
reset role;
select is((select result from t_out where case_name = 'err_foreign'),
  (select result from t_out where case_name = 'err_unknown'),
  '56 the two refusals are the same string, code and message alike: 28 and 29 already hold that both are '
  || '''42501'', and this pins the message too, because a different message would tell a caller which of '
  || 'the two it hit (#169, #13(2))');

-- The other half of the #169 addition: a call with nobody behind it. The claim is reset rather than set
-- to '' so that auth.uid() is null for every reading of it, and the tenant id is a real one the caller '
-- does belong to, so the only thing that can refuse here is the missing user.
set local role authenticated;
reset request.jwt.claim.sub;
insert into t_out values ('unauth_begin', pg_temp.try_begin('11111111-1111-4111-8111-111111111111',
    '51000000-0000-4000-8000-000000000001', 't112cunauth', 'no-user.pdf', null));
reset role;
select is((select result from t_out where case_name = 'unauth_begin'), '28000',
  '57 an unauthenticated call is refused with 28000, by public.set_tenant_scope (20261105060000_tenancy_core.sql:208-210) running as the '
  || 'RPC''s own first statement: the tenant argument is real and the caller is a member, so the refusal '
  || 'can only be the missing user (#169, FAQ-0011)');

select * from finish();
rollback;
