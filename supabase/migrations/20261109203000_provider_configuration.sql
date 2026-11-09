-- T-116: provider and clearance configuration (§6.1, §12.4; decision #45).
-- The model chain the gateway consumes today as reviewed, injected configuration
-- (`parseGatewayConfiguration`, src/platform/gateway/config.ts) gets a Postgres home here.
-- This migration changes no chain-walking and no clearance behaviour: only where the
-- configuration comes from. PR-2 of T-116 adds the typed repository that reads it.
--
-- Privilege discipline (#60, merged answer): every object created here is revoked from the
-- request roles **by name**, and every function is revoked and granted by name. `tenancy_core.sql:335`
-- revoked the tables that existed then; a new table starts with the grantee defaults of its owner,
-- so it must be closed explicitly here.
--
-- Timestamp claim (daily sync): later than every merged migration (`20261107024000_session_store.sql`)
-- and later than the in-flight `20261109160000_function_privileges.sql` on PR #132, so a rebase stays
-- in order. One migration per PR (`scripts/migrations.mjs:37`).

begin;

-- ── 1. model_providers ──────────────────────────────────────────────────────────────────────
-- The platform registry row per provider (contract: `PlatformProvider`, provider-route.ts:56-66),
-- plus the deployment endpoint detail (`ProviderEndpoint`, config.ts:28-39) and the F40 clearance
-- revision the run audit records. No secret belongs in this table, and none is stored here.
--
-- Why there is no separate clearance-matrix table: the reviewed matrix in
-- `PLATFORM_DEFAULT_CLEARANCE` (provider-route.ts:77-84) is exactly "the providers whose ceiling
-- reaches this class" — public: all five; internal: local_box, workers_ai, claude;
-- client_confidential: local_box, claude (ADR-0007 keeps the **chat** matrix unchanged);
-- restricted: local_box only. `max_cleared_class` therefore derives the matrix without a second
-- place for it to drift. The repository does that derivation; SQL does not encode a matrix view,
-- because §9.3 keeps provider identity out of anything an employee can read.
create table public.model_providers (
  provider_key text primary key,
  capability_tier text not null,
  cost_rank integer not null,
  max_cleared_class text not null,
  supports_structured_output boolean not null default false,
  enabled boolean not null default true,
  -- F40: every route decision records the matrix revision it used, so a decision can be replayed.
  clearance_revision bigint not null,
  model text,
  context_window_units integer,
  verifier_model text,
  verifier_eval_set_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint model_providers_key_shape check (provider_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint model_providers_tier check (capability_tier in ('small', 'medium', 'large')),
  constraint model_providers_cost_rank_positive check (cost_rank > 0),
  constraint model_providers_cost_rank_unique unique (cost_rank),
  constraint model_providers_class_valid check (public.data_class_is_valid(max_cleared_class)),
  constraint model_providers_revision_positive check (clearance_revision > 0),
  -- A model id is a deployment fact; `null` means "this provider is registered but its serving
  -- model has not been recorded", which the repository must treat as **missing configuration** and
  -- fail closed on (T-116 acceptance box), never as "use a default model".
  constraint model_providers_model_shape check (model is null or model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  constraint model_providers_context_window_positive check (context_window_units is null or context_window_units > 0),
  constraint model_providers_verifier_shape check (verifier_model is null or verifier_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  constraint model_providers_verifier_version_shape check (verifier_eval_set_version is null or verifier_eval_set_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- #9: a verifier model counts only with the eval set that proved it adequate. A pair, like the
  -- lease pair on `ingestion_jobs` (knowledge_core.sql:392-393): one half alone is a lie.
  constraint model_providers_verifier_pair check (
    (verifier_model is null and verifier_eval_set_version is null)
    or (verifier_model is not null and verifier_eval_set_version is not null)
  )
);

comment on table public.model_providers is
  'Platform model registry (plan §6.1). Reviewed configuration: agents do not insert rows; a change is a migration or a supervisor action. max_cleared_class is the provider ceiling from which the §12.4 clearance matrix is derived (ADR-0007 keeps the chat matrix narrower than the embedding one). No secrets.';
comment on column public.model_providers.clearance_revision is
  'F40: the matrix revision recorded with every route decision. One value across the table at a time (model_providers_one_revision); a half-swapped matrix is not a replayable configuration.';
comment on column public.model_providers.model is
  'null = registered but unconfigured. The gateway must fail closed on it (T-116), never substitute a default provider model.';

-- One matrix revision at a time: two rows disagreeing is a configuration that cannot be replayed.
create or replace function public.model_providers_one_revision()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if exists (
    select 1 from public.model_providers
     where provider_key is distinct from new.provider_key
       and clearance_revision <> new.clearance_revision
  ) then
    raise exception 'model_providers: clearance_revision % does not match the recorded matrix %',
      new.clearance_revision,
      (select clearance_revision from public.model_providers limit 1)
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

create trigger model_providers_one_revision
  before insert or update of clearance_revision on public.model_providers
  for each row execute function public.model_providers_one_revision();

create trigger model_providers_touch_updated_at
  before update on public.model_providers
  for each row execute function public.touch_updated_at();

-- Defense in depth: the revokes below already close this table to request roles; RLS with no
-- policies means a future broad grant still exposes no row.
alter table public.model_providers enable row level security;

-- ── 2. provider_routes ──────────────────────────────────────────────────────────────────────
-- The per-task chain (contract: `DEFAULT_TASK_CHAIN_ORDER`, provider-route.ts:44-49). An expert may
-- shorten a chain but not reorder it (`chainFollowsPlatformOrder`), so the platform order is the
-- row set here and `position` is its index.
create table public.provider_routes (
  id bigint generated always as identity primary key,
  task_class text not null,
  provider_key text not null references public.model_providers (provider_key) on delete restrict,
  route_position smallint not null,
  created_at timestamptz not null default now(),

  constraint provider_routes_task_class check (task_class in ('route', 'condense', 'compose', 'verify')),
  constraint provider_routes_position_positive check (route_position >= 1),
  constraint provider_routes_one_provider_per_task unique (task_class, provider_key),
  constraint provider_routes_one_position_per_task unique (task_class, route_position)
);

comment on table public.provider_routes is
  'Per-task provider chain of record (plan §12.4 "Per-task chains", §17.1). Chain walking (F38) reads the order; it does not choose providers by hand. A tenant may shorten a chain in its expert definition but not reorder it past this order (§5.2).';

alter table public.provider_routes enable row level security;

-- ── 3. tenant_provider_policy ───────────────────────────────────────────────────────────────
-- The tenant's own narrowing of the platform matrix (plan §12.4: "tenant admins may narrow it;
-- widening needs a recorded tenant decision and provider-terms review"). Tenant-scoped: RLS on,
-- organisation id from the request GUC scope only (AGENTS.md §4.1).
create table public.tenant_provider_policy (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  data_class text not null,
  provider_key text not null references public.model_providers (provider_key) on delete restrict,
  recorded_by uuid,
  created_at timestamptz not null default now(),

  primary key (organisation_id, data_class, provider_key),
  constraint tenant_provider_policy_class_valid check (public.data_class_is_valid(data_class))
);

comment on table public.tenant_provider_policy is
  'A tenant''s allowed providers per data class. Rows may only remove providers the platform already cleared; the guard below refuses a row the platform does not clear, so the tenant can narrow and never widen (§12.4, provider-route.ts narrowClearance). Not employee-visible text (§9.3).';

-- Narrow-only, enforced in SQL rather than left to the caller: a widening row is a constraint
-- violation, so no RPC or future admin screen can smuggle one in.
create or replace function public.tenant_provider_policy_narrows_platform()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_ceiling text;
  v_enabled boolean;
begin
  select max_cleared_class, enabled
    into v_ceiling, v_enabled
    from public.model_providers
   where provider_key = new.provider_key;

  if v_ceiling is null or not v_enabled then
    raise exception 'tenant_provider_policy: provider % is not an enabled platform provider', new.provider_key
      using errcode = '23514';
  end if;

  if public.data_class_rank(v_ceiling) < public.data_class_rank(new.data_class) then
    raise exception 'tenant_provider_policy: provider % is cleared to %, not to %; a tenant may narrow, never widen',
      new.provider_key, v_ceiling, new.data_class
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger tenant_provider_policy_narrows_platform
  before insert or update of provider_key, data_class on public.tenant_provider_policy
  for each row execute function public.tenant_provider_policy_narrows_platform();

create policy tenant_provider_policy_member_read on public.tenant_provider_policy
  for select to authenticated
  using (public.is_active_member(organisation_id));

-- ── 4. provider_health ──────────────────────────────────────────────────────────────────────
-- F37 storage. T-314 owns the probing and the circuit breakers; this packet owns the shape, so the
-- week-3 packets have a table to write to and T-313 has one to read quota windows from.
create table public.provider_health (
  id bigint generated always as identity primary key,
  provider_key text not null references public.model_providers (provider_key) on delete cascade,
  checked_at timestamptz not null default now(),
  status text not null,
  latency_ms integer,
  quota_window_reset_at timestamptz,
  circuit_open boolean not null default false,
  observed_by text,

  constraint provider_health_status check (status in ('healthy', 'degraded', 'down', 'unknown', 'unreachable')),
  constraint provider_health_latency_range check (latency_ms is null or (latency_ms >= 0 and latency_ms <= 600000)),
  constraint provider_health_one_row_per_check unique (provider_key, checked_at),
  constraint provider_health_observer_shape check (observed_by is null or observed_by in ('scheduled', 'passive'))
);

comment on table public.provider_health is
  'F37 health and circuit state per provider (plan §17.1). Run-audit content: never rendered to an employee (§9.3). T-314 writes it; T-313 and route selection read it. `observed_by` separates the scheduled probe from the passive error-rate signal the plan requires.';

alter table public.provider_health enable row level security;

-- ── 5. the one read path a request role may use ─────────────────────────────────────────────
-- Security **invoker**: the RLS policy above does the row gating, and `current_organisation_id()`
-- reads only the GUC scope that `set_tenant_scope` established from the verified host plus the
-- caller's membership (AGENTS.md §4.1). With no scope set, it returns no rows rather than guessing.
create or replace function public.tenant_provider_policy_v1()
returns table (data_class text, provider_key text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select p.data_class, p.provider_key
    from public.tenant_provider_policy as p
   where p.organisation_id = public.current_organisation_id()
   order by p.data_class, p.provider_key;
$fn$;

comment on function public.tenant_provider_policy_v1() is
  'The tenant''s recorded narrowing of the clearance matrix, for the gateway to intersect with the platform baseline (effectiveClearance). Security invoker + RLS: it can only ever return the caller''s own tenant, and nothing at all when no tenant scope is set.';

-- ── 6. privileges (#60: revoke and grant by name; never rely on a default) ──────────────────
-- Platform tables: no request-role access of any kind. The gateway reads them through the server
-- path's own role, which the supervisor has not yet named — see #134; until that ruling, the
-- repository in PR-2 stays behind an injected port and these tables stay closed.
revoke all on table public.model_providers from anon, authenticated;
revoke all on table public.provider_routes from anon, authenticated;
revoke all on table public.provider_health from anon, authenticated;

-- Tenant table: read for active members only (the policy above), through the function; no insert,
-- update or delete for any request role in this migration — the admin write path is T-202's scoped
-- RPC (#41/T-111b precedent), not a raw grant.
revoke all on table public.tenant_provider_policy from anon, authenticated;
grant select on table public.tenant_provider_policy to authenticated;

revoke all on function public.model_providers_one_revision() from public, anon, authenticated;
revoke all on function public.tenant_provider_policy_narrows_platform() from public, anon, authenticated;
revoke all on function public.tenant_provider_policy_v1() from public, anon, authenticated;
grant execute on function public.tenant_provider_policy_v1() to authenticated;


commit;
