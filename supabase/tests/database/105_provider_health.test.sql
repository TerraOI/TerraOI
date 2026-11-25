-- T-314 PR-3: gateway_config.record_provider_health_v1 (#134 / F37). Slot 105 (COORDINATION §6b).
-- Written first: red until 20261123140000_provider_health_writer.sql lands.
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

select has_schema('gateway_config', '1 gateway_config schema exists (#134)');
select has_role('toi_gateway_config', '2 toi_gateway_config NOLOGIN role exists (#134)');
select ok(
  (select rolcanlogin from pg_roles where rolname = 'toi_gateway_config') = false,
  '3 toi_gateway_config is NOLOGIN');

select ok(
  has_function_privilege(
    'toi_gateway_config',
    'gateway_config.record_provider_health_v1(text, text, integer, boolean, text, timestamptz, timestamptz)',
    'execute'
  ),
  '4 toi_gateway_config may EXECUTE the health writer by name (FAQ-0010)');

select is(
  has_function_privilege(
    'anon',
    'gateway_config.record_provider_health_v1(text, text, integer, boolean, text, timestamptz, timestamptz)',
    'execute'
  ),
  false,
  '5 anon cannot EXECUTE the health writer');
select is(
  has_function_privilege(
    'authenticated',
    'gateway_config.record_provider_health_v1(text, text, integer, boolean, text, timestamptz, timestamptz)',
    'execute'
  ),
  false,
  '6 authenticated cannot EXECUTE the health writer');
select is(
  has_function_privilege(
    'service_role',
    'gateway_config.record_provider_health_v1(text, text, integer, boolean, text, timestamptz, timestamptz)',
    'execute'
  ),
  false,
  '7 service_role cannot EXECUTE the health writer');

select is(has_table_privilege('toi_gateway_config', 'public.provider_health', 'insert'), false,
  '8 toi_gateway_config has no table INSERT: writes go only through the SECURITY DEFINER');
select is(has_table_privilege('toi_gateway_config', 'public.provider_health', 'select'), false,
  '9 toi_gateway_config has no table SELECT either');
select is(has_table_privilege('authenticated', 'public.provider_health', 'insert'), false,
  '10 authenticated still cannot insert provider_health directly');

-- Seed the two providers this suite writes against (046 owns the full five-row registry seed;
-- this file only needs the FK targets for the writer).
insert into public.model_providers (
  provider_key, capability_tier, cost_rank, max_cleared_class, clearance_revision, enabled
) values
  ('local_box', 'medium', 1, 'restricted', 1, true),
  ('workers_ai', 'large', 2, 'internal', 1, true)
on conflict (provider_key) do nothing;

-- 100's idiom: SET ROLE only works for roles the session is a member of.
grant toi_gateway_config to postgres;

create or replace function pg_temp.try_record(
  p_role text,
  p_key text,
  p_status text,
  p_latency integer,
  p_circuit boolean,
  p_by text
) returns text
language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  perform gateway_config.record_provider_health_v1(
    p_key, p_status, p_latency, p_circuit, p_by, now(), null
  );
  reset role;
  return 'ok';
exception when others then
  reset role;
  return sqlstate;
end;
$$;

select is(
  pg_temp.try_record('toi_gateway_config', 'workers_ai', 'healthy', 12, false, 'scheduled'),
  'ok',
  '11 toi_gateway_config scheduled probe inserts a healthy row');

select is(
  (select count(*)::int from public.provider_health
    where provider_key = 'workers_ai' and status = 'healthy' and observed_by = 'scheduled'),
  1,
  '12 the inserted row is visible to the migration owner (append-only history)');

select is(
  pg_temp.try_record('toi_gateway_config', 'local_box', 'down', 5000, true, 'passive'),
  'ok',
  '13 passive observation with circuit_open=true is accepted');

select is(
  pg_temp.try_record('toi_gateway_config', 'workers_ai', 'on_fire', 10, false, 'scheduled'),
  '22023',
  '14 free-text status is refused before the table CHECK');

select is(
  pg_temp.try_record('toi_gateway_config', 'workers_ai', 'healthy', 10, false, 'cron'),
  '22023',
  '15 observed_by outside scheduled|passive is refused');

select is(
  pg_temp.try_record('authenticated', 'workers_ai', 'healthy', 10, false, 'scheduled'),
  '42501',
  '16 authenticated cannot call the writer even when set local role');

select * from finish();
rollback;
