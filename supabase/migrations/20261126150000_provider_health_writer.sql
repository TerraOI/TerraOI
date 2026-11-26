-- T-314 PR-3: F37 `provider_health` writer for the gateway server path (#134 / #45).
-- T-116 owns the table; this packet owns the probe and the one named write function.
-- Schema `gateway_config` is not Data-API exposed (supabase/config.toml exposes public + graphql_public).
-- Role `toi_gateway_config` is NOLOGIN, reached over CONFIG_DB (T-004 §20.8 human steps).
--
-- Timestamp: later than main's newest migration (`20261125100000_evals.sql`) per COORDINATION §3.

begin;

create schema if not exists gateway_config;
revoke all on schema gateway_config from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'toi_gateway_config') then
    create role toi_gateway_config nologin;
  end if;
end
$$;

comment on schema gateway_config is
  'Server-path gateway configuration and F37 health writes (T-116 / T-314, #134). Not exposed through the Data API. Reached only as toi_gateway_config over the CONFIG_DB Hyperdrive binding; the login user, password and binding are owner human steps (T-004 §20.8).';

grant usage on schema gateway_config to toi_gateway_config;

-- No table grants: inserts go through this SECURITY DEFINER only (same containment as job_api).
create or replace function gateway_config.record_provider_health_v1(
  p_provider_key text,
  p_status text,
  p_latency_ms integer,
  p_circuit_open boolean,
  p_observed_by text,
  p_checked_at timestamptz default now(),
  p_quota_window_reset_at timestamptz default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id bigint;
begin
  if p_provider_key is null or btrim(p_provider_key) = '' then
    raise exception 'provider_key is required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('healthy', 'degraded', 'down', 'unknown', 'unreachable') then
    raise exception 'status must be an F37 health vocabulary value' using errcode = '22023';
  end if;
  if p_observed_by is null or p_observed_by not in ('scheduled', 'passive') then
    raise exception 'observed_by must be scheduled or passive' using errcode = '22023';
  end if;
  if p_circuit_open is null then
    raise exception 'circuit_open is required' using errcode = '22023';
  end if;
  if p_latency_ms is not null and (p_latency_ms < 0 or p_latency_ms > 600000) then
    raise exception 'latency_ms out of range' using errcode = '22023';
  end if;

  insert into public.provider_health (
    provider_key, checked_at, status, latency_ms, quota_window_reset_at, circuit_open, observed_by
  ) values (
    p_provider_key,
    coalesce(p_checked_at, now()),
    p_status,
    p_latency_ms,
    p_quota_window_reset_at,
    p_circuit_open,
    p_observed_by
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function gateway_config.record_provider_health_v1(text, text, integer, boolean, text, timestamptz, timestamptz) is
  'F37 append-only health observation (#134). EXECUTE only for toi_gateway_config; no table grant. '
  'Request roles and service_role cannot call it. Status/observed_by are closed enums matching provider_health CHECKs.';

revoke all on function gateway_config.record_provider_health_v1(text, text, integer, boolean, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function gateway_config.record_provider_health_v1(text, text, integer, boolean, text, timestamptz, timestamptz)
  to toi_gateway_config;

-- Lifecycle switches already grant provider_switch_state_v1 when this role exists; keep that path live
-- if T-304 landed before this role was created on an older database.
do $$
begin
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'toi_control' and p.proname = 'provider_switch_state_v1'
  ) then
    execute 'grant usage on schema toi_control to toi_gateway_config';
    execute 'grant execute on function toi_control.provider_switch_state_v1(text) to toi_gateway_config';
  end if;
end
$$;

commit;
