-- T-304 — the lifecycle switch settings, their flip history, tenant suspend/resume, and
-- `provision_tenant_v1` (F05). Migration timestamp 20261116140000: newest **merged** is
-- 20261113010000_scoped_identity_reads.sql, and the newest sitting in an **open** PR is
-- 20261115060000_identity_methods.sql (#186) — also open are 20261113120000 (#179),
-- 20261113074600 (#143), 20261113020000 (#178), 20261111030000 (#160), 20261109235000 (#150),
-- 20261109230000 (#149) — so this sorts after all eight and no merge order inverts the `migrations`
-- job. The claim and this timestamp are recorded in the packet's Status line; COORDINATION §3 puts
-- them in the daily sync, and a different ruling is one filename away.
--
-- Acceptance tests: supabase/tests/database/100_lifecycle_switches.test.sql (slot 100), **written
-- first** and pushed as the red run at 0d5291d, restructured in the next commit on this branch. There
-- is no Docker on the authoring machine, so every assertion in that file executes only in CI's
-- `database` job (FAQ-0009); nothing here is claimed as run locally.
--
-- What plan §972 asks for, and the one place this file does not follow its letter. §972 names kill
-- switches "per platform, tenant, service, provider and connector". Stopping a **tenant** is not a
-- switch row here, because the merged schema already has one mechanism for it: `organisations.status`
-- is what `is_active_member` (20261105060000_tenancy_core.sql:176-187) and `resolve_tenant_host`
-- (:234-248) read, and a second way to stop a tenant is how the two drift apart. So
-- `lifecycle_switches` stores the four kinds that have no existing axis — platform, service, expert,
-- provider — while `suspend_tenant_v1` / `resume_tenant_v1` move `organisations.status` and are
-- recorded in the flip history, which does carry all five names. Suite tests 20, 21, 45 and 47 pin
-- that split. A **connector** scope is not added: no connector registry exists on main and no packet
-- owns one, so a row nobody reads would be a promise this file cannot keep.
--
-- Who may call any of this. PostgreSQL hands EXECUTE on a new function to PUBLIC, and a migration
-- cannot close that default (#60, FAQ-0010, and 001_function_privileges.test.sql tests 34-38 for why
-- this repository cannot close it itself), so every function below is revoked by full signature and
-- granted only to `toi_control_plane`. No request role and no `service_role` holds a privilege on
-- either table either, so there is no Data API path to any of it. `toi_control_plane` is a NOLOGIN
-- group in the shape the supervisor accepted for the session Worker in #75
-- (20261112234000_session_worker_role.sql:12-27): a login that is IN ROLE it authenticates through
-- the §20.8 human steps, and that login is **not created here** — creating it, its password and any
-- Hyperdrive binding are owner-side work, and this file does not pretend otherwise.
--
-- FAQ-0011 (`p_organisation_id` first, `set_tenant_scope` as the first statement) is deliberately not
-- applied, and the suite counts the six functions so a seventh cannot accrete under a false
-- assumption. `set_tenant_scope` raises 28000 unless `auth.uid()` is already an active member of the
-- tenant (tenancy_core:203-220), so it cannot authorize provisioning a tenant that does not exist
-- yet, and it cannot authorize stopping one an operator no longer belongs to. The gate is the grant,
-- plus `pg_has_role(session_user, …)`: `session_user` and not `current_user`, because these bodies are
-- SECURITY DEFINER and `current_user` inside them is the function owner.
--
-- Actor attribution, stated honestly. `actor_role` is `session_user` as the database read it — the
-- login that authenticated, which no argument can forge, and there is no actor, user or membership
-- parameter in any signature (suite 51). `requested_by` is the human the operator named: recorded, and
-- the column comment says the database cannot verify it, rather than implying an audit trail stronger
-- than the mechanism supports. A full audit ledger belongs to whoever owns it (T-313, unmerged), and
-- these tables are the switch's history, not that ledger: `provision_tenant_v1` writes no flip row.
--
-- What is NOT here, each named rather than left quiet:
--   * #98's `policy_revision` bump on suspend. Its writer is T-202 and lives on #179 (draft); adding a
--     second trigger here would race with it. Suite 37 pins that the revision is unchanged, so the gap
--     stays visible instead of reading as handled. Suspension still bites immediately through the
--     merged `is_active_member` status predicate (suite 38).
--   * The provider registry. #45 is unanswered: there is no `model_providers` / `provider_routes`
--     owner, so a provider switch is keyed by `providerKey` alone and nothing checks the key against a
--     catalog (suite 19 pins that as an assumption, not as a feature).
--   * `tenant_experts` (T-311) and any `src/platform/gateway/` change. An expert switch can be stored
--     and read (suite 33-34); "its routes are refused at the gateway" needs both, and this packet must
--     not touch the gateway (Owns list; COORDINATION §2). That acceptance box stays unticked.
--   * Entitlements and brand defaults, both named in F05: no entitlement table exists and #62 says no
--     packet owns `tenant_brands`, so provisioning seeds neither, and suite 73 asserts that instead of
--     letting it pass unnoticed.
--   * A fix for #67. `organisations.locale` rejects `en-GB` and the adjacent timezone CHECK allows
--     exactly one slash (tenancy_core:25-26). This migration validates against those CHECKs and refuses
--     a value they reject (suite 65); it neither edits a merged migration nor works around it.
--   * Nothing in this file is granted to `anon` or `authenticated`, so the request pipeline cannot read
--     a switch yet. Wiring `lifecycle_switch_state_v1` into the pipeline is the next slice and needs a
--     COORDINATION §2 ask, because the consumer is Lane 2's gateway.

-- ---------------------------------------------------------------- control-plane group (#75 pattern)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'toi_control_plane') then
    create role toi_control_plane nologin;
  end if;
end
$$;

comment on role toi_control_plane is
  'NOLOGIN group for the platform control plane (T-304). Its EXECUTE grants are the six lifecycle functions and nothing else; no table privilege anywhere. The login user that is IN ROLE it, its password and its binding are §20.8 human steps, not this migration.';

-- Schema usage is needed to call a function in public; it is not a table privilege, and the suite
-- asserts separately (tests 6, 32) that this role reaches no table.
grant usage on schema public to toi_control_plane;

-- ---------------------------------------------------------------- the switch settings
-- Current state, one row per scope. `lifecycle_switch_flips` below is the append-only record.
create table public.lifecycle_switches (
  id uuid primary key default gen_random_uuid(),
  scope_kind text not null
    check (scope_kind in ('platform', 'service', 'expert', 'provider')),
  -- Never set here: a tenant is stopped through organisations.status. The column exists so one read
  -- function can answer every scope kind, and the CHECK below keeps it that way.
  organisation_id uuid references public.organisations (id) on delete cascade,
  scope_key text check (scope_key is null or scope_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  state text not null check (state in ('on', 'off')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  actor_role text not null check (char_length(actor_role) between 1 and 63),
  requested_by text not null check (char_length(btrim(requested_by)) between 1 and 200),
  flipped_at timestamptz not null default now(),
  check (
    (scope_kind = 'platform' and organisation_id is null and scope_key is null)
    or
    (scope_kind in ('service', 'expert', 'provider') and organisation_id is null and scope_key is not null)
  )
);
comment on table public.lifecycle_switches is
  'F05/§972 kill switches as explicit settings: platform, service, expert, provider. A missing row means not switched off, never off. Tenants are stopped by organisations.status (suspend_tenant_v1), which is what is_active_member and resolve_tenant_host already read.';
comment on column public.lifecycle_switches.actor_role is
  'session_user as Postgres recorded it at flip time. The login, not a human: no parameter supplies it.';
comment on column public.lifecycle_switches.requested_by is
  'The human the operator named. Recorded for the incident note; the database cannot verify it.';

-- One row per scope. A single expression-unique index covers both shapes, so the upsert in
-- set_lifecycle_switch_v1 can name it and there is no second partial index to keep in step.
create unique index lifecycle_switch_scope_udx on public.lifecycle_switches (
  scope_kind,
  coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(scope_key, '')
);

create table public.lifecycle_switch_flips (
  id bigint generated always as identity primary key,
  scope_kind text not null
    check (scope_kind in ('platform', 'tenant', 'service', 'expert', 'provider')),
  organisation_id uuid references public.organisations (id) on delete cascade,
  scope_key text,
  state text not null check (state in ('on', 'off')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  actor_role text not null check (char_length(actor_role) between 1 and 63),
  requested_by text not null check (char_length(btrim(requested_by)) between 1 and 200),
  flipped_at timestamptz not null default now(),
  check (
    (scope_kind = 'platform' and organisation_id is null and scope_key is null)
    or
    (scope_kind = 'tenant' and organisation_id is not null and scope_key is null)
    or
    (scope_kind in ('service', 'expert', 'provider') and organisation_id is null and scope_key is not null)
  )
);
comment on table public.lifecycle_switch_flips is
  'Append-only flip history (§972 actor and reason per flip). Written only by the lifecycle functions; the control-plane role holds no update or delete privilege, and rewriting a flip is what an incident review cannot survive.';
comment on column public.lifecycle_switch_flips.state is
  'For a tenant row, the effective state of organisations.status at that moment: suspended is off, active is on.';

create index lifecycle_switch_flips_scope_idx on public.lifecycle_switch_flips (
  scope_kind, organisation_id, scope_key, flipped_at desc, id desc
);

alter table public.lifecycle_switches enable row level security;
alter table public.lifecycle_switch_flips enable row level security;

-- Every request role and the control-plane role itself holds nothing here: new tables inherit the
-- Supabase per-schema defaults, so the revoke is load-bearing, not decoration (001 tests 34-38).
revoke all on table public.lifecycle_switches, public.lifecycle_switch_flips
  from public, anon, authenticated, service_role, toi_control_plane;

-- ---------------------------------------------------------------- the gate, written once
-- A helper rather than six copies of the same clause, so a later function cannot forget it. It reads
-- only the caller, so there is nothing for it to leak.
create or replace function public.require_control_plane()
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not pg_has_role(session_user, 'toi_control_plane', 'MEMBER') then
    raise exception 'caller is not a control-plane login' using errcode = '42501';
  end if;
end;
$$;
comment on function public.require_control_plane() is
  'The in-body control-plane gate: session_user, because the calling bodies are SECURITY DEFINER. The enforced boundary is the EXECUTE grant; this is the second net.';

-- ---------------------------------------------------------------- switch write
create or replace function public.set_lifecycle_switch_v1(
  p_scope_kind text,
  p_organisation_id uuid,
  p_scope_key text,
  p_state text,
  p_reason text,
  p_requested_by text
) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform public.require_control_plane();

  -- Every argument is checked before anything is written, so a refusal cannot half-apply.
  if p_scope_kind is null
     or p_scope_kind not in ('platform', 'service', 'expert', 'provider') then
    raise exception 'p_scope_kind must be platform, service, expert or provider; a tenant is stopped with suspend_tenant_v1, not with a switch row'
      using errcode = '22023';
  end if;
  if p_state is null or p_state not in ('on', 'off') then
    raise exception 'p_state must be on or off' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or char_length(p_reason) > 500 then
    raise exception 'p_reason is required (1-500 characters): an unattributed stop is not a kill switch, it is a mystery'
      using errcode = '22023';
  end if;
  if p_requested_by is null or btrim(p_requested_by) = '' or char_length(p_requested_by) > 200 then
    raise exception 'p_requested_by is required (1-200 characters)' using errcode = '22023';
  end if;

  if p_scope_kind = 'platform' then
    if p_organisation_id is not null or p_scope_key is not null then
      raise exception 'a platform switch names neither a tenant nor a key' using errcode = '22023';
    end if;
  else
    if p_organisation_id is not null then
      raise exception 'a service, expert or provider switch names no tenant; per-tenant provider control belongs to tenant_provider_policy (T-214)'
        using errcode = '22023';
    end if;
    if p_scope_key is null or p_scope_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
      raise exception 'p_scope_key must match the ProviderKey shape in src/contracts/keys.ts'
        using errcode = '22023';
    end if;
  end if;

  insert into public.lifecycle_switch_flips
      (scope_kind, organisation_id, scope_key, state, reason, actor_role, requested_by)
    values
      (p_scope_kind, null, nullif(p_scope_key, ''), p_state, p_reason, session_user::text, p_requested_by);

  insert into public.lifecycle_switches
      (scope_kind, organisation_id, scope_key, state, reason, actor_role, requested_by)
    values
      (p_scope_kind, null, nullif(p_scope_key, ''), p_state, p_reason, session_user::text, p_requested_by)
    on conflict (scope_kind,
                 coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 coalesce(scope_key, ''))
    do update set state = excluded.state,
                  reason = excluded.reason,
                  actor_role = excluded.actor_role,
                  requested_by = excluded.requested_by,
                  flipped_at = now();
end;
$$;
comment on function public.set_lifecycle_switch_v1(text, uuid, text, text, text, text) is
  'F05/§972: flip a platform, service, expert or provider switch, with a reason. Tenant is refused here on purpose (use suspend_tenant_v1). Control-plane only: no HTTP path reaches it.';

-- ---------------------------------------------------------------- switch read
-- The one read the request pipeline will use, per §17.1. It answers the tenant axis from
-- organisations.status so there is exactly one source of truth for that switch.
create or replace function public.lifecycle_switch_state_v1(
  p_scope_kind text,
  p_organisation_id uuid,
  p_scope_key text
) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_state text;
begin
  if p_scope_kind is null
     or p_scope_kind not in ('platform', 'tenant', 'service', 'expert', 'provider') then
    raise exception 'p_scope_kind must be platform, tenant, service, expert or provider'
      using errcode = '22023';
  end if;

  if p_scope_kind = 'tenant' then
    if p_organisation_id is null or p_scope_key is not null then
      raise exception 'a tenant switch read names exactly one organisation and no key' using errcode = '22023';
    end if;
    select case when o.status in ('active', 'provisioning') then 'on' else 'off' end
      into v_state
      from public.organisations o
     where o.id = p_organisation_id;
    if v_state is null then
      raise exception 'organisation not found' using errcode = '23503';
    end if;
    return v_state;
  end if;

  if p_scope_kind = 'platform' then
    if p_organisation_id is not null or p_scope_key is not null then
      raise exception 'a platform switch read names neither a tenant nor a key' using errcode = '22023';
    end if;
  else
    if p_organisation_id is not null then
      raise exception 'a service, expert or provider switch read names no tenant' using errcode = '22023';
    end if;
    if p_scope_key is null or p_scope_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
      raise exception 'p_scope_key must match the ProviderKey shape in src/contracts/keys.ts'
        using errcode = '22023';
    end if;
  end if;

  select state into v_state
    from public.lifecycle_switches
   where scope_kind = p_scope_kind
     and organisation_id is null
     and coalesce(scope_key, '') = coalesce(p_scope_key, '');
  -- Fail open on availability, closed on status: no row has ever meant "not stopped".
  return coalesce(v_state, 'on');
end;
$$;
comment on function public.lifecycle_switch_state_v1(text, uuid, text) is
  '§17.1 read for every switch axis. A tenant answers from organisations.status; the other four answer from lifecycle_switches, and a scope nobody has flipped reads on.';

-- ---------------------------------------------------------------- flip history read
create or replace function public.lifecycle_switch_history_v1(
  p_scope_kind text,
  p_organisation_id uuid,
  p_scope_key text,
  p_limit integer default 50
) returns table (
  flip_id bigint,
  scope_kind text,
  organisation_id uuid,
  scope_key text,
  state text,
  reason text,
  actor_role text,
  requested_by text,
  flipped_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_scope_kind is null
     or p_scope_kind not in ('platform', 'tenant', 'service', 'expert', 'provider') then
    raise exception 'p_scope_kind must be platform, tenant, service, expert or provider'
      using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500' using errcode = '22023';
  end if;
  if p_scope_kind = 'tenant' and p_organisation_id is null then
    raise exception 'a tenant history read names an organisation' using errcode = '22023';
  end if;
  if p_scope_kind <> 'tenant' and p_organisation_id is not null then
    raise exception 'a non-tenant history read names no organisation' using errcode = '22023';
  end if;

  return query
    select f.id, f.scope_kind, f.organisation_id, f.scope_key, f.state, f.reason,
           f.actor_role, f.requested_by, f.flipped_at
      from public.lifecycle_switch_flips f
     where f.scope_kind = p_scope_kind
       and (p_scope_kind <> 'tenant' or f.organisation_id = p_organisation_id)
       and coalesce(f.scope_key, '') = coalesce(p_scope_key, '')
     order by f.flipped_at desc, f.id desc
     limit p_limit;
end;
$$;
comment on function public.lifecycle_switch_history_v1(text, uuid, text, integer) is
  'The flips, newest first, with actor and reason: what makes "actor and reason per flip" an actual capability rather than a column.';

-- ---------------------------------------------------------------- tenant suspend and resume
create or replace function public.suspend_tenant_v1(
  p_organisation_id uuid,
  p_reason text,
  p_requested_by text
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  perform public.require_control_plane();
  if p_organisation_id is null then
    raise exception 'p_organisation_id is required' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or char_length(p_reason) > 500 then
    raise exception 'p_reason is required (1-500 characters)' using errcode = '22023';
  end if;
  if p_requested_by is null or btrim(p_requested_by) = '' or char_length(p_requested_by) > 200 then
    raise exception 'p_requested_by is required (1-200 characters)' using errcode = '22023';
  end if;

  select o.status into v_status from public.organisations o where o.id = p_organisation_id;
  if v_status is null then
    -- A missing tenant is a fact about the argument, and it gets a code that says so rather than an
    -- empty success a script would read as "stopped".
    raise exception 'no such organisation' using errcode = '23503';
  end if;

  if v_status = 'suspended' then
    -- Idempotent, and it records nothing: a retried script must not invent history rows.
    return p_organisation_id;
  end if;
  if v_status not in ('active', 'provisioning') then
    raise exception 'a tenant in status archived or deleting is neither re-suspended nor resumed here'
      using errcode = '22023';
  end if;

  update public.organisations set status = 'suspended' where id = p_organisation_id;

  insert into public.lifecycle_switch_flips
      (scope_kind, organisation_id, scope_key, state, reason, actor_role, requested_by)
    values
      ('tenant', p_organisation_id, null, 'off', p_reason, session_user::text, p_requested_by);

  return p_organisation_id;
end;
$$;
comment on function public.suspend_tenant_v1(uuid, text, text) is
  'F28/§972 tenant kill: organisations.status to suspended, which is_active_member and resolve_tenant_host read at once. The #98 policy_revision writer is T-202 (#179), not this function.';

create or replace function public.resume_tenant_v1(
  p_organisation_id uuid,
  p_reason text,
  p_requested_by text
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  perform public.require_control_plane();
  if p_organisation_id is null then
    raise exception 'p_organisation_id is required' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or char_length(p_reason) > 500 then
    raise exception 'p_reason is required (1-500 characters)' using errcode = '22023';
  end if;
  if p_requested_by is null or btrim(p_requested_by) = '' or char_length(p_requested_by) > 200 then
    raise exception 'p_requested_by is required (1-200 characters)' using errcode = '22023';
  end if;

  select o.status into v_status from public.organisations o where o.id = p_organisation_id;
  if v_status is null then
    raise exception 'no such organisation' using errcode = '23503';
  end if;
  if v_status = 'active' then
    return p_organisation_id;
  end if;
  if v_status <> 'suspended' then
    raise exception 'only a suspended tenant is resumed here: activation from provisioning is a separate, human decision'
      using errcode = '22023';
  end if;

  update public.organisations set status = 'active' where id = p_organisation_id;

  insert into public.lifecycle_switch_flips
      (scope_kind, organisation_id, scope_key, state, reason, actor_role, requested_by)
    values
      ('tenant', p_organisation_id, null, 'on', p_reason, session_user::text, p_requested_by);

  return p_organisation_id;
end;
$$;
comment on function public.resume_tenant_v1(uuid, text, text) is
  'The reversible half of the tenant kill switch. Activation out of provisioning is deliberately not this function: that is a human decision with a contract behind it, not an un-suspend.';

-- ---------------------------------------------------------------- provisioning (F05)
-- Reserved slugs live here, in a replaceable function body, and not in a CHECK on organisations.slug.
-- Changing a CHECK would take a drop-and-re-add by a later migration; a body is replaced. Each name is
-- refused for a reason that already exists in the merged schema or the plan:
--   admin, platform, staging — the three non-tenant tenant_domains.kind values (tenancy_core:46);
--   www — the apex alias plan §214 tells operators to configure explicitly, so it is never a tenant;
--   terraoi — the zone label itself.
create or replace function public.provision_tenant_v1(
  p_slug text,
  p_host text,
  p_display_name text,
  p_locale text,
  p_timezone text,
  p_reason text,
  p_requested_by text
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_host_owner uuid;
begin
  perform public.require_control_plane();

  -- Validation mirrors the merged CHECKs so the caller gets a named-argument error instead of a
  -- database error, and never a workaround. tenancy_core.sql:21-26, :41-44.
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
    raise exception 'p_slug must match the organisations.slug CHECK (lowercase, 2-63 characters)'
      using errcode = '22023';
  end if;
  if p_slug in ('admin', 'platform', 'staging', 'www', 'terraoi') then
    raise exception 'p_slug is reserved (tenant_domains.kind classes, the plan §214 apex alias, or the zone label)'
      using errcode = '22023';
  end if;
  if p_host is null
     or p_host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9]))+$'
     or (length(p_host) - length(replace(p_host, '.', ''))) > 2 then
    raise exception 'p_host must be an exact normalized host with at most one subdomain level (tenancy_core:41-44)'
      using errcode = '22023';
  end if;
  if p_display_name is null or p_display_name !~ '^\S(.*\S)?$' or char_length(p_display_name) > 200 then
    raise exception 'p_display_name must match the organisations.display_name CHECK' using errcode = '22023';
  end if;
  -- #67: this rejects en-GB today, because the merged CHECK does. Refusing is the honest half; the
  -- fix belongs to whoever widens that CHECK, and suite 65 fails the day someone does.
  if p_locale is null or p_locale !~ '^[a-z]{2}(-[A-Z][a-z]{2})?$' then
    raise exception 'p_locale must match the merged organisations.locale CHECK (#67: en-GB does not match it)'
      using errcode = '22023';
  end if;
  if p_timezone is null or p_timezone !~ '^[A-Za-z]{1,32}(/[A-Za-z0-9_+.-]{1,32})?$' then
    raise exception 'p_timezone must match the merged timezone CHECK (#67: it allows exactly one slash)'
      using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or char_length(p_reason) > 500 then
    raise exception 'p_reason is required (1-500 characters)' using errcode = '22023';
  end if;
  if p_requested_by is null or btrim(p_requested_by) = '' or char_length(p_requested_by) > 200 then
    raise exception 'p_requested_by is required (1-200 characters)' using errcode = '22023';
  end if;

  -- Read the two existing facts first, so a refusal has no side effect at all.
  select d.organisation_id into v_host_owner from public.tenant_domains d where d.host = p_host;
  select o.id into v_org from public.organisations o where o.slug = p_slug;
  if v_host_owner is not null and (v_org is null or v_host_owner <> v_org) then
    raise exception 'that host already belongs to another organisation' using errcode = '23505';
  end if;

  -- Create-or-ensure: the re-run is what makes a half-finished provisioning script safe to retry
  -- (§11 F05 "resumable"). Identity fields are never rewritten — renaming a tenant is a different
  -- packet's decision, and a retried script silently changing a name is how an incident starts.
  insert into public.organisations (id, slug, display_name, status, locale, timezone)
  values (gen_random_uuid(), p_slug, p_display_name, 'provisioning', p_locale, p_timezone)
  on conflict (slug) do nothing;

  select o.id into v_org from public.organisations o where o.slug = p_slug;

  insert into public.tenant_domains (organisation_id, host, kind, status)
  values (v_org, p_host, 'tenant', 'active')
  on conflict (host) do nothing;

  -- The two roles and six permission areas the merged supabase/seed.sql already uses, so a
  -- provisioned tenant is not a third shape of tenant. Entitlements (F05 names them) have no table and
  -- no owner, so none are seeded — suite 73 pins that, and #62 says the same for brand defaults.
  insert into public.organisation_roles (organisation_id, key, name)
  values (v_org, 'member', 'Member'), (v_org, 'admin', 'Tenant admin')
  on conflict (organisation_id, key) do nothing;

  insert into public.role_permissions (organisation_id, role_id, area, level)
  select v_org, r.id, p.area, p.level
    from public.organisation_roles r
    join (values
      ('member', 'chat.ask', 'read'),
      ('member', 'knowledge.read', 'read'),
      ('member', 'projects.read', 'read'),
      ('admin', 'knowledge.admin', 'admin'),
      ('admin', 'members.admin', 'admin'),
      ('admin', 'projects.admin', 'admin')
    ) as p(role_key, area, level) on p.role_key = r.key
   where r.organisation_id = v_org
  on conflict (role_id, area) do nothing;

  -- F05's load-bearing absence: no membership row, for anyone. Holding the credential that ran this
  -- function grants no tenant data access at all (§3.2, §6.1, §11).
  return v_org;
end;
$$;
comment on function public.provision_tenant_v1(text, text, text, text, text, text, text) is
  'F05: provision or resume a tenant by script (plan §15.0, not an admin UI). Creates the org in provisioning status, the exact host, and the merged seed role vocabulary; seeds no membership, entitlement or brand row. Control-plane only.';

-- ---------------------------------------------------------------- privileges (FAQ-0010)
-- Every signature revoked from PUBLIC and from all four request roles, then granted to the group the
-- control plane logs in through. `require_control_plane` is revoked too and granted to nobody: it is
-- dialled from inside the definer bodies, which run as the owner. Because none of the six is granted
-- to `anon` or `authenticated`, 001_function_privileges.test.sql's rule-31/32 allow-list gains
-- nothing from this migration — the suite that would have to change is the one that grants a switch
-- read to a request role, which is the next slice and a §2 ask.
revoke execute on function
  public.require_control_plane(),
  public.set_lifecycle_switch_v1(text, uuid, text, text, text, text),
  public.lifecycle_switch_state_v1(text, uuid, text),
  public.lifecycle_switch_history_v1(text, uuid, text, integer),
  public.suspend_tenant_v1(uuid, text, text),
  public.resume_tenant_v1(uuid, text, text),
  public.provision_tenant_v1(text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function
  public.set_lifecycle_switch_v1(text, uuid, text, text, text, text),
  public.lifecycle_switch_state_v1(text, uuid, text),
  public.lifecycle_switch_history_v1(text, uuid, text, integer),
  public.suspend_tenant_v1(uuid, text, text),
  public.resume_tenant_v1(uuid, text, text),
  public.provision_tenant_v1(text, text, text, text, text, text, text)
  to toi_control_plane;
