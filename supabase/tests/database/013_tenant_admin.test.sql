-- T-202 PR-1 — the tenant-admin scoped RPCs and the `policy_revision` writer.
-- pgTAP slot 013 (docs/COORDINATION.md §6b: "013 | 013_tenant_admin | T-202 (also policy_revision,
-- #98)"). Packet: docs/tasks/T-202-tenant-admin.md with its 2026-11-09 supervisor rulings, which
-- supersede the packet body. The packet Status / Out of scope make this file the **database half**:
-- the admin pages, `src/components/admin/`, the collection UI and the brand-fallback banner are
-- T-202 PR-2, so nothing here touches a page, and the collection page calls T-111b's RPCs (slot 025),
-- not anything new (FAQ-0004 / #41: this packet writes no knowledge table).
-- Migration under test: supabase/migrations/20261120215000_tenant_admin_rpc.sql.
--
-- What is under test, and the packet box it answers:
--   * the FAQ-0010 grants and revokes, the signatures, the definer clause, and the FAQ-0011
--     first-statement rule pinned for all five RPCs by pg_proc.provolatile
--   * no direct write door came with the definer path
--   * no admin RPC activates; a catalog pin over the 001 allow-list refuses any authenticated-
--     granted function (except redeem_invitation_v1 once it exists) that inserts active membership
--     or writes status='active' (B2/B6); invite_member_v1 is out of this PR (PR-1b)
--   * a company1 admin cannot read or modify company2 rows, and a company2 `project_id`
--     or `role_id` is refused by the composite FK with 23503, never ignored
--   * a member without the matching `*.admin` level is refused; a suspended membership fails as
--     **actor and as target**; demotion and removal bite on the next request
--   * a malformed key, visibility or null id is a validation error with no partial write
--   * every qualifying write moves `policy_revision`, and a no-op does not **and may not recurse**
--   * the fifteen triggers, the two catalog comments #98 asks for, and the merged projects trigger
--     this migration drops
--
-- Fixtures are the synthetic rows supabase/seed.sql applies on `supabase db reset` (ids are fixed so
-- tests can name them): company1 11111111-1111-4111-8111-111111111111 with owner …a1 (holds the
-- `admin` role, i.e. `members.admin`, `projects.admin`, `knowledge.admin` at `admin`), member …a2
-- (`chat.ask`, `knowledge.read`, `projects.read` only), suspended …a3, dual-tenant …a4 (`member` in
-- both tenants); company2 22222222-2222-4222-8222-222222222222 with owner …b1 and …a4, and note what
-- …b1 is **not**: company2 defines one role only (`member`, 32000000-…-001), and the seed's
-- role-assignment insert matches on the key `admin` for …b1, so no `membership_roles` row for …b1 exists
-- in company2 at all. …b1 is company2's owner by identity, not by permission, and holds no company1
-- membership at seed time. Projects: 41000000-…-001 Site A (company1,
-- project-visible; …a1 and …a4 are members), 41000000-…-002 field notes (company1, tenant-wide),
-- 42000000-…-001 (company2; …b1 is a member). Roles: 31000000-…-001 member, 31000000-…-002 admin
-- (company1); 32000000-…-001 member (company2).
--
-- Two fixtures this file needs and seed.sql does not have are written **inside this transaction** just
-- below the helpers — a synthetic company2 `projects.admin`/`members.admin` role granted to …b1, and two
-- identities with no membership in either tenant — because other slots pin the seeded counts and this PR
-- may not re-pin files it does not own (FAQ-0007). `025_collection_admin.test.sql:18-22` documents the
-- same trap and takes the same workaround.
--
-- Nothing is written outside the RPCs except where a test says so in its own name: the role
-- permission-matrix writes (132-135) and the tenant status writes (136-140) are owner-run inside a
-- savepoint and rolled back; the suspended-member project row (129) and the project rename (166-167) are
-- owner-run inside the transaction this file rolls back; the colliding identity/profile pair the
-- ambiguity fixture needs (168-169) is an owner-run fixture write at the end of the file, where no
-- earlier count can see it; and the five-table no-op group (147-156) issues
-- statements that must write nothing at all, which is the very fact that group exists to pin. The file
-- ends with `rollback;`, so a row written here cannot move
-- another slot's counts: `010_tenancy.test.sql` counts the seeded company1 roles and permissions and
-- `017_scoped_identity_reads.test.sql` counts the seeded company1 memberships, and this file's writes
-- must never reach them.
--
-- What only CI can prove: `auth.uid()` is Supabase's reader of the request's JWT claims, so every
-- identity-dependent branch (member vs admin, suspended, the invited row, another tenant's member)
-- runs against the real `auth` schema in the `database` job. `pnpm db:test` needs Docker, which no
-- builder machine has (FAQ-0009), so CI is the venue: nothing here is faked to pass locally, and the
-- counts in `select plan(N)` are derived by hand from the numbered assertions below.
begin;
create extension if not exists pgtap with schema extensions;

-- ---------------------------------------------------------------- helpers (pg_temp, security invoker)
-- An error is reported as its SQLSTATE instead of aborting the transaction — the 010/025 idiom — and
-- a missing function reports itself, so a red run names the object that is absent rather than
-- stopping at the first catalog lookup. Every helper mirrors the RPC signature with
-- `p_organisation_id` first (FAQ-0011), so a caller who gets the order wrong gets a type error here
-- rather than an accidental pass.
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

create function pg_temp.try_grant(p_organisation_id uuid, p_user_id uuid, p_role_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.grant_membership_role_v1(p_organisation_id, p_user_id, p_role_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_revoke(p_organisation_id uuid, p_user_id uuid, p_role_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.revoke_membership_role_v1(p_organisation_id, p_user_id, p_role_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_project(p_organisation_id uuid, p_key text, p_name text, p_visibility text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform public.create_project_v1(p_organisation_id, p_key, p_name, p_visibility);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.id_of_project(p_organisation_id uuid, p_key text, p_name text, p_visibility text)
returns text language plpgsql security invoker as $fn$
declare v_id uuid;
begin
  v_id := public.create_project_v1(p_organisation_id, p_key, p_name, p_visibility);
  return coalesce(v_id::text, 'returned null');
exception when others then
  return 'error:' || sqlstate;
end;
$fn$;

create function pg_temp.try_add_member(p_organisation_id uuid, p_project_id uuid, p_user_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform public.add_project_member_v1(p_organisation_id, p_project_id, p_user_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_remove_member(p_organisation_id uuid, p_project_id uuid, p_user_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform public.remove_project_member_v1(p_organisation_id, p_project_id, p_user_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Catalog readers, so a missing function or a changed signature says which object it looked for.
create function pg_temp.priv_of(p_role text, p_signature text) returns text
language plpgsql security invoker as $fn$
declare v_proc regprocedure := to_regprocedure(p_signature);
begin
  if v_proc is null then
    return 'no such function: ' || p_signature;
  end if;
  return has_function_privilege(p_role, v_proc, 'execute')::text;
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
-- about, named. Spaces are stripped because PostgreSQL re-serializes the list.
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

-- FAQ-0011 rule 4 (as #163 pinned it in 025 tests 40-41): an RPC that establishes the tenant scope is
-- volatile, because `set_config` is volatile. Read from `pg_proc.provolatile`, not from the migration
-- text: plpgsql defaults to 'v', so a check on the text would pass by accident today and lose the fact
-- the moment someone writes `stable` into a body. 'v' volatile · 's' stable · 'f' immutable.
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

-- #98: the revision, read as text by the migration owner outside a role block, before and after the
-- statement under test. A difference of exactly 1 is the pin; a difference of 0 is the no-op pin.
create function pg_temp.rev_of(p_organisation_id uuid) returns bigint
language sql stable security invoker as $fn$
  select policy_revision from public.organisations where id = p_organisation_id;
$fn$;

-- Owner-run statements, for the two writes no RPC performs (the permission matrix, the tenant status)
-- and for the no-op updates. Same shape as 040's `try_owner_update`.
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

-- Capture tables are created by the role that fills them (010/025/040 idiom: a temp table is owned by
-- its creator, and the inserts below run while `authenticated` is set), and the assertions then read
-- them back as the migration owner.
set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_rev (case_name text, before_rev bigint, after_rev bigint);
create temp table t_read (case_name text, n int);
reset role;

-- ---------------------------------------------------------------- transaction-local fixtures
-- Two things this suite needs that seed.sql does not provide, both written **inside this transaction**
-- and removed by the `rollback;` at the end. seed.sql is a shared file (AGENTS.md §3) and other slots pin
-- its counts — `010_tenancy.test.sql` tests 44-45 count the company1 role definitions, permission rows
-- and role assignments, `017_scoped_identity_reads.test.sql` test 10 counts the company1 memberships — so
-- a permanent row would move assertions this PR may not edit (FAQ-0007). `025_collection_admin.test.sql:18-22`
-- documents exactly this trap and takes the same workaround, and `040_knowledge_uploads.test.sql:204-219`
-- does the same for its publisher roles.
--
-- (a) A company2 role holding `projects.admin` and `members.admin` at `admin`, granted to …b1.
-- seed.sql gives …b1 **no role row at all**: company2 defines only `member` (`32000000-…-001`), and the
-- seed's `membership_roles` insert matches on the key `admin` for …b1, which company2 has no such role
-- for — so the row is never created. Without it, …b1 naming company2 and a company1 project id would stop
-- at the `projects.admin` gate (42501) and the composite FK would never speak, which is the packet's
-- negative box ("a company2 `project_id` is refused with 23503, never silently ignored"). The grant is the
-- fixture; the 23503 is the subject. `members.admin` rides along on the same role so the target-lookup
-- refusal (a company1 user id inside a company2 scope) can be pinned too.
--
-- Id landmine, recorded in the migration at section 4: `31000000-…-003` is taken (040:210 and 025:191),
-- and `32000000-…-002` is taken by 040:211. This extends the seeded company2 range to …-003, which nothing
-- else uses.
insert into public.organisation_roles (id, organisation_id, key, name)
  values ('32000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222',
          'tenant-admin', 'Tenant admin (synthetic, 013)')
  on conflict (organisation_id, key) do nothing;
insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('22222222-2222-4222-8222-222222222222', '32000000-0000-4000-8000-000000000003', 'projects.admin', 'admin'),
  ('22222222-2222-4222-8222-222222222222', '32000000-0000-4000-8000-000000000003', 'members.admin', 'admin')
  on conflict (role_id, area) do nothing;
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, '32000000-0000-4000-8000-000000000003'
  from public.organisation_memberships m
 where m.organisation_id = '22222222-2222-4222-8222-222222222222'
   and m.user_id = '00000000-0000-4000-8000-0000000000b1'
on conflict (membership_id, role_id) do nothing;

-- (b) Three synthetic identities. …c3 and …c4 hold **no membership in either tenant**, so "not a member
-- here" is a row state that exists rather than one the code only imagines: …c4 is a no-membership
-- profile for grant negatives; …c3 is reserved for PR-1b. …c5 carries a company1 membership at
-- **`removed`**, the state `supabase/seed.sql` never writes (its six seeded rows are five `active`
-- and one `suspended`, :53-61), and `removed` is one of the two statuses the widened writes refuse
-- rather than reinstate. Reusing …a3 would not do, because that row is `suspended` and …a3 loses its
-- role rows later in this file.
-- `profiles.id` references `auth.users`, so the identity rows go in too, exactly as seed.sql and
-- `011_identity.test.sql:176-193` create them (the precedent for synthetic identities inside a pgTAP file;
-- :195-198 in the same file is the precedent for the `removed` membership row).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'newcomer@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Synthetic Newcomer"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'outsider@example.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Synthetic Non-Member"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'departed@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Synthetic Departed Member"}'::jsonb)
on conflict (id) do nothing;

insert into public.profiles (id, email, display_name) values
  ('00000000-0000-4000-8000-0000000000c3', 'newcomer@company1.test', 'Synthetic Newcomer'),
  ('00000000-0000-4000-8000-0000000000c4', 'outsider@example.test', 'Synthetic Non-Member'),
  ('00000000-0000-4000-8000-0000000000c5', 'departed@company1.test', 'Synthetic Departed Member')
on conflict (id) do nothing;

-- …c5's ended membership, on the seeded unique key (organisation_id, user_id). `removed` rather than
-- `suspended`, because the two widened writes refuse both and the file pins each with a different target:
-- …a3 for the suspended grant refusal (supabase/seed.sql:57) and this one for removed.
insert into public.organisation_memberships (organisation_id, user_id, status)
  values ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000c5', 'removed')
on conflict (organisation_id, user_id) do nothing;

-- …b1 invited into company1 as a fixture only. `invite_member_v1` is out of this PR (PR-1b), but the
-- CHECK still admits `invited` and grant/revoke must leave that status alone (no admin activate).
insert into public.organisation_memberships (organisation_id, user_id, status)
  values ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000b1', 'invited')
on conflict (organisation_id, user_id) do nothing;

-- 137 numbered assertions below; pgTAP fails if plan and finish() disagree.
select plan(137);

-- ================================================================ privileges, shape, no activate
-- PostgreSQL hands EXECUTE on a new function in `public` to PUBLIC, and a migration cannot close that
-- default (FAQ-0010, #142), so the revoke by full signature inside the creating migration is what
-- these assertions are really testing. Every name here is also on `001_function_privileges.test.sql`'s
-- rule-32 allow-list, in this same PR.
select is(pg_temp.priv_of('anon', 'public.grant_membership_role_v1(uuid,uuid,uuid)'), 'false',
  '1 anon cannot execute grant_membership_role_v1');
select is(pg_temp.priv_of('anon', 'public.revoke_membership_role_v1(uuid,uuid,uuid)'), 'false',
  '2 anon cannot execute revoke_membership_role_v1');
select is(pg_temp.priv_of('anon', 'public.create_project_v1(uuid,text,text,text)'), 'false',
  '3 anon cannot execute create_project_v1');
select is(pg_temp.priv_of('anon', 'public.add_project_member_v1(uuid,uuid,uuid)'), 'false',
  '4 anon cannot execute add_project_member_v1');
select is(pg_temp.priv_of('anon', 'public.remove_project_member_v1(uuid,uuid,uuid)'), 'false',
  '5 anon cannot execute remove_project_member_v1');
select is(pg_temp.priv_of('anon', 'public.bump_policy_revision()'), 'false',
  '6 anon cannot execute bump_policy_revision');
select is(pg_temp.priv_of('authenticated', 'public.bump_policy_revision()'), 'false',
  '7 authenticated cannot execute bump_policy_revision (trigger fires without EXECUTE)');
select is(pg_temp.priv_of('service_role', 'public.bump_policy_revision()'), 'false',
  '8 service_role cannot execute bump_policy_revision');
select is(pg_temp.priv_of('service_role', 'public.grant_membership_role_v1(uuid,uuid,uuid)'), 'false',
  '9 service_role holds no grant on the admin writes');
select is(pg_temp.priv_of('service_role', 'public.add_project_member_v1(uuid,uuid,uuid)'), 'false',
  '10 …and not on the project-audience write either');

select is(pg_temp.priv_of('authenticated', 'public.grant_membership_role_v1(uuid,uuid,uuid)'), 'true',
  '11 grant_membership_role_v1 is granted to authenticated');
select is(pg_temp.priv_of('authenticated', 'public.revoke_membership_role_v1(uuid,uuid,uuid)'), 'true',
  '12 revoke_membership_role_v1 likewise');
select is(pg_temp.priv_of('authenticated', 'public.create_project_v1(uuid,text,text,text)'), 'true',
  '13 create_project_v1 likewise');
select is(pg_temp.priv_of('authenticated', 'public.add_project_member_v1(uuid,uuid,uuid)'), 'true',
  '14 add_project_member_v1 likewise');
select is(pg_temp.priv_of('authenticated', 'public.remove_project_member_v1(uuid,uuid,uuid)'), 'true',
  '15 remove_project_member_v1 likewise');
select ok(to_regprocedure('public.invite_member_v1(uuid,text)') is null,
  '16 invite_member_v1 is not in this PR (lands in T-202 PR-1b)');

select is(pg_temp.args_of('public.grant_membership_role_v1(uuid,uuid,uuid)'),
  'p_organisation_id uuid, p_user_id uuid, p_role_id uuid',
  '17 grant_membership_role_v1 takes tenant first (FAQ-0011)');
select is(pg_temp.args_of('public.revoke_membership_role_v1(uuid,uuid,uuid)'),
  'p_organisation_id uuid, p_user_id uuid, p_role_id uuid',
  '18 revoke_membership_role_v1 likewise');
select is(pg_temp.args_of('public.create_project_v1(uuid,text,text,text)'),
  'p_organisation_id uuid, p_key text, p_name text, p_visibility text',
  '19 create_project_v1 likewise');
select is(pg_temp.args_of('public.add_project_member_v1(uuid,uuid,uuid)'),
  'p_organisation_id uuid, p_project_id uuid, p_user_id uuid',
  '20 add_project_member_v1 likewise');
select is(pg_temp.args_of('public.remove_project_member_v1(uuid,uuid,uuid)'),
  'p_organisation_id uuid, p_project_id uuid, p_user_id uuid',
  '21 remove_project_member_v1 likewise');
select is(pg_temp.definer_of('public.create_project_v1(uuid,text,text,text)'),
  'definer=true config=search_path=public,pg_temp',
  '22 create_project_v1 is SECURITY DEFINER with pinned search_path');
select is(pg_temp.definer_of('public.add_project_member_v1(uuid,uuid,uuid)'),
  'definer=true config=search_path=public,pg_temp',
  '23 add_project_member_v1 likewise');
select is(pg_temp.definer_of('public.bump_policy_revision()'),
  'definer=true config=search_path=public,pg_temp',
  '24 bump_policy_revision is SECURITY DEFINER with pinned search_path');
select is(pg_temp.vol_of('public.grant_membership_role_v1(uuid,uuid,uuid)'), 'v',
  '25 grant_membership_role_v1 is volatile (sets tenant scope)');
select is(pg_temp.vol_of('public.revoke_membership_role_v1(uuid,uuid,uuid)'), 'v',
  '26 revoke_membership_role_v1 likewise');
select is(pg_temp.vol_of('public.create_project_v1(uuid,text,text,text)'), 'v',
  '27 create_project_v1 likewise');
select is(pg_temp.vol_of('public.add_project_member_v1(uuid,uuid,uuid)'), 'v',
  '28 add_project_member_v1 likewise');
select is(pg_temp.vol_of('public.remove_project_member_v1(uuid,uuid,uuid)'), 'v',
  '29 remove_project_member_v1 likewise');

select is(has_table_privilege('authenticated', 'public.organisation_memberships', 'insert'), false,
  '30 authenticated still cannot insert a membership directly');
select is(has_table_privilege('authenticated', 'public.organisation_memberships', 'update'), false,
  '31 …nor update one');
select is(has_table_privilege('authenticated', 'public.membership_roles', 'insert'), false,
  '32 …nor grant themselves a role');
select is(has_table_privilege('authenticated', 'public.membership_roles', 'delete'), false,
  '33 …nor remove one');
select is(has_table_privilege('authenticated', 'public.role_permissions', 'update'), false,
  '34 …nor edit the permission matrix');
select is(has_table_privilege('authenticated', 'public.projects', 'insert'), false,
  '35 …nor create a project outside the RPC');
select is(has_table_privilege('authenticated', 'public.project_memberships', 'insert'), false,
  '36 …nor widen a project audience directly');
select is(has_table_privilege('authenticated', 'public.project_memberships', 'delete'), false,
  '37 …nor narrow one');
select is(has_table_privilege('authenticated', 'public.organisations', 'update'), false,
  '38 …nor move a tenant status');

-- B2/B6: no admin activate; catalog pin over authenticated-granted functions.
select ok(not exists (
  select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'activate_membership_v1'
), '39 no public.activate_membership_v1: claim is T-201 redeem_invitation_v1 (#186)');

select is_empty($$
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and p.proname is distinct from 'redeem_invitation_v1'
     and (
       p.prosrc ~* 'set[[:space:]]+status[[:space:]]*=[[:space:]]*''active'''
       or (
         p.prosrc ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?organisation_memberships'
         and p.prosrc ~* '''active'''
       )
     )
$$, '40 no authenticated-granted function (except redeem_invitation_v1 once it exists) inserts an '
  || 'active membership or writes status=''active'' (B2/B6 catalog pin over the 001 allow-list)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('invited_scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;
select is((select result from t_out where case_name = 'invited_scope'), '28000',
  '41 invited membership cannot establish tenant scope (tenancy_core.sql:214; claim is T-201)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('grant_invited_b1', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                                '00000000-0000-4000-8000-0000000000b1',
                                                                '31000000-0000-4000-8000-000000000001'));
insert into t_out values ('revoke_invited_b1', pg_temp.try_revoke('11111111-1111-4111-8111-111111111111',
                                                                  '00000000-0000-4000-8000-0000000000b1',
                                                                  '31000000-0000-4000-8000-000000000001'));
reset role;
select ok((select result from t_out where case_name = 'grant_invited_b1') = 'ok'
      and (select result from t_out where case_name = 'revoke_invited_b1') = 'ok'
      and (select status from public.organisation_memberships
            where organisation_id = '11111111-1111-4111-8111-111111111111'
              and user_id = '00000000-0000-4000-8000-0000000000b1') = 'invited',
  '42 grant/revoke on an invited row leave status `invited` (no admin RPC activates)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_read select 'a1_own_after_fixture', count(*)::int from public.organisation_memberships;
reset role;
select is((select n from t_read where case_name = 'a1_own_after_fixture'), 1::int,
  '43 memberships_read_own is still the ceiling: no member-list read RPC in PR-1');

select is((select status from public.organisation_memberships
            where organisation_id = '11111111-1111-4111-8111-111111111111'
              and user_id = '00000000-0000-4000-8000-0000000000a3'), 'suspended',
  '44 suspended fixture …a3 is unchanged (widening writes refuse it as a target below)');
select is((select status from public.organisation_memberships
            where organisation_id = '11111111-1111-4111-8111-111111111111'
              and user_id = '00000000-0000-4000-8000-0000000000c5'), 'removed',
  '45 removed fixture …c5 is unchanged');

-- ================================================================ 66-81 cross-tenant refusals
-- Negative box 2: a company1 admin cannot read or modify company2 rows, and a company2 id
-- is refused by the composite FK with 23503 — never silently ignored.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('grant_into_c2', pg_temp.try_grant('22222222-2222-4222-8222-222222222222',
                                                             '00000000-0000-4000-8000-0000000000a2',
                                                             '32000000-0000-4000-8000-000000000001'));
insert into t_out values ('xtenant_add_project', pg_temp.try_add_member('11111111-1111-4111-8111-111111111111',
                                                                       '42000000-0000-4000-8000-000000000001',
                                                                       '00000000-0000-4000-8000-0000000000a2'));
insert into t_out values ('xtenant_remove_project', pg_temp.try_remove_member(
  '11111111-1111-4111-8111-111111111111', '42000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000b1'));
insert into t_out values ('xtenant_grant_role', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                                  '00000000-0000-4000-8000-0000000000a2',
                                                                  '32000000-0000-4000-8000-000000000001'));
reset role;

select is((select result from t_out where case_name = 'grant_into_c2'), '28000',
  '46 a company1 admin naming company2 is refused by set_tenant_scope before the members.admin gate');
-- Read **after `reset role`**, as the migration owner. Under `authenticated` the only policy on
-- `organisation_memberships` is `memberships_read_own` (tenancy_core.sql:290-292, `user_id = auth.uid()`),
-- so the same count inside the role block answers 1 for …a1's own company1 row and would pin the read
-- policy rather than the other tenant's row count. Capturing the RPC answers under the role and counting
-- the tables as the owner is the house idiom — `017_scoped_identity_reads.test.sql:95-112`, where the
-- capture block ends at `reset role;` (:101) and the fixture count runs as the owner (:110-112).
select is((select count(*)::int from public.organisation_memberships
            where organisation_id = '22222222-2222-4222-8222-222222222222'), 2::int,
  '59 and company2 still holds exactly its two seeded memberships — the refusal wrote nothing in the '
  || 'other tenant (seed: …b1 and …a4)');
select is((select result from t_out where case_name = 'xtenant_add_project'), '23503',
  '60 a company2 project id in a company1 add is refused by the composite (project_id, organisation_id) '
  || 'FK with 23503, which is the packet''s negative box stated exactly: the reference is impossible, '
  || 'not filtered away (tenancy_core.sql:146-148)');
select is((select count(*)::int from public.project_memberships
            where project_id = '42000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-0000000000a2'), 0::int,
  '61 and no row of any kind was written for that attempt, in either tenant');
select is((select result from t_out where case_name = 'xtenant_remove_project'), '42501',
  '62 a company2 project id on the removal side is refused rather than silently matching nothing — a '
  || 'DELETE has no FK to raise, so the tenant-bounded existence check carries the same rule, with the '
  || 'same code as any other permission failure so the attempt learns nothing about the other tenant '
  || '(#13(2))');
select is((select count(*)::int from public.project_memberships
            where project_id = '42000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-0000000000b1'), 1::int,
  '63 company2''s own membership for that project survives, untouched');
select is((select result from t_out where case_name = 'xtenant_grant_role'), '23503',
  '64 a company2 role id in a company1 grant is refused by the composite FK to '
  || 'organisation_roles (id, organisation_id) — the same 23503 mechanism, not a WHERE filter');
-- The table is (id, organisation_id, membership_id, role_id, created_at): there is no user_id column, so
-- the guard counts assignments by the columns that exist — role id **and** tenant.
select is((select count(*)::int from public.membership_roles
            where role_id = '32000000-0000-4000-8000-000000000001'
              and organisation_id = '11111111-1111-4111-8111-111111111111'), 0::int,
  '65 and the failed grant assigned company2''s role to nobody in company1: no membership_roles row names '
  || 'that role id with a company1 organisation_id, which is precisely the row the composite FK '
  '(role_id, organisation_id) -> organisation_roles (id, organisation_id) refused to let the INSERT write');
select is((select count(*)::int from public.membership_roles
            where role_id = '31000000-0000-4000-8000-000000000001'
              and organisation_id = '11111111-1111-4111-8111-111111111111'), 3::int,
  '52 (fixture, non-vacuity guard) company1 `member` role still has three assignments '
  || '(seed …a2/…a3/…a4; invited b1 grant/revoke above left no lasting assignment)');

-- …b1 is an active member of company2 but holds **no role row there** (seed.sql: company2 defines only
-- `member`, and the seed's role-assignment insert matches on the key `admin`, which company2 has no role
-- for). The transaction-local grant at the top of this file is what gets the call past the
-- `projects.admin` / `members.admin` gates, so that the facts under test are the two the RPC leaves to
-- the data: the composite FK (23503) and the tenant-bounded target lookup (42501).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('b1_xtenant_add', pg_temp.try_add_member('22222222-2222-4222-8222-222222222222',
                                                                   '41000000-0000-4000-8000-000000000001',
                                                                   '00000000-0000-4000-8000-0000000000b1'));
reset role;

select is((select result from t_out where case_name = 'b1_xtenant_add'), '23503',
  '53 …b1 (company2 admin via synthetic role; company1 invited fixture) cannot point a company2 '
  || 'project membership at company1''s Site A');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_read select 'a1_c2_roles', count(*)::int from public.organisation_roles
 where organisation_id = '22222222-2222-4222-8222-222222222222';
insert into t_read select 'a1_c2_projects', count(*)::int from public.projects
 where organisation_id = '22222222-2222-4222-8222-222222222222';
insert into t_read select 'a1_c2_memberships', count(*)::int from public.organisation_memberships
 where organisation_id = '22222222-2222-4222-8222-222222222222';
insert into t_read select 'a1_own_memberships', count(*)::int from public.organisation_memberships;
reset role;

select is((select n from t_read where case_name = 'a1_c2_roles'), 0::int,
  '68 under the company1 scope the admin reads no company2 role definition (§4.1 step 4, §4.3)');
select is((select n from t_read where case_name = 'a1_c2_projects'), 0::int,
  '69 …and no company2 project row');
select is((select n from t_read where case_name = 'a1_c2_memberships'), 0::int,
  '70 …and no company2 membership row: "cannot read" is pinned on the read side, not only asserted by '
  || 'the absence of a write RPC');
select is((select n from t_read where case_name = 'a1_own_memberships'), 1::int,
  '71 and the same select over the whole table answers only their own row, which is the read policy '
  || 'doing its job rather than this PR widening anything');

-- ================================================================ 82-102 the permission gate, and
-- demotion and removal biting on the next request (negative box 3)
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('member_grant', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                           '00000000-0000-4000-8000-0000000000a2',
                                                           '31000000-0000-4000-8000-000000000001'));
insert into t_out values ('member_project', pg_temp.try_project('11111111-1111-4111-8111-111111111111',
                                                                'member-project', 'Member attempt',
                                                                'project'));
insert into t_out values ('member_add_member', pg_temp.try_add_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000a2'));
reset role;

select is((select result from t_out where case_name = 'member_grant'), '42501',
  '54 a company1 member without `members.admin` cannot grant a role');
select is((select result from t_out where case_name = 'member_project'), '42501',
  '55 …cannot create a project without `projects.admin`');
select is((select result from t_out where case_name = 'member_add_member'), '42501',
  '56 …cannot widen a project audience');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_out values ('suspended_project', pg_temp.try_project('11111111-1111-4111-8111-111111111111',
                                                                   'former-project', 'Suspended attempt',
                                                                   'project'));
insert into t_out values ('suspended_grant', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                               '00000000-0000-4000-8000-0000000000a2',
                                                               '31000000-0000-4000-8000-000000000001'));
reset role;

select is((select result from t_out where case_name = 'suspended_project'), '28000',
  '57 a suspended membership''s project write fails at set_tenant_scope');
select is((select result from t_out where case_name = 'suspended_grant'), '28000',
  '58 …and so does a grant: a deactivated membership grants nothing on this surface');

-- …a3 is not only a dead **actor**: the two writes that *widen* also refuse a suspended or removed
-- **target** (AGENTS.md §4.2's deactivated-member case and the packet's "a suspended membership's admin
-- call fails" box), because a role or a project audience granted to a member the tenant has cut off is a
-- permission waiting to bite on a reinstatement this migration never performs. The two writes that
-- *narrow* keep no status filter on purpose — a tenant must always be able to take an audience away from
-- someone it has already cut off. Both halves are pinned here, with the teeth of each on the row counts.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('grant_suspended_target', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                                     '00000000-0000-4000-8000-0000000000a3',
                                                                     '31000000-0000-4000-8000-000000000002'));
insert into t_out values ('revoke_suspended_target',
  pg_temp.try_revoke('11111111-1111-4111-8111-111111111111',
                     '00000000-0000-4000-8000-0000000000a3',
                     '31000000-0000-4000-8000-000000000001'));
reset role;

select is((select result from t_out where case_name = 'grant_suspended_target'), '42501',
  '78 an admin cannot hand company1''s `admin` role to a suspended membership: the target lookup admits only '
  || 'a membership that is `invited` or `active`, and the answer is the same code and wording as any other '
  || 'missing row, so the attempt cannot tell a suspension from a stranger (#13(2))');
select is((select count(*)::int from public.membership_roles mr
            join public.organisation_memberships m on m.id = mr.membership_id
           where m.user_id = '00000000-0000-4000-8000-0000000000a3'
             and mr.role_id = '31000000-0000-4000-8000-000000000002'), 0::int,
  '79 and the refused grant wrote no assignment: no `admin`-level permission is sitting there waiting for '
  || 'the suspension to end (§4.2)');
select is((select result from t_out where case_name = 'revoke_suspended_target'), 'ok',
  '80 the narrowing half keeps no status filter on purpose: the admin can take the seeded `member` role away '
  || 'from the suspended membership, which is a state a tenant must always be able to reach (the revoke '
  || 'path has no `status in (…)` clause, and this is the assertion that fails if one is ever added)');
select is((select count(*)::int from public.membership_roles mr
            join public.organisation_memberships m on m.id = mr.membership_id
           where m.user_id = '00000000-0000-4000-8000-0000000000a3'), 0::int,
  '81 and that revocation left the suspended membership holding no role at all — so the refusal above is the '
  || 'status filter talking, not a fixture that never had a row to remove');

-- Demotion bites on the next request: the same call, the same person, and the only thing that changes
-- is the role assignment — and then changes back. No cache sits between the two answers.
insert into t_rev values ('grant', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('admin_grant_to_a2', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                                 '00000000-0000-4000-8000-0000000000a2',
                                                                 '31000000-0000-4000-8000-000000000002'));
insert into t_out values ('grant_replay', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                            '00000000-0000-4000-8000-0000000000a2',
                                                            '31000000-0000-4000-8000-000000000002'));
reset role;
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'grant';

select is((select result from t_out where case_name = 'admin_grant_to_a2'), 'ok',
  '82 the admin grants company1''s `admin` role to the member');
select is((select count(*)::int from public.membership_roles mr
            join public.organisation_memberships m on m.id = mr.membership_id
           where m.user_id = '00000000-0000-4000-8000-0000000000a2'
             and mr.role_id = '31000000-0000-4000-8000-000000000002'), 1::int,
  '83 one assignment, and the replay of the same grant left it at one — a repeated admin click does not '
  || 'duplicate a role (the unique key (membership_id, role_id))');
select is((select result from t_out where case_name = 'grant_replay'), 'ok',
  '84 and the replay is an idempotent success, not an error the page has to special-case');
select is((select after_rev - before_rev from t_rev where case_name = 'grant'), 1::bigint,
  '85 the grant moved policy_revision by exactly one, and the replay inside the same measurement moved '
  || 'nothing further (#98: the stamp moves with an actual change, not with the statement count)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('promoted_add', pg_temp.try_add_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000a2'));
reset role;

select is((select result from t_out where case_name = 'promoted_add'), 'ok',
  '67 the identical projects.admin call that test 56 refused now passes after the role grant');

insert into t_rev values ('revoke', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('a2_self_revoke', pg_temp.try_revoke('11111111-1111-4111-8111-111111111111',
                                                               '00000000-0000-4000-8000-0000000000a2',
                                                               '31000000-0000-4000-8000-000000000002'));
reset role;
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'revoke';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('demoted_add', pg_temp.try_add_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-0000000000a2'));
reset role;

select is((select result from t_out where case_name = 'a2_self_revoke'), 'ok',
  '68 the revocation runs');
select is((select count(*)::int from public.membership_roles mr
            join public.organisation_memberships m on m.id = mr.membership_id
           where m.user_id = '00000000-0000-4000-8000-0000000000a2'
             and mr.role_id = '31000000-0000-4000-8000-000000000002'), 0::int,
  '69 the assignment is gone; member is back to the seeded `member` role alone');
select is((select result from t_out where case_name = 'demoted_add'), '42501',
  '70 demotion bites on the next request: the same actor cannot widen another project audience');
select is((select after_rev - before_rev from t_rev where case_name = 'revoke'), 1::bigint,
  '90 the revocation moved policy_revision by exactly one, which is what invalidates a run that was '
  || 'authorized under the promoted state (#98, plan §9.4)');
select is((select count(*)::int from public.role_permissions rp
            where rp.organisation_id = '11111111-1111-4111-8111-111111111111'), 7::int,
  '91 and the permission matrix is exactly the seven seeded company1 rows: grant and revoke move '
  || '**assignments**, never areas, so an admin cannot invent a permission (plan §5.2; #39 contributor)');

-- ================================================================ 103-131 projects, audience and the
-- validation-with-no-partial-write box
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('create_project', pg_temp.id_of_project('11111111-1111-4111-8111-111111111111',
                                                                  'site-b', 'Site B survey (synthetic)',
                                                                  'project'));
insert into t_out values ('create_duplicate_key', pg_temp.try_project('11111111-1111-4111-8111-111111111111',
                                                                     'site-b', 'Second project, same key',
                                                                     'organisation'));
insert into t_out values ('create_bad_key', pg_temp.try_project('11111111-1111-4111-8111-111111111111',
                                                                'Site B', 'Mixed-case key', 'project'));
insert into t_out values ('create_blank_name', pg_temp.try_project('11111111-1111-4111-8111-111111111111',
                                                                   'blank-name', '', 'project'));
insert into t_out values ('create_bad_visibility', pg_temp.try_project(
  '11111111-1111-4111-8111-111111111111', 'bad-visibility', 'Wider than the two legal audiences',
  'everything'));
insert into t_out values ('create_null_org', pg_temp.try_project(null, 'null-org', 'No tenant named',
                                                                'project'));
insert into t_out values ('grant_null_user', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                               null, '31000000-0000-4000-8000-000000000001'));
insert into t_out values ('grant_unknown_role', pg_temp.try_grant('11111111-1111-4111-8111-111111111111',
                                                                  '00000000-0000-4000-8000-0000000000a2',
                                                                  '99999999-9999-4999-8999-999999999999'));
reset role;

select is((select organisation_id from public.projects where key = 'site-b'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '92 the project the admin created belongs to the tenant in force, and the tenant argument is never a '
  || 'column the RPC writes (§4.1)');
select is((select visibility from public.projects where key = 'site-b'), 'project',
  '93 and it carries the audience the caller asked for, narrower by default (§6.2, tenancy_core.sql:127)');
select is((select result from t_out where case_name = 'create_project'),
  (select id::text from public.projects where key = 'site-b'),
  '94 the answer is exactly the id of the row it wrote');
select is((select result from t_out where case_name = 'create_duplicate_key'), '23505',
  '95 a second project key inside the tenant is refused by the unique (organisation_id, key) index, not '
  || 'merged or renamed; the same key in another tenant is a different project');
select is((select result from t_out where case_name = 'create_bad_key'), '22023',
  '96 a malformed key is refused with a safe code before the table is reached');
select is((select result from t_out where case_name = 'create_blank_name'), '22023',
  '97 and an empty name too: the RPC validates rather than leaning on the column check');
select is((select result from t_out where case_name = 'create_bad_visibility'), '22023',
  '98 and a visibility outside (''organisation'',''project'') is a malformed argument, not a row the '
  || 'CHECK has to catch after a write was attempted');
select is((select result from t_out where case_name = 'create_null_org'), '22023',
  '99 a null tenant is a malformed argument from set_tenant_scope, never "no scope, guess one" '
  || '(tenancy_core.sql:210-212)');
select is((select result from t_out where case_name = 'grant_null_user'), '22023',
  '100 a null target user is refused before anything is read or written (packet failure box: a malformed '
  || 'argument is a validation error with no partial write)');
select is((select result from t_out where case_name = 'grant_unknown_role'), '23503',
  '101 a role id that exists nowhere is refused by the same composite FK — the failed grant leaves '
  || 'permissions exactly as they were (test 102 pins the company1 matrix at its seven seeded rows), so '
  || 'there is no half-applied role');
-- Both counts are read as the migration owner, after `reset role`.
select is((select count(*)::int from public.organisation_memberships
            where organisation_id = '11111111-1111-4111-8111-111111111111'), 6::int,
  '83 the seed''s four company1 memberships, …b1''s invited fixture, and …c5 `removed` — nothing else');
select is((select count(*)::int from public.projects
            where organisation_id = '11111111-1111-4111-8111-111111111111'), 3::int,
  '105 and the seed''s two company1 projects plus site-b: three refused project calls wrote nothing '
  || '(§7.2-style atomicity at the statement level — one RPC, one transaction, one write or none)');

-- The project audience, seen from the read path: removal and re-addition bite on the next request.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
insert into t_out values ('a4_scope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_read select 'a4_projects_before', count(*)::int from public.projects;
reset role;

insert into t_rev values ('remove_pm', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('admin_remove_a4', pg_temp.try_remove_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000a4'));
reset role;
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'remove_pm';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
insert into t_out values ('a4_rescope', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_read select 'a4_projects_after', count(*)::int from public.projects;
reset role;

select is((select result from t_out where case_name = 'a4_scope'), 'ok',
  '106 the dual-tenant member can scope company1 for this check — the audience below is measured from '
  || 'inside a real tenant session, not from an unscoped read that would answer zero for other reasons');
select is((select n from t_read where case_name = 'a4_projects_before'), 2::int,
  '107 …a4 starts as a member of Site A and sees it plus the tenant-wide project (the seed 010 test 31 '
  || 'pins)');
select is((select result from t_out where case_name = 'admin_remove_a4'), 'ok',
  '108 the admin removes them from Site A');
select is((select result from t_out where case_name = 'a4_rescope'), 'ok',
  '109 and the same person can still scope the tenant afterwards: a project removal narrows the '
  || 'audience, it does not end the membership — so the count below is one project rather than zero, and '
  || 'the difference is the audience rule talking, not a lost session');
select is((select n from t_read where case_name = 'a4_projects_after'), 1::int,
  '110 the removal bites on the next request: the project-audience read policy now answers one project, '
  || 'so an access change is not waiting on a cache to expire (§6.2, §4.3)');
select is((select after_rev - before_rev from t_rev where case_name = 'remove_pm'), 1::bigint,
  '111 and that narrowing moved policy_revision by exactly one (#98: project-membership writes are '
  || 'attached to the writer)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('admin_add_a4_back', pg_temp.try_add_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000a4'));
insert into t_out values ('admin_add_a4_again', pg_temp.try_add_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000a4'));
insert into t_out values ('add_non_member', pg_temp.try_add_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000a3'));
reset role;

select is((select result from t_out where case_name = 'admin_add_a4_back'), 'ok',
  '112 the admin re-adds them to the audience they were just taken out of — the narrowing is reversible '
  || 'within the same tenant, and the admin page needs that to be a plain success');
select is((select count(*)::int from public.project_memberships
            where project_id = '41000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-0000000000a4'), 1::int,
  '113 re-adding them is idempotent: one row after two calls (the unique (project_id, user_id) key)');
select is((select result from t_out where case_name = 'admin_add_a4_again'), 'ok',
  '114 and the second of those two calls answers as an idempotent **success**, not as an error the admin page '
  || 'has to special-case — the same shape as the role-grant replay, so a re-submitted form is reported '
  || 'the same way both times');
select is((select result from t_out where case_name = 'add_non_member'), '42501',
  '115 a project audience cannot be given to someone who is not an active member of this tenant: a '
  || 'suspended membership stays out, so the audience is a subset of the tenant (§4.2, §6.2)');
select is((select count(*)::int from public.project_memberships
            where user_id = '00000000-0000-4000-8000-0000000000a3'), 0::int,
  '116 and the refused audience write left that person in no project at all');

-- The other half of that rule. The **add** refuses a suspended target; the **removal** deliberately keeps
-- no status filter, so an audience a tenant wants closed can always be closed — including a row that
-- predates the suspension, which is just what a suspended member can still be holding from before it. No
-- RPC in this PR would write that row (that is the point of the refusal above), so the migration owner
-- writes it as a fixture, inside the transaction the file rolls back.
insert into public.project_memberships (organisation_id, project_id, user_id)
  values ('11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-0000000000a3');

select is((select count(*)::int from public.project_memberships
            where project_id = '41000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-0000000000a3'), 1::int,
  '117 (fixture) the suspended membership does hold a Site A row now, so the removal below has something to '
  || 'remove: the count above showed there was nothing to remove, and a removal that matched nothing would '
  || 'pass this family for the wrong reason');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('remove_suspended_target', pg_temp.try_remove_member(
  '11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-0000000000a3'));
reset role;

select is((select result from t_out where case_name = 'remove_suspended_target'), 'ok',
  '118 the admin can take a project audience away from a suspended membership: the removal path has no status '
  || 'filter, because narrowing an audience must always be possible — including for someone the tenant has '
  || 'already cut off (§4.2)');
select is((select count(*)::int from public.project_memberships
            where user_id = '00000000-0000-4000-8000-0000000000a3'), 0::int,
  '119 and that row is gone, so the suspended membership holds no project audience anywhere: the removal was a '
  || 'real delete and not a statement that matched nothing (the RPC reports that case as 42501, so an '
  || 'answer of ok here means a row went away)');

-- ================================================================ 132-146 the #98 writer, on the
-- paths no RPC in this PR takes, and the no-op rule
savepoint sp_matrix;
insert into t_rev values ('matrix', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('matrix_insert', pg_temp.try_owner_sql(
  'insert into public.role_permissions (organisation_id, role_id, area, level) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''31000000-0000-4000-8000-000000000001'', '
  || '''chat.ask'', ''read'')'));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'matrix';
-- The assertions for anything captured inside a savepoint go **inside** it: a savepoint rollback undoes
-- temp-table writes too, so a row inserted after `savepoint` and read after `rollback to savepoint` no
-- longer exists and the assertion would compare NULL. Asserting inside is the house pattern —
-- 011_identity.test.sql:169-171 and 020_knowledge.test.sql:588-602 both do it.
select is((select result from t_out where case_name = 'matrix_insert'), '23505',
  '120 (fixture) the permission-matrix write was refused by the unique (role_id, area) key, which is '
  || 'why the block below measures a **real** change: the seed already grants chat.ask to the member role');
select is((select after_rev - before_rev from t_rev where case_name = 'matrix'), 0::bigint,
  '121 and a statement the constraint refused moved policy_revision not at all: the writer saw an empty '
  || 'transition table and issued no UPDATE, which is the same property every idempotent replay in this '
  || 'suite leans on (#98, and the no-op group further down exists because this exact branch once '
  || 'recursed)');
rollback to savepoint sp_matrix;

savepoint sp_matrix2;
insert into t_rev values ('matrix2', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('matrix_update', pg_temp.try_owner_sql(
  'update public.role_permissions set level = ''admin'' where organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'' and role_id = ''31000000-0000-4000-8000-000000000001'' '
  || 'and area = ''chat.ask'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'matrix2';
select is((select result from t_out where case_name = 'matrix_update'), 'ok',
  '122 an actual permission-matrix change is the write #98 attaches the writer to role_permissions for '
  || '— a widened or narrowed area on a role invalidates the runs authorized under the old one');
select is((select after_rev - before_rev from t_rev where case_name = 'matrix2'), 1::bigint,
  '123 and it moved policy_revision by exactly one — read inside the savepoint, which is then rolled back '
  || 'so no other slot sees the matrix change (010_tenancy.test.sql counts these rows as the seed wrote '
  || 'them)');
rollback to savepoint sp_matrix2;

savepoint sp_status;
insert into t_rev values ('status', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('status_change', pg_temp.try_owner_sql(
  'update public.organisations set status = ''suspended'' where id = '
  || '''11111111-1111-4111-8111-111111111111'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'status';
-- The no-op pair needs its **own** before/after row: the update that fills after_rev addressed a
-- case_name that was never inserted, so the delta assertion below had nothing to read.
insert into t_rev values ('status_noop', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('status_noop', pg_temp.try_owner_sql(
  'update public.organisations set display_name = display_name where id = '
  || '''11111111-1111-4111-8111-111111111111'''));
insert into t_out values ('status_noop2', pg_temp.try_owner_sql(
  'update public.organisations set status = status where id = '
  || '''11111111-1111-4111-8111-111111111111'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'status_noop';
select is((select result from t_out where case_name = 'status_change'), 'ok',
  '124 a tenant status change is the write #98 attaches the writer to organisations for');
select is((select after_rev - before_rev from t_rev where case_name = 'status'), 1::bigint,
  '125 and it moved the revision by exactly one — one statement, one increment, and the writer''s own '
  || 'UPDATE did not recurse into a second one (the comparison excludes policy_revision and updated_at, '
  || 'so the bump is invisible to itself)');
select is((select result from t_out where case_name = 'status_noop'), 'ok',
  '126 an organisations update that changes nothing writable ran');
select is((select result from t_out where case_name = 'status_noop2'), 'ok',
  '127 and so did one that re-states the status column');
select is((select after_rev - before_rev from t_rev where case_name = 'status_noop'), 0::bigint,
  '128 neither moved the revision: an `update … set status = status` is not a policy change, and a stamp '
  || 'that moves on a no-op would invalidate runs for nothing (#98: "a no-op write must not move it")');
rollback to savepoint sp_status;

savepoint sp_member_noop;
insert into t_rev values ('member_noop', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('member_noop_sql', pg_temp.try_owner_sql(
  'update public.organisation_memberships set status = status where user_id = '
  || '''00000000-0000-4000-8000-0000000000a1'' and organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'member_noop';
select is((select result from t_out where case_name = 'member_noop_sql'), 'ok',
  '129 the owner-run membership update that re-states a column ran — and it is owner-run on purpose: no RPC '
  || 'in this PR can move a live membership, least of all back to `invited`');
select is((select after_rev - before_rev from t_rev where case_name = 'member_noop'), 0::bigint,
  '130 the same rule on the membership table: an update that changes no value left the revision exactly '
  || 'where it was, which is the no-op half of what the duplicate invite and the grant replay measure');
rollback to savepoint sp_member_noop;

select is((select status from public.organisation_memberships
            where organisation_id = '11111111-1111-4111-8111-111111111111'
              and user_id = '00000000-0000-4000-8000-0000000000b1'), 'invited',
  '110 …b1 fixture is still invited: no admin path in this PR activates them');

-- ---------------------------------------------------------------- the five-table no-op group, and the
-- recursion it exists to catch
-- #98's no-op rule has a sharp edge, and this file is where it got cut. `bump_policy_revision()` is a
-- **statement-level** AFTER trigger on five tables, and a statement-level trigger fires even for a
-- statement that modified zero rows. The first delivered version decided "nothing changed" and then
-- **still ran an UPDATE on public.organisations that matched zero rows** — and that UPDATE is itself a
-- statement on a table carrying the same trigger, so it re-fired the writer forever. CI proved it: all
-- eleven migrations applied cleanly, then `supabase/seed.sql` died with
-- `ERROR: stack depth limit exceeded (SQLSTATE 54001)`. The fix is to collect the affected tenant ids and
-- issue **no statement at all** when the list is empty.
--
-- Three statement shapes reach that branch, and they are pinned on each of the five tables the writer is
-- attached to: an `on conflict do nothing` replay (the idempotent RPC path), an UPDATE assigning identical
-- values (the "same form submitted twice" path), and a DELETE that matches nothing (the mistargeted
-- narrowing path). Each must (a) complete rather than raise — 54001 above all — and (b) leave
-- `organisations.policy_revision` exactly where it was. Every statement here is bounded to company1, so
-- company1's revision is the meter for all five. None is wrapped in a savepoint: a statement that writes
-- nothing has nothing to undo, and if one of these *does* write, that is the failure, not a side effect.
-- The `1_replay` / `2_same` / `3_miss` suffixes are what the array below is ordered by, so a red answer
-- names the shape that broke.
insert into t_rev values ('noop_om', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('noop_om_1_replay', pg_temp.try_owner_sql(
  'insert into public.organisation_memberships (organisation_id, user_id, status) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''00000000-0000-4000-8000-0000000000a1'', ''invited'') '
  || 'on conflict (organisation_id, user_id) do nothing'));
insert into t_out values ('noop_om_2_same', pg_temp.try_owner_sql(
  'update public.organisation_memberships set status = status where organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'' and user_id = ''00000000-0000-4000-8000-0000000000a1'''));
insert into t_out values ('noop_om_3_miss', pg_temp.try_owner_sql(
  'delete from public.organisation_memberships where organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'' and user_id = ''00000000-0000-4000-8000-0000000000c4'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'noop_om';
select is((select array_agg(result order by case_name)::text from t_out
            where left(case_name, 8) = 'noop_om_'), '{ok,ok,ok}',
  '135 organisation_memberships: the replay, the identical-value UPDATE and the DELETE that matches nothing '
  || 'all completed — and none of them raised 54001 "stack depth limit exceeded", which is how the '
  || 'recursing writer ended this file in CI');
select is((select after_rev - before_rev from t_rev where case_name = 'noop_om'), 0::bigint,
  '136 and none of the three moved policy_revision: the writer issued no statement at all, which is both #98''s '
  || 'rule and the recursion guard — a zero-row UPDATE on organisations is itself a statement, and that '
  || 'table carries the same trigger');

insert into t_rev values ('noop_mr', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('noop_mr_1_replay', pg_temp.try_owner_sql(
  'insert into public.membership_roles (organisation_id, membership_id, role_id) '
  || 'select m.organisation_id, m.id, ''31000000-0000-4000-8000-000000000001'' '
  || 'from public.organisation_memberships m where m.organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'' and m.user_id = ''00000000-0000-4000-8000-0000000000a2'' '
  || 'on conflict (membership_id, role_id) do nothing'));
insert into t_out values ('noop_mr_2_same', pg_temp.try_owner_sql(
  'update public.membership_roles set role_id = role_id where organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'''));
insert into t_out values ('noop_mr_3_miss', pg_temp.try_owner_sql(
  'delete from public.membership_roles where organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'' and role_id = '
  || '''99999999-9999-4999-8999-999999999999'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'noop_mr';
select is((select array_agg(result order by case_name)::text from t_out
            where left(case_name, 8) = 'noop_mr_'), '{ok,ok,ok}',
  '137 membership_roles: the same three shapes completed. The replay is the grant RPC''s own idempotency '
  || 'mechanism at the statement level, so the fact it costs nothing is pinned here and not only by the '
  || 'grant family above');
select is((select after_rev - before_rev from t_rev where case_name = 'noop_mr'), 0::bigint,
  '138 and the role-assignment table''s no-ops moved the stamp neither on the replay, nor on an identical '
  || 'assignment, nor on a revoke that matched no row — the three ways a demotion form can be submitted '
  || 'twice');

insert into t_rev values ('noop_rp', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('noop_rp_1_replay', pg_temp.try_owner_sql(
  'insert into public.role_permissions (organisation_id, role_id, area, level) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''31000000-0000-4000-8000-000000000001'', '
  || '''chat.ask'', ''read'') on conflict (role_id, area) do nothing'));
insert into t_out values ('noop_rp_2_same', pg_temp.try_owner_sql(
  'update public.role_permissions set level = level where organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'' and role_id = ''31000000-0000-4000-8000-000000000001'' '
  || 'and area = ''chat.ask'''));
insert into t_out values ('noop_rp_3_miss', pg_temp.try_owner_sql(
  'delete from public.role_permissions where organisation_id = '
  || '''11111111-1111-4111-8111-111111111111'' and role_id = '
  || '''99999999-9999-4999-8999-999999999999'' and area = ''chat.ask'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'noop_rp';
select is((select array_agg(result order by case_name)::text from t_out
            where left(case_name, 8) = 'noop_rp_'), '{ok,ok,ok}',
  '139 role_permissions: all three completed. This is the table whose real change is pinned as a +1 by the '
  || 'matrix block, so its no-ops are the other half of that evidence — a matrix statement that changed '
  || 'nothing may not look like a policy change');
select is((select after_rev - before_rev from t_rev where case_name = 'noop_rp'), 0::bigint,
  '140 and none of the three moved it: the replay is refused-or-discarded by the unique (role_id, area) key '
  || 'without a write, and the writer sees an empty transition table');

insert into t_rev values ('noop_pm', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('noop_pm_1_replay', pg_temp.try_owner_sql(
  'insert into public.project_memberships (organisation_id, project_id, user_id) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''41000000-0000-4000-8000-000000000001'', '
  || '''00000000-0000-4000-8000-0000000000a1'') on conflict (project_id, user_id) do nothing'));
insert into t_out values ('noop_pm_2_same', pg_temp.try_owner_sql(
  'update public.project_memberships set user_id = user_id where project_id = '
  || '''41000000-0000-4000-8000-000000000001'' and user_id = ''00000000-0000-4000-8000-0000000000a1'''));
insert into t_out values ('noop_pm_3_miss', pg_temp.try_owner_sql(
  'delete from public.project_memberships where project_id = '
  || '''41000000-0000-4000-8000-000000000002'' and user_id = ''00000000-0000-4000-8000-0000000000c3'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'noop_pm';
select is((select array_agg(result order by case_name)::text from t_out
            where left(case_name, 8) = 'noop_pm_'), '{ok,ok,ok}',
  '141 project_memberships: all three completed — and the missed DELETE is the removal path answering its '
  || '42501 rather than recursing, which is the same branch under a different name');
select is((select after_rev - before_rev from t_rev where case_name = 'noop_pm'), 0::bigint,
  '142 and re-adding an existing audience, restating one and removing a non-one left the stamp where it was, '
  || 'so the audience a run was authorized under is only invalidated when it actually moves (§6.2)');

insert into t_rev values ('noop_org', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'), 0);
insert into t_out values ('noop_org_1_replay', pg_temp.try_owner_sql(
  'insert into public.organisations (id, slug, display_name) values '
  || '(''11111111-1111-4111-8111-111111111111'', ''company1'', ''Company1 Geotechnics'') '
  || 'on conflict (id) do nothing'));
insert into t_out values ('noop_org_2_same', pg_temp.try_owner_sql(
  'update public.organisations set display_name = display_name where id = '
  || '''11111111-1111-4111-8111-111111111111'''));
insert into t_out values ('noop_org_3_miss', pg_temp.try_owner_sql(
  'delete from public.organisations where slug = ''no-such-tenant'''));
update t_rev set after_rev = pg_temp.rev_of('11111111-1111-4111-8111-111111111111')
 where case_name = 'noop_org';
select is((select array_agg(result order by case_name)::text from t_out
            where left(case_name, 9) = 'noop_org_'), '{ok,ok,ok}',
  '143 organisations: all three completed. The missed DELETE matters most here — the writer''s own recursion '
  || 'guard is a comparison over the transition tables of this very table, so a statement that matches '
  || 'nothing is the case the guard was written for');
select is((select after_rev - before_rev from t_rev where case_name = 'noop_org'), 0::bigint,
  '144 and a tenant re-inserted over its own primary key, renamed to the name it already had, or deleted by a '
  || 'slug that does not exist left the stamp unmoved — including no bump from the writer''s own UPDATE, '
  || 'which is what a zero-row version of that UPDATE used to become (#98)');

-- ================================================================ 157-167 the writer is attached where
-- #98 says, and the stale comment is gone
select is_empty($$
  select want.tbl
    from (values ('organisation_memberships'), ('membership_roles'), ('role_permissions'),
                 ('project_memberships'), ('organisations')) as want(tbl)
   where not exists (
     select 1
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
      where n.nspname = 'public' and c.relname = want.tbl
        and p.proname = 'bump_policy_revision' and not t.tgisinternal
   )
$$, '145 every table #98 names carries a trigger backed by public.bump_policy_revision(): '
  || 'organisation_memberships, membership_roles, role_permissions, project_memberships and '
  || 'organisations. A writer attached to only the tables one RPC touches is the bug #98 was opened '
  || 'for: a membership suspension would move no stamp and a run authorized under the old state would '
  || 'keep riding');

select is_empty($$
  select tr.tgname || ' on ' || c.relname
    from pg_trigger tr
    join pg_class c on c.oid = tr.tgrelid
    join pg_proc p on p.oid = tr.tgfoid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and p.proname = 'bump_policy_revision' and not tr.tgisinternal
     and (tr.tgtype::int & 1) <> 0
$$, '146 and every one of them is a **statement**-level trigger, as #98 specifies (the bit set in '
  || 'pg_trigger.tgtype that means FOR EACH ROW must be clear)');
-- Read the trigger in words, because masking `pg_trigger.tgtype` failed twice from this file and both
-- failures were the constant, not the triggers. The first version asked for `(tgtype & 8) = 0` believing
-- bit 3 marked the timing; run 43652324942 then listed the ten insert/update triggers and **not** the
-- five delete ones, which proves bit 3 is DELETE and says nothing about timing. The second version
-- substituted `(tgtype & 192) <> 128` on a recited AFTER value, and run 43661956961 listed all fifteen:
-- the timing bit I named is not the one the catalog sets. Test 158 keeps its `& 1` because that one **is**
-- established — a statement-level trigger leaves bit 0 clear, which is why 158 has been green from the
-- start. Nothing here asserts a bit that CI has not actually demonstrated.
--
-- So the predicate is the DDL itself: `pg_get_triggerdef` renders the catalog's own replay of the
-- trigger, and the check is that the rendering says AFTER and FOR EACH STATEMENT. A failure now prints
-- the rendering rather than a number, which is the evidence the next reader needs. The join is the one
-- tests 157 and 160 use — fifteen rows in, fifteen rows out — so this cannot pass by finding nothing.
select is_empty($$
  select tr.tgname || ' on ' || c.relname || ' renders as: ' || pg_get_triggerdef(tr.oid)
    from pg_trigger tr
    join pg_class c on c.oid = tr.tgrelid
    join pg_proc p on p.oid = tr.tgfoid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and p.proname = 'bump_policy_revision' and not tr.tgisinternal
     and pg_get_triggerdef(tr.oid) not ilike '% AFTER % FOR EACH STATEMENT %'
$$, '147 and every one fires AFTER and for each statement, which #98 requires and a BEFORE trigger would '
  || 'break: a before-trigger that bumps the stamp would let a statement which then fails its own '
  || 'constraint move the revision anyway');

select is((select count(*)::int from pg_trigger tr
             join pg_class c on c.oid = tr.tgrelid
             join pg_proc p on p.oid = tr.tgfoid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and p.proname = 'bump_policy_revision'
              and not tr.tgisinternal), 15::int,
  '148 five tables x (insert, update, delete): the count is pinned so a fourth table or a dropped '
  || 'event fails by number rather than by a reviewer noticing an absent row');

select is((select coalesce(obj_description('public.organisations'::regclass), '')),
  'Tenant root. Status is authoritative for every access decision. policy_revision is a monotonic stamp bumped on every access change; it is recorded for audit and used as a cache key. Access is always re-derived.',
  '149 table comment is #98 §4 verbatim (plus Tenant root / Status): Access is always re-derived');
select isnt((select coalesce(obj_description('public.organisations'::regclass), '')),
  'Tenant root. Status and policy_revision are authoritative for every access decision.',
  '150 merged tenancy_core.sql:34 comment is gone (AGENTS.md §6: correction is comment on here)');
select is((select coalesce(col_description('public.organisations'::regclass,
                (select a.attnum from pg_attribute a
                  where a.attrelid = 'public.organisations'::regclass
                    and a.attname = 'policy_revision')), '')),
  'policy_revision is a monotonic stamp bumped on every access change; it is recorded for audit and used as a cache key. Access is always re-derived. Maintained by public.bump_policy_revision(); read through current_policy_revision_v1(uuid) (#171, ADR-0003 §3b). Never assigned by hand.',
  '151 column comment carries the same #98 §4 sentence, aligned with the table comment');

-- And the merged-trigger defect section 0 of the migration promises to pin.
-- `20261105060000_tenancy_core.sql:162-163` attaches `touch_updated_at()` to `public.projects`, and that
-- function assigns `new.updated_at` to a table with no such column (:122-134) — so **every** UPDATE on
-- projects raised 42703 on any database built from these migrations. The merged file may not be edited, so
-- this migration drops the trigger; the two facts that fix has to leave behind are pinned here, that the
-- trigger is gone and that the UPDATE runs. Not adding an `updated_at` column is deliberate (builder decision; AGENTS.md §6, and
-- the packet asks for no table shape change). `organisations_touch_updated` survives on `organisations`,
-- which really does have `updated_at` (:31) — this is one named trigger, not a pattern to generalize.
select is_empty($$
  select tr.tgname
    from pg_trigger tr
    join pg_class c on c.oid = tr.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'projects'
     and tr.tgname = 'projects_touch_updated' and not tr.tgisinternal
$$, '152 the merged defect this migration undoes is a trigger, so the trigger is the fact: '
  || 'projects_touch_updated is no longer attached to public.projects');
select is((select count(*)::int from pg_trigger tr
             join pg_class c on c.oid = tr.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'projects' and not tr.tgisinternal), 0::int,
  '153 …and public.projects now carries no user trigger at all, so the pin is not only the name of the one that '
  || 'was dropped: a project row is written by create_project_v1 and answered by nothing that fires on it');
select is(pg_temp.try_owner_sql(
  'update public.projects set name = ''Site A survey (renamed by 013)'' where id = '
  || '''41000000-0000-4000-8000-000000000001'''), 'ok',
  '154 and an UPDATE on a project row now runs, which is the behavior the drop buys: the same statement raised '
  || '42703 "column updated_at of relation new does not exist" until it was dropped. A T-202 admin page '
  || 'renames projects, so this is not a hypothetical (flagged upward: a latent defect found in a merged '
  || 'migration, fixed by drop only)');
select is((select name from public.projects where id = '41000000-0000-4000-8000-000000000001'),
  'Site A survey (renamed by 013)',
  '155 and the UPDATE wrote the name it was given, so the ok above is a real write and not a statement that '
  || 'matched nothing — and the row still has no updated_at column, because this migration adds none');

select * from finish();
rollback;
