-- T-313 PR-1: F19 budget accounts + atomic reservation authority (plan §12.3).
-- Audit / F22 (agent_runs-linked ledger) waits for T-104 (#178).
-- Server path: schema `budget_ledger` + NOLOGIN `toi_budget_ledger` over a Hyperdrive binding
-- (same containment class as gateway_config / #134). Request roles hold no EXECUTE.

begin;

create schema if not exists budget_ledger;
revoke all on schema budget_ledger from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'toi_budget_ledger') then
    create role toi_budget_ledger nologin;
  end if;
end
$$;

comment on schema budget_ledger is
  'F19 reservation authority (T-313). Not Data-API exposed. Reached as toi_budget_ledger over a '
  'server Hyperdrive binding (T-004 §20.8). Ceiling numbers are tenant policy; tests set them explicitly.';

grant usage on schema budget_ledger to toi_budget_ledger;

create table public.budget_accounts (
  organisation_id uuid primary key
    references public.organisations (id) on delete cascade,
  daily_ceiling_units bigint not null check (daily_ceiling_units >= 0),
  monthly_ceiling_units bigint not null check (monthly_ceiling_units >= 0),
  concurrent_run_cap integer not null check (concurrent_run_cap >= 0),
  burst_per_user integer not null check (burst_per_user >= 0),
  day_key date not null,
  day_reserved_units bigint not null default 0 check (day_reserved_units >= 0),
  day_settled_units bigint not null default 0 check (day_settled_units >= 0),
  month_key text not null check (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  month_reserved_units bigint not null default 0 check (month_reserved_units >= 0),
  month_settled_units bigint not null default 0 check (month_settled_units >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.budget_accounts is
  'Per-tenant spend ceilings and rolling reserved/settled units (plan §12.3 M1). Authority for hard ceilings.';

create table public.budget_reservations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null
    references public.organisations (id) on delete cascade,
  run_id uuid not null,
  attempt_id text not null check (char_length(attempt_id) between 1 and 128),
  user_id uuid references public.profiles (id) on delete set null,
  task text not null check (task in ('route', 'compose', 'verify', 'condense', 'ingest')),
  provider_key text not null check (char_length(provider_key) between 1 and 64),
  max_units bigint not null check (max_units > 0),
  state text not null check (state in ('reserved', 'settled', 'released', 'ambiguous')),
  created_at timestamptz not null default now(),
  reconciled_at timestamptz,
  used_units bigint check (used_units is null or used_units >= 0),
  constraint budget_reservations_org_attempt unique (organisation_id, attempt_id),
  constraint budget_reservations_reconcile_pair check (
    (state = 'reserved' and reconciled_at is null)
    or (state <> 'reserved' and reconciled_at is not null)
  )
);

comment on table public.budget_reservations is
  'Atomic F19 reservations per chain attempt. Idempotent on (organisation_id, attempt_id).';

create index budget_reservations_org_run_idx
  on public.budget_reservations (organisation_id, run_id);
create index budget_reservations_org_user_reserved_idx
  on public.budget_reservations (organisation_id, user_id)
  where state = 'reserved';

alter table public.budget_accounts enable row level security;
alter table public.budget_reservations enable row level security;
revoke all on table public.budget_accounts from public, anon, authenticated, service_role;
revoke all on table public.budget_reservations from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- reserve / reconcile (server path)
create or replace function budget_ledger.ensure_account_v1(
  p_organisation_id uuid,
  p_daily_ceiling bigint,
  p_monthly_ceiling bigint,
  p_concurrent_cap integer,
  p_burst_per_user integer
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_day date := (timezone('utc', now()))::date;
  v_month text := to_char(timezone('utc', now()), 'YYYY-MM');
begin
  if p_organisation_id is null then
    raise exception 'organisation_id is required' using errcode = '22023';
  end if;
  insert into public.budget_accounts (
    organisation_id, daily_ceiling_units, monthly_ceiling_units,
    concurrent_run_cap, burst_per_user, day_key, month_key
  ) values (
    p_organisation_id, p_daily_ceiling, p_monthly_ceiling,
    p_concurrent_cap, p_burst_per_user, v_day, v_month
  )
  on conflict (organisation_id) do nothing;
end;
$fn$;

create or replace function budget_ledger.reserve_v1(
  p_organisation_id uuid,
  p_run_id uuid,
  p_attempt_id text,
  p_user_id uuid,
  p_task text,
  p_provider_key text,
  p_max_input_units bigint,
  p_max_output_units bigint
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_acct public.budget_accounts%rowtype;
  v_max bigint;
  v_existing uuid;
  v_id uuid;
  v_day date := (timezone('utc', now()))::date;
  v_month text := to_char(timezone('utc', now()), 'YYYY-MM');
  v_open_runs integer;
  v_user_burst integer;
begin
  if p_organisation_id is null or p_run_id is null or nullif(btrim(p_attempt_id), '') is null then
    raise exception 'organisation_id, run_id and attempt_id are required' using errcode = '22023';
  end if;
  if p_task is null or p_task not in ('route', 'compose', 'verify', 'condense', 'ingest') then
    raise exception 'task is not a billable phase' using errcode = '22023';
  end if;
  if p_provider_key is null or btrim(p_provider_key) = '' then
    raise exception 'provider_key is required' using errcode = '22023';
  end if;
  if p_max_input_units is null or p_max_input_units < 0
     or p_max_output_units is null or p_max_output_units < 0 then
    raise exception 'max units must be non-negative' using errcode = '22023';
  end if;

  v_max := p_max_input_units + p_max_output_units;
  if v_max <= 0 then
    raise exception 'reservation max_units must be positive' using errcode = '22023';
  end if;

  select id into v_existing
    from public.budget_reservations
   where organisation_id = p_organisation_id
     and attempt_id = p_attempt_id;
  if found then
    return v_existing;
  end if;

  select * into v_acct
    from public.budget_accounts
   where organisation_id = p_organisation_id
   for update;
  if not found then
    raise exception 'budget account unavailable' using errcode = 'P0001';
  end if;

  if v_acct.day_key <> v_day then
    v_acct.day_key := v_day;
    v_acct.day_reserved_units := 0;
    v_acct.day_settled_units := 0;
  end if;
  if v_acct.month_key <> v_month then
    v_acct.month_key := v_month;
    v_acct.month_reserved_units := 0;
    v_acct.month_settled_units := 0;
  end if;

  if v_acct.day_reserved_units + v_acct.day_settled_units + v_max > v_acct.daily_ceiling_units then
    raise exception 'daily budget ceiling exceeded' using errcode = 'P0001';
  end if;
  if v_acct.month_reserved_units + v_acct.month_settled_units + v_max > v_acct.monthly_ceiling_units then
    raise exception 'monthly budget ceiling exceeded' using errcode = 'P0001';
  end if;

  select count(distinct run_id)::integer into v_open_runs
    from public.budget_reservations
   where organisation_id = p_organisation_id
     and state = 'reserved';
  if v_open_runs >= v_acct.concurrent_run_cap
     and not exists (
       select 1 from public.budget_reservations
        where organisation_id = p_organisation_id
          and run_id = p_run_id
          and state = 'reserved'
     ) then
    raise exception 'concurrent run cap exceeded' using errcode = 'P0001';
  end if;

  if p_user_id is not null then
    select count(*)::integer into v_user_burst
      from public.budget_reservations
     where organisation_id = p_organisation_id
       and user_id = p_user_id
       and state = 'reserved';
    if v_user_burst >= v_acct.burst_per_user then
      raise exception 'per-user burst limit exceeded' using errcode = 'P0001';
    end if;
  end if;

  insert into public.budget_reservations (
    organisation_id, run_id, attempt_id, user_id, task, provider_key, max_units, state
  ) values (
    p_organisation_id, p_run_id, p_attempt_id, p_user_id, p_task, p_provider_key, v_max, 'reserved'
  ) returning id into v_id;

  update public.budget_accounts
     set day_key = v_acct.day_key,
         day_reserved_units = v_acct.day_reserved_units + v_max,
         month_key = v_acct.month_key,
         month_reserved_units = v_acct.month_reserved_units + v_max,
         updated_at = now()
   where organisation_id = p_organisation_id;

  return v_id;
end;
$fn$;

create or replace function budget_ledger.reconcile_v1(
  p_organisation_id uuid,
  p_attempt_id text,
  p_reservation_id uuid,
  p_outcome text,
  p_used_units bigint default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row public.budget_reservations%rowtype;
begin
  if p_organisation_id is null or nullif(btrim(p_attempt_id), '') is null or p_reservation_id is null then
    raise exception 'organisation_id, attempt_id and reservation_id are required' using errcode = '22023';
  end if;
  if p_outcome is null or p_outcome not in ('settled', 'released', 'ambiguous') then
    raise exception 'outcome must be settled, released or ambiguous' using errcode = '22023';
  end if;

  select * into v_row
    from public.budget_reservations
   where id = p_reservation_id
     and organisation_id = p_organisation_id
     and attempt_id = p_attempt_id
   for update;
  if not found then
    raise exception 'reservation not found' using errcode = 'P0001';
  end if;
  if v_row.state <> 'reserved' then
    return; -- idempotent reconcile
  end if;

  update public.budget_reservations
     set state = p_outcome,
         reconciled_at = now(),
         used_units = case
           when p_outcome = 'settled' then coalesce(p_used_units, v_row.max_units)
           when p_outcome = 'ambiguous' then coalesce(p_used_units, v_row.max_units)
           else 0
         end
   where id = v_row.id;

  update public.budget_accounts
     set day_reserved_units = greatest(0, day_reserved_units - v_row.max_units),
         month_reserved_units = greatest(0, month_reserved_units - v_row.max_units),
         day_settled_units = day_settled_units + case
           when p_outcome = 'released' then 0
           else coalesce(p_used_units, v_row.max_units)
         end,
         month_settled_units = month_settled_units + case
           when p_outcome = 'released' then 0
           else coalesce(p_used_units, v_row.max_units)
         end,
         updated_at = now()
   where organisation_id = p_organisation_id;
end;
$fn$;

comment on function budget_ledger.ensure_account_v1(uuid, bigint, bigint, integer, integer) is
  'Create a tenant budget account if missing. Ceilings are caller-supplied (Company1 input; tests set synthetics).';
comment on function budget_ledger.reserve_v1(uuid, uuid, text, uuid, text, text, bigint, bigint) is
  'F19 atomic reserve of conservative max units against the tenant account. Fail closed on ceiling/cap.';
comment on function budget_ledger.reconcile_v1(uuid, text, uuid, text, bigint) is
  'Release, settle or keep ambiguous liability after a provider attempt (§12.3).';

revoke all on function budget_ledger.ensure_account_v1(uuid, bigint, bigint, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function budget_ledger.reserve_v1(uuid, uuid, text, uuid, text, text, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function budget_ledger.reconcile_v1(uuid, text, uuid, text, bigint)
  from public, anon, authenticated, service_role;

grant execute on function budget_ledger.ensure_account_v1(uuid, bigint, bigint, integer, integer)
  to toi_budget_ledger;
grant execute on function budget_ledger.reserve_v1(uuid, uuid, text, uuid, text, text, bigint, bigint)
  to toi_budget_ledger;
grant execute on function budget_ledger.reconcile_v1(uuid, text, uuid, text, bigint)
  to toi_budget_ledger;

commit;
