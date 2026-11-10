-- T-111b collection admin RPC: `create_collection_v1`, `update_collection_v1`.
-- pgTAP slot 025 (docs/COORDINATION.md §6b). Packet: docs/tasks/T-111b-collection-admin-rpc.md,
-- decided in #41. Plan §4.3 (writes go through scoped RPCs), §6.1-§6.2 (class and audience rules in
-- one place), FAQ-0004 (the owning lane writes its own table; callers only call), and #60 + FAQ-0010
-- (EXECUTE revoked by full signature in the creating migration, granted back to `authenticated` only,
-- and both signatures added to 001_function_privileges.test.sql's rule-32 allow-list in this PR).
--
-- Fixtures are the synthetic rows supabase/seed.sql applies on `supabase db reset`:
--   orgs      company1 11111111-1111-4111-8111-111111111111 · company2 22222222-2222-4222-8222-222222222222
--   people    …a1 company1 admin · …a2 company1 member · …a3 company1 suspended · …b1 company2 admin
--   projects  41000000-…-001 Site A (org1, project-visible) · 41000000-…-002 field notes (org1,
--             tenant-wide) · 42000000-…-001 (company2)
--   seeded collections 51000000-…-001/…-002 (org1) · 52000000-…-001/…-002 (org2)
--
-- The `contributor` role of #39 is **created inside this transaction**, not in seed.sql: seed.sql is a
-- shared file, it has no contributor role, and 010_tenancy.test.sql counts the six seeded company1
-- permission rows and four role assignments, so a permanent row here would move another slot's numbers.
-- The file therefore ends with `rollback;` — pg_prove runs every file in its own session against one
-- freshly reset database, and a row left behind would make the suite order-dependent.
--
-- Two assumptions are pinned rather than hidden, and both are open questions on the record:
--   #154 `knowledge_collections` has no `description` column (knowledge_core.sql:77-110), so
--        `update_collection_v1` takes a name only. Tests 2 and 3 pin that: if the supervisor rules the
--        column should exist, test 3 fails on purpose and names exactly what to add.
--   #156 #41's "security invoker" cannot coexist with knowledge_core.sql:884-894, which gives
--        `authenticated` SELECT only ("SELECT only, on purpose (B1)", :896-901): an invoker body runs
--        as the caller and could not write the table, and granting direct INSERT/UPDATE is the
--        widening FAQ-0004 forbids. So these RPCs are SECURITY DEFINER with a pinned search_path, the
--        shape every merged write-path RPC already uses (knowledge_uploads.sql:126, 214, 333, 525) and
--        the shape #21 ruled for review_reclass_v1. Tests 4-7 pin the clause **and** that no request
--        role gained a direct write path.
begin;
create extension if not exists pgtap with schema extensions;

-- ---------------------------------------------------------------- helpers (pg_temp, security invoker)
-- An error is reported as its SQLSTATE instead of aborting the transaction — the 010 idiom — and each
-- helper reports what it looked for, so a red run says which object is missing rather than stopping.
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
  perform public.clear_tenant_scope();
  return 'ok';
exception when others then
  return sqlstate::text;
end;
$fn$;

create function pg_temp.try_create(p_key text, p_name text, p_service text,
                                   p_project_id uuid, p_data_class text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform public.create_collection_v1(p_key, p_name, p_service, p_project_id, p_data_class);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_rename(p_collection_id uuid, p_name text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.update_collection_v1(p_collection_id, p_name);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Privilege answer as text: a missing function reports itself instead of raising past the file.
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

-- 'definer=<bool> config=<proconfig, spaces stripped>' — the two facts 000_guardrails.test.sql cares
-- about, named. Spaces are stripped because PostgreSQL re-serializes the value list, and an assertion
-- that depends on whether a space survived the parser is a false failure waiting to happen.
create function pg_temp.definer_of(p_signature text) returns text
language plpgsql security invoker as $fn$
declare v_proc regprocedure := to_regprocedure(p_signature);
begin
  if v_proc is null then
    return 'no such function: ' || p_signature;
  end if;
  return (select 'definer=' || p.prosecdef || ' config=' ||
                 coalesce(nullif(replace(array_to_string(p.proconfig, ','), ' ', ''), ''), '(none)')
            from pg_proc p where p.oid = v_proc);
end;
$fn$;

-- The #39 contributor role, for the negative that separates capture permission from admin permission.
-- Written as the migration owner (RLS is enabled, not FORCEd, and tenant configuration has no member
-- write policies at all: knowledge_core.sql:870-875), inside this transaction, rolled back at the end.
insert into public.organisation_roles (id, organisation_id, key, name)
  values ('31000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
          'contributor', 'Contributor (synthetic, #39)')
  on conflict (organisation_id, key) do nothing;
insert into public.role_permissions (organisation_id, role_id, area, level)
  values ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000003',
          'knowledge.write', 'write')
  on conflict (role_id, area) do nothing;
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, '31000000-0000-4000-8000-000000000003'
  from public.organisation_memberships m
 where m.organisation_id = '11111111-1111-4111-8111-111111111111'
   and m.user_id = '00000000-0000-4000-8000-0000000000a2'
on conflict (membership_id, role_id) do nothing;

-- Results produced under the role under test, read back as the owner. The tables are created **as
-- `authenticated`**, the 010 idiom, because a temp table is owned by the role that created it and the
-- inserts below run while that role is set: created as the migration owner they would answer
-- `permission denied for table t_out` and abort the file (CI on 17faae1 caught exactly that).
set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_scope (case_name text, org uuid);
reset role;

select plan(39);

-- ---------------------------------------------------------------- shape, definer clause, privileges
select is(pg_temp.args_of('public.create_collection_v1(text,text,text,uuid,text)'),
  'p_key text, p_name text, p_service text, p_project_id uuid, p_data_class text',
  '1 create_collection_v1 has exactly the #41 signature: there is no organisation, user or actor '
  || 'parameter, so the tenant and the uploader cannot be forged (§4.1, F09)');

select is(pg_temp.args_of('public.update_collection_v1(uuid,text)'),
  'p_collection_id uuid, p_name text',
  '2 update_collection_v1 takes a collection and a name and nothing else — no data_class, no '
  || 'project_id, no organisation_id — so a future "convenience" parameter fails this suite (#41, #21)');

select hasnt_column('public', 'knowledge_collections', 'description',
  '3 (#154) and no description column exists either, which is why there is no p_description: if the '
  || 'supervisor rules the column should be added, this assertion fails on purpose and the RPC gains '
  || 'the parameter in that PR, not quietly in this one');

select is(pg_temp.definer_of('public.create_collection_v1(text,text,text,uuid,text)'),
  'definer=true config=search_path=public,pg_temp',
  '4 create_collection_v1 is SECURITY DEFINER with a pinned search_path — the shape of every merged '
  || 'write-path RPC (knowledge_uploads.sql:126) and of #21''s review_reclass_v1, because authenticated '
  || 'holds SELECT only on the knowledge tables (#156, flagged not assumed)');

select is(pg_temp.definer_of('public.update_collection_v1(uuid,text)'),
  'definer=true config=search_path=public,pg_temp',
  '5 and update_collection_v1 the same way; a definer without a pinned search_path would fail '
  || '000_guardrails.test.sql before this file ever ran');

select is(has_table_privilege('authenticated', 'public.knowledge_collections', 'insert'), false,
  '6 choosing definer did not buy a direct write door: authenticated still cannot insert into the '
  || 'collection table, so the RPC is the only path (FAQ-0004, B1 at knowledge_core.sql:896-901)');

select is(has_table_privilege('authenticated', 'public.knowledge_collections', 'update'), false,
  '7 and it still cannot update it, so class and audience cannot be forged around the RPC');

select is(pg_temp.priv_of('anon', 'public.create_collection_v1(text,text,text,uuid,text)'), 'false',
  '8 anon cannot execute create_collection_v1 (#60). Because anon is a member of PUBLIC, a false here '
  || 'also proves the default PUBLIC grant was revoked by name in the creating migration (FAQ-0010)');

select is(pg_temp.priv_of('anon', 'public.update_collection_v1(uuid,text)'), 'false',
  '9 anon cannot execute update_collection_v1 (#60, same argument for PUBLIC)');

select is(pg_temp.priv_of('authenticated', 'public.create_collection_v1(text,text,text,uuid,text)'), 'true',
  '10 create_collection_v1 is granted back to authenticated by name, and this PR adds the signature to '
  || '001_function_privileges.test.sql rule 32 so the generic allow-list rule keeps passing');

select is(pg_temp.priv_of('authenticated', 'public.update_collection_v1(uuid,text)'), 'true',
  '11 and update_collection_v1 likewise, with its own allow-list row');

-- ---------------------------------------------------------------- fail closed with no tenant scope
-- First, while nothing has been scoped in this transaction: no default tenant, no guessed tenant.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('noscope_clear', pg_temp.try_clear_scope()),
  ('noscope_create', pg_temp.try_create('noscope-corpus', 'No scope attempted', 'uav-compliance', null, 'public'));
reset role;

select is((select result from t_out where case_name = 'noscope_create'), '28000',
  '12 with no transaction scope the RPC refuses instead of writing into whichever tenant is closest '
  || 'to hand (§4.3 fail closed)');

-- ---------------------------------------------------------------- the admin path works
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('admin_scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111')),
  ('create_project_scoped', pg_temp.try_create('site-a-corpus', 'Site A corpus (synthetic)', 'uav-compliance',
                                               '41000000-0000-4000-8000-000000000001', 'internal')),
  ('create_tenant_wide', pg_temp.try_create('open-corpus', 'Open corpus (synthetic)', 'uav-compliance',
                                            null, 'public')),
  ('create_duplicate_key', pg_temp.try_create('site-a-corpus', 'Same key, second name', 'uav-compliance',
                                              '41000000-0000-4000-8000-000000000001', 'internal'));
insert into t_scope select 'admin', public.current_organisation_id();
reset role;

select is((select result from t_out where case_name = 'admin_scope'), 'ok',
  '13 the tenant admin can establish the scope the RPC then reads (the scope is never an argument)');
select is((select org from t_scope where case_name = 'admin'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '14 and company1 is the scope in force for the writes below');
select is((select result from t_out where case_name = 'create_project_scoped'), 'ok',
  '15 an admin creates a project-scoped internal collection (§6.1, #41)');
select is((select result from t_out where case_name = 'create_tenant_wide'), 'ok',
  '16 and a tenant-wide public one');
select is((select result from t_out where case_name = 'create_duplicate_key'), '23505',
  '17 the key is unique per tenant, and the second attempt is refused by the unique index '
  || '(knowledge_collections_organisation_id_key_key) rather than renaming or merging the corpus');

select is((select organisation_id from public.knowledge_collections where key = 'site-a-corpus'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '18 the row written belongs to the scoped tenant, not to a tenant named by the caller (§4.1)');
select is((select data_class from public.knowledge_collections where key = 'site-a-corpus'), 'internal',
  '19 and carries the class the caller asked for, having passed the merged class CHECKs (§6.2)');
select is((select project_id from public.knowledge_collections where key = 'site-a-corpus'),
  '41000000-0000-4000-8000-000000000001'::uuid,
  '20 and the audience it asked for: the project must belong to the caller''s tenant (#41)');
select is((select count(*)::int from public.knowledge_collections
            where key = 'open-corpus' and project_id is null), 1::int,
  '21 the tenant-wide collection exists with a null audience, the legal shape for a public corpus');

-- ---------------------------------------------------------------- another tenant's project
-- #153 asks whether the caller must also be a *member* of that project; until it is answered this
-- implements #41 literally, so the only rule enforced here is the tenant one.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('cross_tenant_project', pg_temp.try_create('stolen-project', 'Another tenant''s project', 'gpr',
                                              '42000000-0000-4000-8000-000000000001', 'internal'));
reset role;

select is((select result from t_out where case_name = 'cross_tenant_project'), '42501',
  '22 a company1 admin cannot bind a collection to a company2 project. The refusal comes from the RPC '
  || 'with the same code as any other permission failure, not from a raw 23503, so the other tenant is '
  || 'never named (#13(2))');
select is((select count(*)::int from public.knowledge_collections where key = 'stolen-project'), 0::int,
  '23 and nothing was written on the way to that refusal');

-- ---------------------------------------------------------------- class and argument rules
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('confidential_tenant_wide', pg_temp.try_create('conf-no-project', 'Confidential without a project',
                                                  'uav-compliance', null, 'client_confidential')),
  ('restricted_class', pg_temp.try_create('restricted-corpus', 'Restricted corpus', 'uav-compliance',
                                          '41000000-0000-4000-8000-000000000001', 'restricted')),
  ('bad_key_shape', pg_temp.try_create('Site A', 'Mixed-case key', 'uav-compliance', null, 'public')),
  ('blank_name', pg_temp.try_create('blank-name-corpus', '', 'uav-compliance', null, 'public'));
reset role;

select is((select result from t_out where case_name = 'confidential_tenant_wide'), '23514',
  '24 a tenant-wide client_confidential collection is refused by the merged CHECK '
  || '(knowledge_collections_confidential_requires_project, knowledge_core.sql:104-106)');
select is((select result from t_out where case_name = 'restricted_class'), '23514',
  '25 restricted is refused because it is not ingestible in M1 (data_class_is_ingestible_in_m1 at '
  || 'knowledge_core.sql:102-103)');
select is((select result from t_out where case_name = 'bad_key_shape'), '22023',
  '26 a malformed key is refused by the RPC, with a safe code, before any insert is attempted');
select is((select result from t_out where case_name = 'blank_name'), '22023',
  '27 and an empty name too: the RPC validates rather than leaning on the column check');

-- ---------------------------------------------------------------- a member and a contributor are refused
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values
  ('member_scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111')),
  ('member_create', pg_temp.try_create('member-corpus', 'Member attempts an admin write', 'uav-compliance',
                                       null, 'public')),
  ('member_rename', pg_temp.try_rename('51000000-0000-4000-8000-000000000001', 'Renamed by a member'));
