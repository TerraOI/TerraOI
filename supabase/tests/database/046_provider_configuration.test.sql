-- T-116 provider and clearance configuration: the four §6.1 tables, the narrow-only guard, the
-- one-revision matrix guard, and the privilege closure (#60). Plan §6.1, §12.4, §17.1; F37/F38/F40.
-- Slot 046 (COORDINATION §6b: T-116 claims its slot in the daily sync; 045 is T-211, 050 is T-213).
--
-- What this file does NOT re-prove: the membership predicate itself (`is_active_member`, and the
-- deactivated-member and other-tenant cases) is proven in `010_tenancy.test.sql`, where the scope
-- plumbing exists. This suite proves the objects T-116 adds: their shape, their closures, and that
-- the tenant table cannot be widened from SQL. The cross-tenant read negatives here are the ones
-- provable without a JWT (an unscoped call sees nothing), and the policy is asserted by definition.
begin;
create extension if not exists pgtap with schema extensions;

select plan(71);

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

create function pg_temp.try_disable_provider(p_key text) returns text
language plpgsql security invoker set search_path = public, pg_temp as $fn$
begin
  update public.model_providers set enabled = false where provider_key = p_key;
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

-- The one grant, and the closure of every function this migration adds (#60 rule 4).
select is(has_table_privilege('authenticated', 'public.tenant_provider_policy', 'select'), true,
  'authenticated may read the tenant policy — rows are gated by RLS, columns never by policy');
select is(has_function_privilege('anon', 'public.tenant_provider_policy_v1()', 'execute'), false,
  'anon may not call the tenant policy read path');
select is(has_function_privilege('authenticated', 'public.model_providers_one_revision()', 'execute'), false,
  'the matrix-revision guard is a trigger function, not a callable');
select is(has_function_privilege('authenticated', 'public.tenant_provider_policy_narrows_platform()', 'execute'), false,
  'the narrow-only guard is a trigger function, not a callable');
select is(has_function_privilege('authenticated', 'public.tenant_provider_policy_v1()', 'execute'), true,
  'the gateway reads the tenant narrowing as the calling user (security invoker)');

-- ── 3. RLS is on, and the tenant policy has exactly the one read policy ─────────────────────
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
     and policyname = 'tenant_provider_policy_member_read'
     and cmd = 'SELECT' and permissive = 'PERMISSIVE'
     and 'authenticated' = any (array(select r from unnest(string_to_array('authenticated', ',')) as r))
), 1::bigint, 'the one read policy exists, permissive, SELECT, for authenticated');
select is((select count(*) from pg_policies where tablename = 'tenant_provider_policy' and schemaname = 'public'), 1::bigint, 'no second policy can appear on tenant_provider_policy unnoticed');

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

-- ── 5. the guards that make the configuration replayable (F40) ──────────────────────────────
select is(pg_temp.try_insert_provider('second_local_box', 'medium', 6, 'restricted', 2), '23514', 'two rows with different clearance_revision are refused: a half-swapped matrix cannot be replayed');
select is(pg_temp.try_insert_provider('claude', 'large', 7, 'restricted', 1), '23505', 'duplicate provider_key is refused by the primary key');
select is(pg_temp.try_insert_provider('box2', 'large', 3, 'public', 1), '23505', 'cost_rank is unique: two providers cannot claim the same place in the cost order');
select is(pg_temp.try_insert_provider('bad key', 'large', 8, 'public', 1), '23514', 'provider_key must match the contract key shape (keys.ts ProviderKey)');
select is(pg_temp.try_insert_provider('box3', 'enormous', 9, 'public', 1), '23514', 'capability_tier is the contract enum');
select is(pg_temp.try_insert_provider('box4', 'large', 10, 'secret_class', 1), '23514', 'max_cleared_class must be a real data class (data_class_is_valid)');
select is(pg_temp.try_insert_provider('box5', 'large', 11, 'public', 1, 'verifier-only-model', null), '23514', 'a verifier model without the eval set that proved it adequate is a pair violation (#9, config.ts:28-39)');

