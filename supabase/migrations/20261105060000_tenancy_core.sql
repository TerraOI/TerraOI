-- T-003 Migration 0001: tenancy core with RLS and the transaction-scoped tenant pattern.
-- Plan §4.1–§4.3, §6.1 (tenant lifecycle, identity/access), §6.2; F01–F03.
--
-- Invariants encoded here (AGENTS.md §4.1–§4.2, plan §6.2):
--   * every tenant-owned row carries a non-null organisation_id;
--   * unique (id, organisation_id) keys let a child reference its parent by
--     (parent_id, organisation_id), so a row from another tenant cannot be referenced at all;
--   * RLS is enabled AND forced on every table; membership is required by the policy itself,
--     not only by the scope setter;
--   * the tenant scope is transaction-local: set_config(..., true), never a session SET,
--     never a pooled connection setting, never a process-global variable;
--   * ordinary tenant reads fail closed when no scope is set;
--   * host resolution is a narrow SECURITY DEFINER RPC: the tenant list is not readable
--     through the API before sign-in.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tenant lifecycle
create table public.organisations (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text not null check (display_name ~ '^\S(.*\S)?$' and char_length(display_name) <= 200),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'suspended', 'archived', 'deleting')),
  locale text not null default 'en' check (locale ~ '^[a-z]{2}(-[A-Z][a-z]{2})?$'),
  timezone text not null default 'UTC' check (timezone ~ '^[A-Za-z]{1,32}(/[A-Za-z0-9_+.-]{1,32})?$'),
  -- Bumped on any tenancy, membership, role or data-policy change so a run can be re-checked
  -- against the revision it was authorized under (plan §9.4).
  policy_revision bigint not null default 1 check (policy_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.organisations is
  'Tenant root. Status and policy_revision are authoritative for every access decision.';

create table public.tenant_domains (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  -- Normalized exactly as TenantContext/NormalizedHost does: lowercase, bare hostname,
  -- at most one subdomain level below the zone, no scheme, no port, no path (plan §4.1).
  host text not null unique check (
    host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9]))+$'
    and (length(host) - length(replace(host, '.', ''))) <= 2
  ),
  kind text not null default 'tenant'
    check (kind in ('tenant', 'platform', 'admin', 'staging')),
  status text not null default 'active' check (status in ('active', 'reserved', 'suspended')),
  is_canonical boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, organisation_id),
  unique (organisation_id, host)
);
comment on table public.tenant_domains is
  'Exact-host tenant registry (F01). No suffix matching, no wildcard tenancy.';

-- ---------------------------------------------------------------- identity and access
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text check (email is null or (email = lower(btrim(email)) and position(' ' in email) = 0)),
  display_name text check (display_name is null or char_length(display_name) between 1 and 120),
  -- Platform staff get no tenant data access by holding this flag (plan §3.2, §6.1).
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);
comment on table public.profiles is
  'Global identity record. Membership, not identity, grants tenant access (TOI-ADR-15).';

create table public.organisation_memberships (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'invited'
    check (status in ('invited', 'active', 'suspended', 'removed')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organisation_id, user_id),
  unique (id, organisation_id),
  foreign key (organisation_id) references public.organisations (id) on delete cascade
);

create table public.organisation_roles (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  key text not null check (key ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (organisation_id, key),
  unique (id, organisation_id),
  foreign key (organisation_id) references public.organisations (id) on delete cascade
);

create table public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  role_id uuid not null,
  -- Permission areas from plan §5.2/§6.1, e.g. 'knowledge.read', 'projects.admin'.
  area text not null check (area ~ '^[a-z0-9_]+(\.[a-z0-9_]+){1,3}$'),
  level text not null check (level in ('none', 'read', 'write', 'admin')),
  created_at timestamptz not null default now(),
  unique (role_id, area),
  unique (id, organisation_id),
  foreign key (role_id, organisation_id) references public.organisation_roles (id, organisation_id)
    on delete cascade
);

create table public.membership_roles (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  membership_id uuid not null,
  role_id uuid not null,
  created_at timestamptz not null default now(),
  unique (membership_id, role_id),
  unique (id, organisation_id),
  foreign key (membership_id, organisation_id)
    references public.organisation_memberships (id, organisation_id) on delete cascade,
  foreign key (role_id, organisation_id)
    references public.organisation_roles (id, organisation_id) on delete cascade
);

-- ---------------------------------------------------------------- projects (information scope)
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  key text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null check (char_length(name) between 1 and 200),
  -- 'project' narrows the audience to project members; 'organisation' is tenant-wide.
  visibility text not null default 'project' check (visibility in ('organisation', 'project')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (organisation_id, key),
  unique (id, organisation_id),
  foreign key (organisation_id) references public.organisations (id) on delete cascade
);
comment on table public.projects is
  'A narrower information boundary inside a tenant (plan §1.1). client_confidential collections must be project-scoped in M1 (§6.2).';

create table public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  project_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, user_id),
  unique (id, organisation_id),
  -- Composite FK: a project membership can never point at another tenant's project.
  foreign key (project_id, organisation_id) references public.projects (id, organisation_id)
    on delete cascade
);

-- ---------------------------------------------------------------- shared helpers
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger organisations_touch_updated before update on public.organisations
  for each row execute function public.touch_updated_at();