reset role;

select is((select result from t_out where case_name = 'member_create'), '42501',
  '28 a company1 member holding knowledge.read cannot create a collection (packet line 31, #41)');
select is((select result from t_out where case_name = 'member_rename'), '42501',
  '29 and cannot rename one: the gate is knowledge.admin at level admin, not membership alone');
select is((select name from public.knowledge_collections where id = '51000000-0000-4000-8000-000000000001'),
  'UAV reference library (synthetic)',
  '30 the refused rename left the seeded collection exactly as the seed wrote it');

-- The same person, now also holding the #39 capture permission, is still refused.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values
  ('contributor_create', pg_temp.try_create('contributor-corpus', 'Contributor attempts an admin write',
                                            'uav-compliance', null, 'public'));
reset role;

select is((select result from t_out where case_name = 'contributor_create'), '42501',
  '31 a contributor (knowledge.write at write) is refused too: FAQ-0006 settles who may **upload into** '
  || 'a collection, not who may create one, and that predicate already lives in '
  || 'user_may_publish_into(uuid) — which #41 keeps out of this packet');

-- A suspended membership grants nothing (§4.2).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_out values
  ('suspended_scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111')),
  ('suspended_create', pg_temp.try_create('former-member', 'Suspended member attempts a write',
                                          'uav-compliance', null, 'public'));
