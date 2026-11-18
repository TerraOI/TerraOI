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
-- first**. There is no Docker on the authoring machine, so every assertion in that file executes only
-- in CI's `database` job (FAQ-0009); nothing here is claimed as run locally.
--
-- Schema placement (FAQ-0010 / #75 toi_identity pattern, Round 1 B1). Tables and functions live in
-- `toi_control`, which is **not** in `supabase/config.toml` `[api] schemas`. Request roles never see
-- it through the Data API. `toi_control_plane` gets USAGE on `toi_control` only — never a grant of
-- USAGE on `public` for this credential — and EXECUTE on the six lifecycle / provisioning functions
-- by full signature. No table privilege anywhere.
--
-- Storable kinds (ruling #74 / #199 §4, Round 1 B3). M1 stores only `expert` and `provider` on
-- `lifecycle_switches`. Stopping a **tenant** is `organisations.status` via suspend/resume; the flip
-- history still records `tenant` for those calls. Platform and service are not settings in M1
-- (platform is a runbook rollback; service waits). A **connector** scope is not added: no connector
-- registry exists on main.
--
-- Who may call any of this. PostgreSQL hands EXECUTE on a new function to PUBLIC, and a migration
-- cannot close that default (#60, FAQ-0010), so every function below is revoked by full signature.
-- The six control-plane functions are granted only to `toi_control_plane`. The #199 provider read
-- (`provider_switch_state_v1`) is granted to `toi_gateway_config` only when that role already exists;
-- otherwise the function is created and the grant moves to T-116 (see the grant block).
--
-- FAQ-0011 is deliberately not applied: `set_tenant_scope` cannot authorize provisioning a tenant that
-- does not exist yet. The gate is the EXECUTE grant plus `pg_has_role(session_user, …)`.
--
-- What is NOT here, each named rather than left quiet:
--   * #98's `policy_revision` bump on suspend — T-202 / #179. Suite pins the revision unchanged
--     (merge-order coupling: that assertion turns red when #179's writer merges).
--   * Provider registry FK — #45 answered (T-116 owns it, #143). Until #143 merges there is no FK.
--   * `tenant_experts` (T-311) and any `src/platform/gateway/` change.
--   * Entitlements and brand defaults (#62).
--   * A fix for #67 (`en-GB` / timezone slash ceiling).

-- ---------------------------------------------------------------- control-plane group (#75 pattern)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'toi_control_plane') then
    create role toi_control_plane nologin;
  end if;
end
$$;

comment on role toi_control_plane is
  'NOLOGIN group for the platform control plane (T-304). USAGE on toi_control and EXECUTE on the six lifecycle / provisioning functions only; no table privilege anywhere. The login user that is IN ROLE it, its password and its binding are §20.8 human steps, not this migration.';

-- ---------------------------------------------------------------- schema (non-exposed; FAQ-0010 / #75)
create schema if not exists toi_control;
comment on schema toi_control is
  'Platform control-plane settings (T-304 lifecycle switches and provisioning). Never exposed to the Data API; reached only by toi_control_plane (and, for the provider read, toi_gateway_config once T-116 creates it).';

revoke all on schema toi_control from public, anon, authenticated, service_role;
grant usage on schema toi_control to toi_control_plane;
-- #75 pattern: do not grant this credential anything on `public`. A direct revoke clears any
-- accidental grant; PUBLIC's default USAGE (if present) is a separate Supabase default and is not
-- a grant this migration makes.
revoke all on schema public from toi_control_plane;

-- ---------------------------------------------------------------- the switch settings
-- Current state, one row per expert/provider scope. `lifecycle_switch_flips` below is the append-only
-- record. organisation_id is not on this table (Round 1 N5): tenant stop is organisations.status.
create table toi_control.lifecycle_switches (
  id uuid primary key default gen_random_uuid(),
  scope_kind text not null
    check (scope_kind in ('expert', 'provider')),
  scope_key text not null check (scope_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  state text not null check (state in ('on', 'off')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  actor_role text not null check (char_length(actor_role) between 1 and 63),
  requested_by text not null check (char_length(btrim(requested_by)) between 1 and 200),
  flipped_at timestamptz not null default now()
);
comment on table toi_control.lifecycle_switches is
  'F05/§972 kill switches as explicit settings for M1: expert and provider only (#74 / #199 §4). A missing row means not switched off, never off. Tenants are stopped by organisations.status (suspend_tenant_v1).';
comment on column toi_control.lifecycle_switches.actor_role is
  'session_user as Postgres recorded it at flip time. The login, not a human: no parameter supplies it.';
comment on column toi_control.lifecycle_switches.requested_by is
  'The human the operator named. Recorded for the incident note; the database cannot verify it.';

create unique index lifecycle_switch_scope_udx on toi_control.lifecycle_switches (
  scope_kind,
  scope_key
);

create table toi_control.lifecycle_switch_flips (
  id bigint generated always as identity primary key,
  scope_kind text not null
    check (scope_kind in ('tenant', 'expert', 'provider')),
  organisation_id uuid references public.organisations (id) on delete cascade,
  scope_key text,
  state text not null check (state in ('on', 'off')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  actor_role text not null check (char_length(actor_role) between 1 and 63),
  requested_by text not null check (char_length(btrim(requested_by)) between 1 and 200),
  flipped_at timestamptz not null default now(),
  check (
    (scope_kind = 'tenant' and organisation_id is not null and scope_key is null)
    or
    (scope_kind in ('expert', 'provider') and organisation_id is null and scope_key is not null)
  )
);
comment on table toi_control.lifecycle_switch_flips is
  'Append-only flip history (§972 actor and reason per flip). Tenant rows come from suspend/resume; expert and provider rows from set_lifecycle_switch_v1. The control-plane role holds no update or delete privilege.';
comment on column toi_control.lifecycle_switch_flips.state is
  'For a tenant row, the effective state of organisations.status at that moment: suspended is off, active is on.';

create index lifecycle_switch_flips_scope_idx on toi_control.lifecycle_switch_flips (
  scope_kind, organisation_id, scope_key, flipped_at desc, id desc
);

alter table toi_control.lifecycle_switches enable row level security;
alter table toi_control.lifecycle_switch_flips enable row level security;

revoke all on table toi_control.lifecycle_switches, toi_control.lifecycle_switch_flips
  from public, anon, authenticated, service_role, toi_control_plane;

-- ---------------------------------------------------------------- the gate, written once
create or replace function toi_control.require_control_plane()
returns void language plpgsql volatile security definer set search_path = toi_control, pg_temp as $$
begin
  if not pg_has_role(session_user, 'toi_control_plane', 'MEMBER') then
    raise exception 'caller is not a control-plane login' using errcode = '42501';
  end if;
end;
$$;
comment on function toi_control.require_control_plane() is
  'The in-body control-plane gate: session_user, because the calling bodies are SECURITY DEFINER. The enforced boundary is the EXECUTE grant; this is the second net.';

-- ---------------------------------------------------------------- switch write
create or replace function toi_control.set_lifecycle_switch_v1(
  p_scope_kind text,
  p_organisation_id uuid,
  p_scope_key text,
  p_state text,
  p_reason text,
  p_requested_by text
) returns void
language plpgsql volatile security definer set search_path = toi_control, pg_temp as $$
declare
  v_current text;
begin
  perform toi_control.require_control_plane();

  if p_scope_kind is null
     or p_scope_kind not in ('expert', 'provider') then
    raise exception 'p_scope_kind must be expert or provider; a tenant is stopped with suspend_tenant_v1, not with a switch row'
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

  if p_organisation_id is not null then
    raise exception 'an expert or provider switch names no tenant; per-tenant provider control belongs to tenant_provider_policy (T-214)'
      using errcode = '22023';
  end if;
  if p_scope_key is null or p_scope_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'p_scope_key must match the ProviderKey shape in src/contracts/keys.ts'
      using errcode = '22023';
  end if;

  -- N3: same-state retry is a no-op, matching suspend_tenant_v1 — a retried script must not invent history.
  select s.state into v_current
    from toi_control.lifecycle_switches s
   where s.scope_kind = p_scope_kind
     and s.scope_key = p_scope_key;
  if v_current is not null and v_current = p_state then
    return;
  end if;

  insert into toi_control.lifecycle_switch_flips
      (scope_kind, organisation_id, scope_key, state, reason, actor_role, requested_by)
    values
      (p_scope_kind, null, p_scope_key, p_state, p_reason, session_user::text, p_requested_by);

  insert into toi_control.lifecycle_switches
      (scope_kind, scope_key, state, reason, actor_role, requested_by)
    values
      (p_scope_kind, p_scope_key, p_state, p_reason, session_user::text, p_requested_by)
    on conflict (scope_kind, scope_key)
    do update set state = excluded.state,
                  reason = excluded.reason,
                  actor_role = excluded.actor_role,
                  requested_by = excluded.requested_by,
                  flipped_at = now();
end;
$$;
comment on function toi_control.set_lifecycle_switch_v1(text, uuid, text, text, text, text) is
  'F05/§972: flip an expert or provider switch, with a reason. Tenant is refused here on purpose (use suspend_tenant_v1). Same-state retries write nothing. Control-plane only.';

-- ---------------------------------------------------------------- switch read
create or replace function toi_control.lifecycle_switch_state_v1(
  p_scope_kind text,
  p_organisation_id uuid,
  p_scope_key text
) returns text
language plpgsql stable security definer set search_path = toi_control, pg_temp as $$
declare
  v_state text;
begin
  if p_scope_kind is null
     or p_scope_kind not in ('tenant', 'expert', 'provider') then
    raise exception 'p_scope_kind must be tenant, expert or provider'
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

  if p_organisation_id is not null then
    raise exception 'an expert or provider switch read names no tenant' using errcode = '22023';
  end if;
  if p_scope_key is null or p_scope_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'p_scope_key must match the ProviderKey shape in src/contracts/keys.ts'
      using errcode = '22023';
  end if;

  select s.state into v_state
    from toi_control.lifecycle_switches s
   where s.scope_kind = p_scope_kind
     and s.scope_key = p_scope_key;
  return coalesce(v_state, 'on');
end;
$$;
comment on function toi_control.lifecycle_switch_state_v1(text, uuid, text) is
  '§17.1 read for tenant (from organisations.status) and for expert/provider (from lifecycle_switches). A scope nobody has flipped reads on.';

-- ---------------------------------------------------------------- #199 provider read for the gateway
-- Granted to toi_gateway_config only when that role already exists; otherwise T-116 owns the grant.
create or replace function toi_control.provider_switch_state_v1(p_provider_key text)
returns text
language plpgsql stable security definer set search_path = toi_control, pg_temp as $$
declare
  v_state text;
begin
  if p_provider_key is null or p_provider_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'p_provider_key must match the ProviderKey shape in src/contracts/keys.ts'
      using errcode = '22023';
  end if;

  select s.state into v_state
    from toi_control.lifecycle_switches s
   where s.scope_kind = 'provider'
     and s.scope_key = p_provider_key;
  -- Missing row = on (#199). No FK until #143 merges.
  return coalesce(v_state, 'on');
end;
$$;
comment on function toi_control.provider_switch_state_v1(text) is
  'Server-path provider switch read for the gateway (#199 option A). Missing row means on. No FK until #143. EXECUTE goes to toi_gateway_config when that role exists; otherwise the grant moves to T-116.';

-- ---------------------------------------------------------------- flip history read
create or replace function toi_control.lifecycle_switch_history_v1(
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
language plpgsql stable security definer set search_path = toi_control, pg_temp as $$
begin
  if p_scope_kind is null
     or p_scope_kind not in ('tenant', 'expert', 'provider') then
    raise exception 'p_scope_kind must be tenant, expert or provider'
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
      from toi_control.lifecycle_switch_flips f
     where f.scope_kind = p_scope_kind
       and (p_scope_kind <> 'tenant' or f.organisation_id = p_organisation_id)
       and coalesce(f.scope_key, '') = coalesce(p_scope_key, '')
     order by f.flipped_at desc, f.id desc
     limit p_limit;
end;
$$;
comment on function toi_control.lifecycle_switch_history_v1(text, uuid, text, integer) is
  'The flips, newest first, with actor and reason: what makes "actor and reason per flip" an actual capability rather than a column.';

-- ---------------------------------------------------------------- tenant suspend and resume
create or replace function toi_control.suspend_tenant_v1(
  p_organisation_id uuid,
  p_reason text,
  p_requested_by text
) returns uuid
language plpgsql volatile security definer set search_path = toi_control, pg_temp as $$
declare
  v_status text;
begin
  perform toi_control.require_control_plane();
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

  if v_status = 'suspended' then
    return p_organisation_id;
  end if;
  if v_status not in ('active', 'provisioning') then
    raise exception 'a tenant in status archived or deleting is neither re-suspended nor resumed here'
      using errcode = '22023';
  end if;

  update public.organisations set status = 'suspended' where id = p_organisation_id;

  insert into toi_control.lifecycle_switch_flips
      (scope_kind, organisation_id, scope_key, state, reason, actor_role, requested_by)
    values
      ('tenant', p_organisation_id, null, 'off', p_reason, session_user::text, p_requested_by);

  return p_organisation_id;
end;
$$;
comment on function toi_control.suspend_tenant_v1(uuid, text, text) is
  'F28/§972 tenant kill: organisations.status to suspended, which is_active_member and resolve_tenant_host read at once. The #98 policy_revision writer is T-202 (#179), not this function.';

create or replace function toi_control.resume_tenant_v1(
  p_organisation_id uuid,
  p_reason text,
  p_requested_by text
) returns uuid
language plpgsql volatile security definer set search_path = toi_control, pg_temp as $$
declare
  v_status text;
begin
  perform toi_control.require_control_plane();
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

  insert into toi_control.lifecycle_switch_flips
      (scope_kind, organisation_id, scope_key, state, reason, actor_role, requested_by)
    values
      ('tenant', p_organisation_id, null, 'on', p_reason, session_user::text, p_requested_by);

  return p_organisation_id;
end;
$$;
comment on function toi_control.resume_tenant_v1(uuid, text, text) is
  'The reversible half of the tenant kill switch. Activation out of provisioning is deliberately not this function.';

-- ---------------------------------------------------------------- provisioning (F05)
-- Returns the read-back the operator script needs (Round 1 B2), so toi_control_plane never SELECTs
-- public tenancy tables. One host per call; reserved slugs live in the body.
create or replace function toi_control.provision_tenant_v1(
  p_slug text,
  p_host text,
  p_display_name text,
  p_locale text,
  p_timezone text,
  p_reason text,
  p_requested_by text
) returns table (
  organisation_id uuid,
  status text,
  host text,
  roles bigint,
  permissions bigint,
  members bigint
)
language plpgsql volatile security definer set search_path = toi_control, pg_temp as $$
declare
  v_org uuid;
  v_host_owner uuid;
begin
  perform toi_control.require_control_plane();

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

  select d.organisation_id into v_host_owner from public.tenant_domains d where d.host = p_host;
  select o.id into v_org from public.organisations o where o.slug = p_slug;
  if v_host_owner is not null and (v_org is null or v_host_owner <> v_org) then
    raise exception 'that host already belongs to another organisation' using errcode = '23505';
  end if;

  insert into public.organisations (id, slug, display_name, status, locale, timezone)
  values (gen_random_uuid(), p_slug, p_display_name, 'provisioning', p_locale, p_timezone)
  on conflict (slug) do nothing;

  select o.id into v_org from public.organisations o where o.slug = p_slug;

  insert into public.tenant_domains (organisation_id, host, kind, status)
  values (v_org, p_host, 'tenant', 'active')
  on conflict (host) do nothing;

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

  return query
    select o.id,
           o.status,
           (select d.host from public.tenant_domains d
             where d.organisation_id = o.id and d.host = p_host),
           (select count(*) from public.organisation_roles r where r.organisation_id = o.id),
           (select count(*) from public.role_permissions rp where rp.organisation_id = o.id),
           (select count(*) from public.organisation_memberships m where m.organisation_id = o.id)
      from public.organisations o
     where o.id = v_org;
end;
$$;
comment on function toi_control.provision_tenant_v1(text, text, text, text, text, text, text) is
  'F05: provision or resume a tenant by script (plan §15.0). Returns the read-back the operator script asserts, so toi_control_plane never SELECTs tenancy tables. Seeds no membership, entitlement or brand row.';

-- ---------------------------------------------------------------- privileges (FAQ-0010)
revoke execute on function
  toi_control.require_control_plane(),
  toi_control.set_lifecycle_switch_v1(text, uuid, text, text, text, text),
  toi_control.lifecycle_switch_state_v1(text, uuid, text),
  toi_control.lifecycle_switch_history_v1(text, uuid, text, integer),
  toi_control.provider_switch_state_v1(text),
  toi_control.suspend_tenant_v1(uuid, text, text),
  toi_control.resume_tenant_v1(uuid, text, text),
  toi_control.provision_tenant_v1(text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function
  toi_control.set_lifecycle_switch_v1(text, uuid, text, text, text, text),
  toi_control.lifecycle_switch_state_v1(text, uuid, text),
  toi_control.lifecycle_switch_history_v1(text, uuid, text, integer),
  toi_control.suspend_tenant_v1(uuid, text, text),
  toi_control.resume_tenant_v1(uuid, text, text),
  toi_control.provision_tenant_v1(text, text, text, text, text, text, text)
  to toi_control_plane;

-- #199: grant the provider read to toi_gateway_config only when T-116 has already created the role.
-- If the role is absent, the function exists and the grant moves to T-116's migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'toi_gateway_config') then
    execute 'grant execute on function toi_control.provider_switch_state_v1(text) to toi_gateway_config';
    execute 'grant usage on schema toi_control to toi_gateway_config';
  end if;
end
$$;
