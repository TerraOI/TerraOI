-- T-202 PR-1b: tenant_invitations + invite_member_v1 (#179 ruling, 2026-11-18).
--
-- An invitation is a row keyed by (organisation_id, normalized email), not a membership row:
-- organisation_memberships.user_id needs an existing profile. This RPC writes only
-- tenant_invitations, never profiles or auth.users, and returns the same answer for every
-- well-formed address (#13(2)). Claim / active membership is T-201 redeem_invitation_v1.
-- bump_policy_revision (#98) also watches this table (three statement triggers).
--
-- Timestamp after the newest open-claim migration known at claim time (20261121180000 on #223).
-- Do not edit the merged PR-1 migration 20261120215000_tenant_admin_rpc.sql (AGENTS.md §6).

-- ---------------------------------------------------------------- table
create table public.tenant_invitations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  email text not null
    check (email = lower(btrim(email)) and position(' ' in email) = 0 and char_length(email) between 3 and 254),
  role_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid not null references public.profiles (id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, organisation_id),
  foreign key (role_id, organisation_id)
    references public.organisation_roles (id, organisation_id)
);

comment on table public.tenant_invitations is
  'Pending tenant invitations keyed by normalized email (#179). organisation_memberships.status = ''invited'' remains in the merged CHECK but no new code writes it; claim is T-201 redeem_invitation_v1. Writes only through invite_member_v1 (FAQ-0004).';

-- One pending invite per (tenant, email). Accepted/revoked/expired rows do not block a later pending invite.
create unique index tenant_invitations_one_pending_per_email
  on public.tenant_invitations (organisation_id, email)
  where status = 'pending';

alter table public.tenant_invitations enable row level security;

-- Admins of the scoped tenant may read invitations; nobody else (FAQ-0004: no request-role write).
create policy tenant_invitations_admin_read on public.tenant_invitations
  for select to authenticated
  using (
    public.is_active_member(tenant_invitations.organisation_id)
    and tenant_invitations.organisation_id = public.current_organisation_id()
    and exists (
      select 1
        from public.organisation_memberships m
        join public.membership_roles mr on mr.membership_id = m.id
        join public.role_permissions rp
          on rp.role_id = mr.role_id
         and rp.organisation_id = m.organisation_id
         and rp.area = 'members.admin'
         and rp.level = 'admin'
       where m.organisation_id = tenant_invitations.organisation_id
         and m.user_id = auth.uid()
         and m.status = 'active'
    )
  );

revoke all on table public.tenant_invitations from public, anon, authenticated, service_role;
grant select on table public.tenant_invitations to authenticated;

-- ---------------------------------------------------------------- invite_member_v1
create or replace function public.invite_member_v1(
  p_organisation_id uuid,
  p_email text,
  p_role_id uuid
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
  v_email text;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to invite a member' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not exists (
    select 1
      from public.organisation_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'members.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer members' using errcode = '42501';
  end if;

  if p_email is null or p_role_id is null then
    raise exception 'an email and a role id are required to invite a member' using errcode = '22023';
  end if;

  v_email := lower(btrim(p_email));
  -- Canonical form only: same transformation as profiles.email CHECK + ASCII-domain shape so the
  -- TypeScript canonicalEmail helper and SQL agree (plan §4.2; src/platform/identity/email.ts).
  if v_email is null
     or char_length(v_email) < 3
     or char_length(v_email) > 254
     or position(' ' in v_email) > 0
     or v_email !~ '^[^\s@,;<>":''\\]+@[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$'
  then
    raise exception 'email is not a canonical address' using errcode = '22023';
  end if;

  -- Collision with a live / ended membership of THIS tenant only. Missing profiles and non-members
  -- of this tenant both continue to insert — never an identity-existence oracle (#13(2)).
  if exists (
    select 1
      from public.organisation_memberships m
      join public.profiles p on p.id = m.user_id
     where m.organisation_id = v_organisation
       and p.email = v_email
       and m.status in ('active', 'suspended', 'removed')
  ) then
    raise exception 'not permitted to invite this address' using errcode = '42501';
  end if;

  insert into public.tenant_invitations (
    organisation_id, email, role_id, status, invited_by, expires_at
  ) values (
    v_organisation, v_email, p_role_id, 'pending', v_actor, now() + interval '7 days'
  )
  on conflict (organisation_id, email) where (status = 'pending')
  do update set
    expires_at = excluded.expires_at,
    role_id = excluded.role_id,
    invited_by = excluded.invited_by;

  return 'invited';
end;
$$;

comment on function public.invite_member_v1(uuid, text, uuid) is
  'Scoped RPC (FAQ-0011): writes tenant_invitations only. Same answer for every well-formed address; refuses active/suspended/removed members of this tenant with 42501; foreign role_id → 23503. Claim is T-201.';

-- ---------------------------------------------------------------- bump_policy_revision watches invitations
create trigger tenant_invitations_bump_policy_rev_insert
  after insert on public.tenant_invitations
  referencing new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger tenant_invitations_bump_policy_rev_update
  after update on public.tenant_invitations
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger tenant_invitations_bump_policy_rev_delete
  after delete on public.tenant_invitations
  referencing old table as old_rows
  for each statement execute function public.bump_policy_revision();

comment on function public.bump_policy_revision() is
  '#98: the only writer of organisations.policy_revision. AFTER INSERT / AFTER UPDATE / AFTER DELETE, FOR EACH STATEMENT, on every table whose rows change who may access what (the authoritative list is supabase/tests/database/013_tenant_admin.test.sql test 145; test 148 counts over it). security definer with EXECUTE revoked from public, anon, authenticated and service_role and granted to nobody, because a table''s trigger fires without the invoking role holding EXECUTE. No-op resistant and recursion-safe by the same mechanism: the tenants this statement actually changed are collected into an array, and when that array is empty **no statement runs at all**.';

-- ---------------------------------------------------------------- privileges (FAQ-0010)
revoke execute on function
  public.invite_member_v1(uuid, text, uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.invite_member_v1(uuid, text, uuid)
  to authenticated;