reset role;

select is((select result from t_out where case_name = 'suspended_create'), '28000',
  '32 a suspended membership cannot scope, and the RPC refuses with set_tenant_scope''s own code '
  || 'rather than reaching the permission check (§4.2)');

-- ---------------------------------------------------------------- rename: name only
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('rename_ok', pg_temp.try_rename((select id from public.knowledge_collections where key = 'site-a-corpus'),
                                   'Site A corpus renamed (synthetic)')),
  ('rename_foreign_collection', pg_temp.try_rename('52000000-0000-4000-8000-000000000001',
                                                   'Renamed across tenants'));
reset role;

select is((select result from t_out where case_name = 'rename_ok'), 'ok',
  '33 the admin renames the collection through the RPC');
select is((select name from public.knowledge_collections where key = 'site-a-corpus'),
  'Site A corpus renamed (synthetic)',
  '34 and the name is what the RPC was given');
select is((select data_class from public.knowledge_collections where key = 'site-a-corpus'), 'internal',
  '35 the rename changed no class: raising a class is review_reclass_v1 in T-213, and this RPC has no '
  || 'way to reach it (#21 closed as ruled, #41)');
select is((select project_id from public.knowledge_collections where key = 'site-a-corpus'),
  '41000000-0000-4000-8000-000000000001'::uuid,
  '36 nor the audience: clearing project_id would widen a confidential corpus to the whole tenant (§6.2, '
  || 'the column comment at knowledge_core.sql:113-114)');
select is((select result from t_out where case_name = 'rename_foreign_collection'), '42501',
  '37 a company1 admin cannot rename a company2 collection — and it is the same code as for a '
  || 'collection that does not exist, so the attempt learns nothing about the other tenant (#13(2))');
select is((select name from public.knowledge_collections where id = '52000000-0000-4000-8000-000000000001'),
  'GPR reference library (synthetic)',
  '38 and company2''s row is untouched');

-- The created row is readable through the ordinary policies by the member who created it: a definer
-- write path must not become a read bypass.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('readable_count',
  (select count(*)::int::text from public.knowledge_collections where key = 'site-a-corpus'));
reset role;

select is((select result from t_out where case_name = 'readable_count'), '1',
  '39 the new collection is visible to a member of its own project through the existing SELECT '
  || 'policies (collection_is_readable, knowledge_core.sql:907) — the RPC wrote a normal row');

select * from finish();
rollback;