create trigger projects_touch_updated before update on public.projects
  for each row execute function public.touch_updated_at();

/** The organization this transaction is scoped to, or null when nothing is set (fail closed). */
create or replace function public.current_organisation_id()
returns uuid language sql stable set search_path = public, pg_temp as $$
  select nullif(current_setting('app.organisation_id', true), '')::uuid;
$$;

/**
 * Membership test used inside RLS policies. SECURITY DEFINER so a policy on one tenant table
 * never recurses through the policy on another, and pinned search_path satisfies the
 * guardrail (supabase/tests/database/000_guardrails.test.sql).
 */
create or replace function public.is_active_member(p_organisation_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.organisation_memberships m
      join public.organisations o on o.id = m.organisation_id
     where m.organisation_id = p_organisation_id
       and m.user_id = auth.uid()
       and m.status = 'active'
       and o.status = 'active'
  );
$$;

create or replace function public.is_project_member(p_project_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.project_memberships pm
     where pm.project_id = p_project_id and pm.user_id = auth.uid()
  );
$$;

/**
 * F03: establish the transaction-local tenant scope. Security invoker on purpose — the caller's
 * identity (auth.uid()) must be the one that holds membership, and membership is verified
 * before any scope is set. `is_local => true` is the whole point: the value cannot outlive this
 * transaction, so it can never leak through a pooled connection into the next request (§4.3).
 */
create or replace function public.set_tenant_scope(p_organisation_id uuid)
returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if p_organisation_id is null then
    raise exception 'organization id is required' using errcode = '22023';
  end if;
  if not public.is_active_member(p_organisation_id) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  perform set_config('app.organisation_id', p_organisation_id::text, true);
  return p_organisation_id;
end;
$$;

create or replace function public.clear_tenant_scope()
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform set_config('app.organisation_id', '', true);
end;
$$;

/**
 * F01: resolve an exact, active host to its tenant before anyone is signed in. Returns no row
 * for unknown, reserved or inactive hosts, so the caller can render a generic failure with no
 * tenant detail (plan §4.1 step 3).
 */
create or replace function public.resolve_tenant_host(p_host text)
returns table (organisation_id uuid, host text, organisation_status text, is_canonical boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_host is null or p_host <> lower(btrim(p_host)) or p_host ~ '[[:space:]:/]' then
    raise exception 'host must be a normalized bare hostname' using errcode = '22023';
  end if;
  return query
    select d.organisation_id, d.host, o.status, d.is_canonical
      from public.tenant_domains d
      join public.organisations o on o.id = d.organisation_id
     where d.host = p_host
       and d.status = 'active'
       and o.status in ('provisioning', 'active');
end;
$$;

-- ---------------------------------------------------------------- RLS
-- Enabled, not FORCEd: the SECURITY DEFINER helpers below and the scoped-RPC pattern in plan
-- §4.3 are owned by the migration role and must be able to read these tables without a policy,
-- while every request role (anon, authenticated) is filtered. If a later packet moves writes
-- into definer RPCs, keep that split explicit rather than weakening a policy to fit (§6).
alter table public.organisations enable row level security;
alter table public.tenant_domains enable row level security;
alter table public.profiles enable row level security;
alter table public.organisation_memberships enable row level security;
alter table public.organisation_roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.membership_roles enable row level security;
alter table public.projects enable row level security;
alter table public.project_memberships enable row level security;


create policy organisations_member_read on public.organisations
  for select to authenticated
  using (public.is_active_member(id));

create policy tenant_domains_member_read on public.tenant_domains
  for select to authenticated
  using (public.is_active_member(organisation_id));

-- A member reads their own identity record; co-worker profiles come with the chat/admin
-- packets that need them, under an explicit policy.
create policy profiles_read_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy memberships_read_own on public.organisation_memberships
  for select to authenticated
  using (user_id = auth.uid());

create policy organisation_roles_member_read on public.organisation_roles
  for select to authenticated
  using (public.is_active_member(organisation_id));

create policy role_permissions_member_read on public.role_permissions
  for select to authenticated
  using (public.is_active_member(organisation_id));

create policy membership_roles_member_read on public.membership_roles
  for select to authenticated
  using (public.is_active_member(organisation_id));

-- Tenant operations without a scope read nothing (plan §4.3).
create policy projects_scoped_read on public.projects
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and (visibility = 'organisation' or public.is_project_member(id))
  );

create policy project_memberships_scoped_read on public.project_memberships
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and (user_id = auth.uid() or public.is_project_member(project_id))
  );

-- ---------------------------------------------------------------- grants
-- Reads only. Writes to tenancy tables happen through reviewed privileged paths and scoped
-- RPCs, never as a direct member write (plan §4.3, §13).
revoke all on all tables in schema public from anon, authenticated;
grant select on
  public.organisations, public.tenant_domains, public.profiles,
  public.organisation_memberships, public.organisation_roles, public.role_permissions,
  public.membership_roles, public.projects, public.project_memberships
  to authenticated;

grant execute on function
  public.current_organisation_id(),
  public.set_tenant_scope(uuid),
  public.clear_tenant_scope(),
  public.is_active_member(uuid),
  public.is_project_member(uuid)
  to authenticated;
grant execute on function public.resolve_tenant_host(text) to anon, authenticated;