select is(pg_temp.try_route('compose', 'local_box', 1), 'ok', 'compose chain position 1 records');
select is(pg_temp.try_route('compose', 'workers_ai', 2), 'ok', 'compose chain position 2 records');
select is(pg_temp.try_route('compose', 'claude', 2), '23505', 'two providers may not hold the same position in one task chain');
select is(pg_temp.try_route('compose', 'local_box', 3), '23505', 'one provider may not appear twice in one task chain');
select is(pg_temp.try_route('translate', 'claude', 5), '23514', 'task_class is the contract enum (route/condense/compose/verify)');
select is(pg_temp.try_route('compose', 'no_such_provider', 6), '23503', 'a chain may not name a provider the registry does not have (F31 eligibility starts in the data)');

-- ── 6. a tenant may narrow, never widen (§12.4, provider-route.ts narrowClearance) ─────────
select isnt((select id::text from public.organisations order by id limit 1), '',
  'a synthetic tenant exists from supabase/seed.sql for the policy fixtures');
select is(pg_temp.try_tenant_policy(
  (select id from public.organisations order by id limit 1), 'client_confidential', 'claude'), 'ok', 'a narrowing the platform already cleared is accepted');
select is(pg_temp.try_tenant_policy(
  (select id from public.organisations order by id limit 1), 'internal', 'workers_ai'), 'ok', 'a narrowing at internal is accepted (workers_ai''s ceiling is internal)');
select is(pg_temp.try_tenant_policy(
  (select id from public.organisations order by id limit 1), 'client_confidential', 'workers_ai'), '23514', 'workers_ai may not be allowed for client_confidential: the tenant cannot widen the platform matrix');
select is(pg_temp.try_tenant_policy(
  (select id from public.organisations order by id limit 1), 'restricted', 'openrouter'), '23514', 'no tenant may open restricted content to a hosted provider (TOI-ADR-12)');
select is(pg_temp.try_tenant_policy(
  (select id from public.organisations order by id limit 1), 'public', 'no_such_provider'), '23514',
  'a policy naming a provider outside the registry is refused by the narrow-only BEFORE-row guard, '
  || 'which runs before the foreign key (B1: CI run 42726035516 returned 23514, not 23503)');
select is(pg_temp.try_tenant_policy(
  (select id from public.organisations order by id limit 1), 'secret_class', 'claude'), '23514', 'the policy class must be a real data class');
select is(pg_temp.try_disable_provider('claude'), 'ok', 'a provider can be taken offline by the owner');
select is(pg_temp.try_tenant_policy(
  (select id from public.organisations order by id limit 1), 'public', 'claude'), '23514', 'a policy row naming a disabled provider is refused: enabling is configuration, not a side effect of a tenant write');

-- ── 7. health rows and the fail-closed read path ───────────────────────────────────────────
select is(pg_temp.try_health('workers_ai', 'healthy', 240), 'ok', 'a scheduled probe row records');
select is(pg_temp.try_health('workers_ai', 'on_fire', 240), '23514', 'status is the F37 vocabulary, not free text');
select is(pg_temp.try_health('workers_ai', 'degraded', -5), '23514', 'latency cannot be negative');
select is(pg_temp.try_health('workers_ai', 'down', 99999999), '23514', 'latency is bounded, so a broken probe cannot poison the route window');

set local role authenticated;
select is((select count(*) from public.tenant_provider_policy_v1()), 0::bigint, 'with no tenant scope established the read path returns nothing, never a default tenant (§4.1)');
select is((select count(*) from public.tenant_provider_policy), 0::bigint, 'the same closure holds for a direct read: RLS gates the rows before the function does');
select is(pg_temp.try_health('workers_ai', 'healthy', 100), '42501', 'authenticated cannot write provider_health even through a helper: the revoke is real');

select * from finish();
rollback;
