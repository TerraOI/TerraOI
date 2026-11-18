-- T-116 provider and clearance configuration: the four §6.1 tables, the narrow-only guard, the
-- one-revision matrix guard (deferred + ceiling/enabled bump), and the privilege closure (#60).
-- Plan §6.1, §12.4, §17.1; F37/F38/F40. Slot 046 (COORDINATION §6b: T-116 claims its slot in the
-- daily sync; 045 is T-211, 050 is T-213).
--
-- RLS negatives use the seed users via `set local role authenticated` and
-- `set local request.jwt.claim.sub` (010:147-148). After #143 round-4 B8 there is no SELECT grant
-- and no policy on `tenant_provider_policy`, so an active member, another tenant, and a suspended
-- member are all refused with 42501 — matching the three platform tables.
begin;
create extension if not exists pgtap with schema extensions;

select plan(75);

-- Helpers report an error as its SQLSTATE instead of aborting the test transaction (010/040 idiom).
create function pg_temp.try_insert_provider(
  p_key text, p_tier text, p_rank int, p_class text, p_revision bigint,
  p_verifier_model text default null, p_verifier_version text default null
) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    insert into public.model_providers
      (provider_key, capability_tier, cost_rank, max_cleared_class, clearance_revision,
       verifier_model, verifier_eval_set_version)
      values (p_key, p_tier, p_rank, p_class, p_revision, p_verifier_model, p_verifier_version);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Disabling is a matrix change: bump every row's revision in the same statement so the deferred
-- one-revision check stays satisfied (#143 B7).
create function pg_temp.try_disable_provider(p_key text) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  update public.model_providers
     set enabled = case when provider_key = p_key then false else enabled end,
         clearance_revision = clearance_revision + 1;
  return 'ok';
exception when others then
  return sqlstate::text;
end;
$fn$;

create function pg_temp.try_bump_all_revisions() returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  update public.model_providers set clearance_revision = clearance_revision + 1;
  return 'ok';
exception when others then
  return sqlstate::text;
end;
$fn$;

create function pg_temp.try_ceiling_without_bump(p_key text, p_class text) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  update public.model_providers
     set max_cleared_class = p_class
   where provider_key = p_key;
  return 'ok';
exception when others then
  return sqlstate::text;
end;
$fn$;

create function pg_temp.try_bump_one_revision(p_key text, p_revision bigint) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  update public.model_providers
     set clearance_revision = p_revision
   where provider_key = p_key;
  return 'ok';
exception when others then
  return sqlstate::text;
end;
$fn$;

create function pg_temp.try_route(p_task text, p_provider text, p_position int) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    insert into public.provider_routes (task_class, provider_key, route_position)
      values (p_task, p_provider, p_position);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_tenant_policy(p_org uuid, p_class text, p_provider text) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    insert into public.tenant_provider_policy (organisation_id, data_class, provider_key)
      values (p_org, p_class, p_provider);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_health(p_provider text, p_status text, p_latency int) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    insert into public.provider_health (provider_key, status, latency_ms, checked_at)
      values (p_provider, p_status, p_latency, now());
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_read_tenant_policy() returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  begin
    perform 1 from public.tenant_provider_policy limit 1;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- ── 1. shape ────────────────────────────────────────────────────────────────────────────────
select has_table('public', 'model_providers', 'T-116: model_providers exists (§6.1)');
select has_table('public', 'provider_routes', 'T-116: provider_routes exists (§6.1)');
select has_table('public', 'tenant_provider_policy', 'T-116: tenant_provider_policy exists (§6.1)');
select has_table('public', 'provider_health', 'T-116: provider_health exists (§6.1)');

select has_column('public', 'model_providers', 'max_cleared_class',
  'the provider ceiling from which the §12.4 clearance matrix is derived');
select has_column('public', 'model_providers', 'clearance_revision',
  'F40 records the matrix revision used by every route decision');
select has_column('public', 'provider_routes', 'route_position',
  'the chain order F38 walks, per task class');
select has_column('public', 'tenant_provider_policy', 'organisation_id',
  'the tenant scope column RLS and the read path key on');
select has_column('public', 'provider_health', 'quota_window_reset_at',
  'the quota-window signal T-313 and F37 read');
select has_column('public', 'provider_health', 'observed_by',
  'scheduled probe vs passive error-rate signal (plan §17.1)');

-- ── 2. the configuration is recorded by the owner, never by a request role (#60) ────────────
select is(has_table_privilege('anon', 'public.model_providers', 'select'), false,
  'anon may not read the platform provider registry');
select is(has_table_privilege('anon', 'public.provider_routes', 'select'), false,
  'anon may not read the platform chain of record');
select is(has_table_privilege('anon', 'public.provider_health', 'select'), false,
  'anon may not read provider health (run-audit content, §9.3)');
select is(has_table_privilege('anon', 'public.tenant_provider_policy', 'select'), false,
  'anon may not read a tenant provider policy');

select is(has_table_privilege('authenticated', 'public.model_providers', 'insert'), false,
  'a request role may not write the provider registry');
select is(has_table_privilege('authenticated', 'public.model_providers', 'update'), false,
  'a request role may not update the provider registry');
select is(has_table_privilege('authenticated', 'public.model_providers', 'delete'), false,
  'a request role may not delete a provider');
select is(has_table_privilege('authenticated', 'public.provider_routes', 'insert'), false,
  'a request role may not write the chain of record');
select is(has_table_privilege('authenticated', 'public.provider_routes', 'update'), false,
  'a request role may not reorder the chain of record');
select is(has_table_privilege('authenticated', 'public.provider_routes', 'delete'), false,
  'a request role may not delete a chain position');
select is(has_table_privilege('authenticated', 'public.provider_health', 'insert'), false,
  'health rows come from the T-314 server path, not from a request role');
select is(has_table_privilege('authenticated', 'public.provider_health', 'update'), false,
  'a request role may not rewrite provider health');
select is(has_table_privilege('authenticated', 'public.provider_health', 'delete'), false,
  'a request role may not erase provider health');
select is(has_table_privilege('authenticated', 'public.tenant_provider_policy', 'insert'), false,
  'the tenant admin write path is a scoped RPC (T-202), not a raw grant');
select is(has_table_privilege('authenticated', 'public.tenant_provider_policy', 'update'), false,
  'no raw update on the tenant policy table');
select is(has_table_privilege('authenticated', 'public.tenant_provider_policy', 'delete'), false,
  'no raw delete on the tenant policy table');

-- B8: no SELECT grant; gateway uses CONFIG_DB and admin read is T-202.
select is(has_table_privilege('authenticated', 'public.tenant_provider_policy', 'select'), false,
  'authenticated may not read tenant_provider_policy directly (§9.3; #143 B8)');
select is(has_function_privilege('authenticated', 'public.model_providers_one_revision()', 'execute'), false,
  'the matrix-revision guard is a trigger function, not a callable');
select is(has_function_privilege('authenticated', 'public.model_providers_revision_on_matrix_change()', 'execute'), false,
  'the ceiling/enabled bump guard is a trigger function, not a callable');
select is(has_function_privilege('authenticated', 'public.tenant_provider_policy_narrows_platform()', 'execute'), false,
  'the narrow-only guard is a trigger function, not a callable');
-- Catalog form of the same rule for every trigger function this migration adds: no request-role
-- EXECUTE survives (round-1 finding 1 / B5 shape, applied to the three guards that remain after N6).
select is_empty($$
  select coalesce(r.rolname, 'PUBLIC') || ' holds EXECUTE on ' || p.proname as grantee
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and p.proname in (
       'model_providers_one_revision',
       'model_providers_revision_on_matrix_change',
       'tenant_provider_policy_narrows_platform'
     )
     and a.privilege_type = 'EXECUTE'
     and (a.grantee = 0
          or a.grantee = (select oid from pg_roles where rolname = 'anon')
          or a.grantee = (select oid from pg_roles where rolname = 'authenticated')
          or a.grantee = (select oid from pg_roles where rolname = 'service_role'))
$$, 'no role a request can arrive as holds EXECUTE on any T-116 trigger function');

-- ── 3. RLS is on, and tenant_provider_policy has zero policies (B8) ──────────────────────────
select is_empty($$
  select 1 from pg_class where relname = 'tenant_provider_policy' and not relrowsecurity
$$, 'RLS is enabled on tenant_provider_policy (AGENTS.md §4.2)');
select is_empty($$
  select 1 from pg_class where relname = 'model_providers' and not relrowsecurity
$$, 'RLS is enabled on model_providers too, so a future broad grant still exposes no row');
select is_empty($$
  select 1 from pg_class where relname = 'provider_health' and not relrowsecurity
$$, 'RLS is enabled on provider_health too, as run-audit content (§9.3)');
select is((
  select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'tenant_provider_policy'
), 0::bigint, 'tenant_provider_policy has no RLS policies: closed like the three platform tables (#143 B8)');

-- ── 4. seeding the reviewed platform configuration (as the migration owner) ────────────────
-- Why the five seed rows below are assertions and not bare selects: a bare
-- `select try_insert_provider(...)` prints the text `ok` on its own line, and pg_prove reads that
-- as a TAP result. That is what desynced the count on CI run 42726035516 (71 results against
-- plan(66), "Found (37) but expected (42)"), and it hid five unasserted writes.
-- Values mirror the reviewed defaults in src/contracts/provider-route.ts: the chain order is the
-- cost order, and the ceiling per provider is what PLATFORM_DEFAULT_CLEARANCE implies. The session
-- already runs as the role that applied the migrations (040's idiom: switch only when a case needs
-- a request role, and "reset role" afterwards).
select is(pg_temp.try_insert_provider('local_box', 'medium', 1, 'restricted', 1), 'ok', 'local_box records at its reviewed ceiling');
select is(pg_temp.try_insert_provider('workers_ai', 'large', 2, 'internal', 1), 'ok', 'workers_ai records at its reviewed ceiling');
select is(pg_temp.try_insert_provider('claude', 'large', 3, 'client_confidential', 1), 'ok', 'claude records at its reviewed ceiling');
select is(pg_temp.try_insert_provider('deepseek', 'large', 4, 'public', 1), 'ok', 'deepseek records at its reviewed ceiling');
select is(pg_temp.try_insert_provider('openrouter', 'medium', 5, 'public', 1), 'ok', 'openrouter records at its reviewed ceiling');
select is((select count(*) from public.model_providers), 5::bigint, 'the reviewed platform registry holds exactly the five providers of the §12.4 cost order');

-- ── 5. the guards that make the configuration replayable (F40; #143 B7) ─────────────────────
select is(pg_temp.try_insert_provider('second_local_box', 'medium', 6, 'restricted', 2), '23514', 'two rows with different clearance_revision are refused: a half-swapped matrix cannot be replayed');
select is(pg_temp.try_bump_all_revisions(), 'ok',
  'B7: a one-statement bump of every provider row succeeds under the deferred one-revision constraint');
select is(pg_temp.try_ceiling_without_bump('openrouter', 'restricted'), '23514',
  'B7: changing max_cleared_class without increasing clearance_revision is refused');
set constraints model_providers_one_revision immediate;
select is(pg_temp.try_bump_one_revision('local_box', 99), '23514',
  'B7: a mixed clearance_revision under set constraints … immediate is refused');
set constraints model_providers_one_revision deferred;

select is(pg_temp.try_insert_provider('claude', 'large', 7, 'restricted', 1), '23505', 'duplicate provider_key is refused by the primary key');
select is(pg_temp.try_insert_provider('box2', 'large', 3, 'public', 1), '23505', 'cost_rank is unique: two providers cannot claim the same place in the cost order');
select is(pg_temp.try_insert_provider('bad key', 'large', 8, 'public', 1), '23514', 'provider_key must match the contract key shape (keys.ts ProviderKey)');
select is(pg_temp.try_insert_provider('box3', 'enormous', 9, 'public', 1), '23514', 'capability_tier is the contract enum');
select is(pg_temp.try_insert_provider('box4', 'large', 10, 'secret_class', 1), '23514', 'max_cleared_class must be a real data class (data_class_is_valid)');
-- After the successful all-row bump above, every row is at revision 2; inserts must match.
select is(pg_temp.try_insert_provider('box5', 'large', 11, 'public', 2, 'verifier-only-model', null), '23514', 'a verifier model without the eval set that proved it adequate is a pair violation (#9, config.ts:28-39)');

select is(pg_temp.try_route('compose', 'local_box', 1), 'ok', 'compose chain position 1 records');
select is(pg_temp.try_route('compose', 'workers_ai', 2), 'ok', 'compose chain position 2 records');
select is(pg_temp.try_route('compose', 'claude', 2), '23505', 'two providers may not hold the same position in one task chain');
select is(pg_temp.try_route('compose', 'local_box', 3), '23505', 'one provider may not appear twice in one task chain');
select is(pg_temp.try_route('translate', 'claude', 5), '23514', 'task_class is the contract enum (route/condense/compose/verify)');
select is(pg_temp.try_route('compose', 'no_such_provider', 6), '23503', 'a chain may not name a provider the registry does not have (F31 eligibility starts in the data)');

-- ── 6. a tenant may narrow, never widen (§12.4, provider-route.ts narrowClearance) ─────────
select ok(exists(select 1 from public.organisations),
  'a synthetic tenant exists from supabase/seed.sql for the policy fixtures (finding 4: isnt() passed on NULL)');
select is(pg_temp.try_tenant_policy(
  '11111111-1111-4111-8111-111111111111'::uuid, 'client_confidential', 'claude'), 'ok', 'a narrowing the platform already cleared is accepted');
select is(pg_temp.try_tenant_policy(
  '11111111-1111-4111-8111-111111111111'::uuid, 'internal', 'workers_ai'), 'ok', 'a narrowing at internal is accepted (workers_ai''s ceiling is internal)');
select is(pg_temp.try_tenant_policy(
  '22222222-2222-4222-8222-222222222222'::uuid, 'public', 'deepseek'), 'ok',
  'company2 also records a narrowing so B9 has a cross-tenant row to fail against');
select is(pg_temp.try_tenant_policy(
  '11111111-1111-4111-8111-111111111111'::uuid, 'client_confidential', 'workers_ai'), '23514', 'workers_ai may not be allowed for client_confidential: the tenant cannot widen the platform matrix');
select is(pg_temp.try_tenant_policy(
  '11111111-1111-4111-8111-111111111111'::uuid, 'restricted', 'openrouter'), '23514', 'no tenant may open restricted content to a hosted provider (TOI-ADR-12)');
select is(pg_temp.try_tenant_policy(
  '11111111-1111-4111-8111-111111111111'::uuid, 'public', 'no_such_provider'), '23514',
  'a policy naming a provider outside the registry is refused by the narrow-only BEFORE-row guard, '
  || 'which runs before the foreign key (B1: CI run 42726035516 returned 23514, not 23503)');
select is(pg_temp.try_tenant_policy(
  '11111111-1111-4111-8111-111111111111'::uuid, 'secret_class', 'claude'), '23514', 'the policy class must be a real data class');
select is(pg_temp.try_disable_provider('claude'), 'ok', 'a provider can be taken offline by the owner (revision bumps with it)');
select is(pg_temp.try_tenant_policy(
  '11111111-1111-4111-8111-111111111111'::uuid, 'public', 'claude'), '23514', 'a policy row naming a disabled provider is refused: enabling is configuration, not a side effect of a tenant write');

-- ── 7. health rows and request-role closure ────────────────────────────────────────────────
select is(pg_temp.try_health('workers_ai', 'healthy', 240), 'ok', 'a scheduled probe row records');
select is(pg_temp.try_health('workers_ai', 'on_fire', 240), '23514', 'status is the F37 vocabulary, not free text');
select is(pg_temp.try_health('workers_ai', 'degraded', -5), '23514', 'latency cannot be negative');
select is(pg_temp.try_health('workers_ai', 'down', 99999999), '23514', 'latency is bounded, so a broken probe cannot poison the route window');

-- ── 8. cross-tenant / deactivated-member negatives (#143 B9; 010 JWT pattern) ───────────────
-- Rows for both orgs exist above. Capture under each seed user, assert as the migration owner.
create temp table t_policy_read (case_name text, result text);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_policy_read values ('a1_member', pg_temp.try_read_tenant_policy());
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_policy_read values ('b1_other_tenant', pg_temp.try_read_tenant_policy());
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
insert into t_policy_read values ('a3_suspended', pg_temp.try_read_tenant_policy());
reset role;

select is((select result from t_policy_read where case_name = 'a1_member'), '42501',
  'B9: company1 owner cannot SELECT tenant_provider_policy (no grant, no policy; #143 B8)');
select is((select result from t_policy_read where case_name = 'b1_other_tenant'), '42501',
  'B9: company2 member cannot read any tenant_provider_policy row, including company1''s');
select is((select result from t_policy_read where case_name = 'a3_suspended'), '42501',
  'B9: a suspended company1 member reads nothing from tenant_provider_policy');

set local role authenticated;
select is(pg_temp.try_health('workers_ai', 'healthy', 100), '42501', 'authenticated cannot write provider_health even through a helper: the revoke is real');
reset role;

select * from finish();
rollback;
