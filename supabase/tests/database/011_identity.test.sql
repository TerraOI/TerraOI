-- T-102(e): the identity and invite invariants that already exist in the merged tenancy schema
-- (supabase/migrations/20261105060000_tenancy_core.sql), which no earlier test pinned:
--   * `profiles.email` is stored only in canonical form (`email = lower(btrim(email))`), which is
--     what an invite binds to (plan §4.2);
--   * `authenticated` has no write path to `organisation_memberships` at all, so an invite cannot
--     be self-claimed through the Data API;
--   * an `invited` or `removed` membership cannot establish a tenant scope, so an unclaimed invite
--     grants no access (F02).
-- Test-only on purpose: the invite-redemption RPC and its grants join this file when #37 settles
-- their shape. Until then this is regression cover for rules that are already in force.
-- Fixtures are synthetic and created inside this transaction, which rolls back (AGENTS.md §4.7);
-- supabase/seed.sql is not touched.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

-- Helpers report an error as its SQLSTATE instead of aborting the test transaction, and run as the
-- role that is under test (SECURITY INVOKER), the pattern 010_tenancy.test.sql established.
create function pg_temp.try_profile_email(p_user uuid, p_email text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.profiles set email = p_email where id = p_user;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_membership_update(p_organisation_id uuid, p_user_id uuid, p_status text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    update public.organisation_memberships set status = p_status
      where organisation_id = p_organisation_id and user_id = p_user_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_membership_insert(p_organisation_id uuid, p_user_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    insert into public.organisation_memberships (organisation_id, user_id, status)
      values (p_organisation_id, p_user_id, 'active');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_membership_delete(p_organisation_id uuid, p_user_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    delete from public.organisation_memberships
      where organisation_id = p_organisation_id and user_id = p_user_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
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

-- Capture table created by the role that fills it, so grants and RLS apply to the writes that
-- populate it; the assertions then read it as the migration owner (010's approach).
set local role authenticated;
create temp table t_out (case_name text, result text);
reset role;

-- Constants: the seeded company1 owner, and a second tenant to try to forge against.
-- 1111…1111 = company1, 2222…2222 = company2 (supabase/seed.sql).
-- Synthetic identities for the invite cases, created below inside this transaction.

-- ---------------------------------------------------------------- the canonical-email rule
-- 1. The rule under test is present in the catalog, so a rename or drop of the constraint cannot
--    turn assertions 2–4 into a vacuous pass.
select ok(
  exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%lower(btrim(email))%'
  ),
  '1 profiles.email is still CHECKed against lower(btrim(email))'
);

insert into t_out values
  ('email_upper', pg_temp.try_profile_email('00000000-0000-4000-8000-0000000000a1', 'Owner1@Company1.TEST')),
  ('email_padded', pg_temp.try_profile_email('00000000-0000-4000-8000-0000000000a1', '  owner1@company1.test  ')),
  ('email_inner_space', pg_temp.try_profile_email('00000000-0000-4000-8000-0000000000a1', 'owner 1@company1.test')),
  ('email_canonical', pg_temp.try_profile_email('00000000-0000-4000-8000-0000000000a1', 'owner1@company1.test'));

-- 2–4. A mixed-case, padded or internally-spaced address is refused rather than stored: an invite
--      binds to a canonical address, so the write path may not record anything else (plan §4.2).
select is((select result from t_out where case_name = 'email_upper'), '23514',
  '2 a mixed-case address cannot be written to profiles.email');
select is((select result from t_out where case_name = 'email_padded'), '23514',
  '3 a padded address cannot be written to profiles.email');
select is((select result from t_out where case_name = 'email_inner_space'), '23514',
  '4 an address with an inner space cannot be written to profiles.email');
-- 5. Control: the canonical form is accepted, so 2–4 are about the value and not about the update.
select is((select result from t_out where case_name = 'email_canonical'), 'ok',
  '5 the canonical address writes cleanly (control)');

-- 6. Teeth, inside the transaction: with the CHECK dropped the same mixed-case write succeeds, so
--    assertions 2–4 are guarding a real constraint. Restored by the savepoint rollback.
savepoint sp_email_check;
alter table public.profiles drop constraint profiles_email_check;
insert into t_out
  select 'email_after_drop', pg_temp.try_profile_email('00000000-0000-4000-8000-0000000000a1', 'Owner1@Company1.TEST');
select is((select result from t_out where case_name = 'email_after_drop'), 'ok',
  '6 drop the CHECK and the mixed-case write is accepted (the guard is the CHECK)');
rollback to savepoint sp_email_check;

-- ---------------------------------------------------------------- no write path to memberships
-- 7–9. The grant state itself, so the SQLSTATE assertions below cannot be vacuous.
select is(has_table_privilege('authenticated', 'public.organisation_memberships', 'update'), false,
  '7 authenticated holds no UPDATE grant on organisation_memberships');
select is(has_table_privilege('authenticated', 'public.organisation_memberships', 'insert'), false,
  '8 authenticated holds no INSERT grant on organisation_memberships');
select is(has_table_privilege('authenticated', 'public.organisation_memberships', 'delete'), false,
  '9 authenticated holds no DELETE grant on organisation_memberships');

-- 10–12. Even a member acting on their own row cannot flip their own status: an invite cannot be
--        self-claimed through the Data API. Writes go through reviewed privileged paths and scoped
--        RPCs (plan §4.3, AGENTS.md §4.2).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values
  ('member_update_own', pg_temp.try_membership_update('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a1', 'active')),
  ('member_insert_other', pg_temp.try_membership_insert('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a2')),
  ('member_delete_own', pg_temp.try_membership_delete('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a1'));
reset role;

select is((select result from t_out where case_name = 'member_update_own'), '42501',
  '10 a member cannot promote or change their own membership row');
select is((select result from t_out where case_name = 'member_insert_other'), '42501',
  '11 a member cannot add a membership row for anyone, including themselves');
select is((select result from t_out where case_name = 'member_delete_own'), '42501',
  '12 a member cannot delete their own membership row');

-- 13. Teeth: grant the privilege for a moment and the identical write goes through, proving 10–12
--     test the grant and not something incidental. The savepoint rollback takes the grant away.
savepoint sp_grants;
grant update on public.organisation_memberships to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out
  select 'grant_teeth', pg_temp.try_membership_update('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a1', 'active');
reset role;
select is((select result from t_out where case_name = 'grant_teeth'), 'ok',
  '13 grant UPDATE and the same write succeeds (the guard is the grant)');
rollback to savepoint sp_grants;

-- ---------------------------------------------------------------- an invite grants no access
-- Synthetic invited and removed rows (rolled back with the transaction). The identity rows exist
-- because profiles.id references auth.users, exactly as seed.sql creates them.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'invited@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Synthetic Invitee"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'former@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Synthetic Former Member"}'::jsonb)
on conflict (id) do nothing;

insert into public.profiles (id, email, display_name) values
  ('00000000-0000-4000-8000-0000000000c1', 'invited@company1.test', 'Synthetic Invitee'),
  ('00000000-0000-4000-8000-0000000000c2', 'former@company1.test', 'Synthetic Former Member')
on conflict (id) do nothing;

insert into public.organisation_memberships (organisation_id, user_id, status) values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000c1', 'invited'),
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000c2', 'removed')
on conflict (organisation_id, user_id) do nothing;

-- 14–16. `set_tenant_scope` verifies membership before it sets anything, so an unclaimed or ended
--        invite cannot establish a tenant, for its own organization or any other. (010 already
--        pins the suspended case; `invited` and `removed` were unpinned.)
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1';
insert into t_out values
  ('scope_invited_own', pg_temp.try_scope('11111111-1111-4111-8111-111111111111')),
  ('scope_invited_forged', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
reset role;

select is((select result from t_out where case_name = 'scope_invited_own'), '28000',
  '14 an invited membership cannot establish a tenant scope for its own organization');
select is((select result from t_out where case_name = 'scope_invited_forged'), '28000',
  '15 an invited membership cannot establish a scope for a different organization either');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c2';
insert into t_out values ('scope_removed_own', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;

select is((select result from t_out where case_name = 'scope_removed_own'), '28000',
  '16 a removed membership cannot establish a tenant scope');

-- 17. Control: the seeded active member can scope, so 14–16 are about status and not about the
--     helper being broken or the synthetic identities being unusable.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_active', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;

select is((select result from t_out where case_name = 'scope_active'), 'ok',
  '17 an active member can still scope (control)');

-- 18. The refused attempts changed nothing: the invite is still unclaimed, and no scope was left
--     behind for it (plan §4.3: a scope never persists past its transaction).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1';
insert into t_out
  select 'invited_status_after', status::text from public.organisation_memberships
   where organisation_id = '11111111-1111-4111-8111-111111111111'
     and user_id = '00000000-0000-4000-8000-0000000000c1';
reset role;

select is((select result from t_out where case_name = 'invited_status_after'), 'invited',
  '18 a refused scope attempt leaves the invitation unclaimed');

select * from finish();
rollback;
