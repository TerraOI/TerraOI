-- T-201 PR-2 (re-done after #186 closed unmerged): the three objects T-201 PR-1 (#181) left its ports
-- waiting for, written to the supervisor rulings recorded on #186, #179, #182, #183, #184 and #185.
--
-- 1. `tenant_entra_issuers` + `entra_allowed_issuers_v1(p_host)` — the Entra issuer gate's read, keyed on
--    the routed host and resolved to the organisation inside (#185 option 3). An unknown or inactive
--    host answers exactly like a tenant that allows nothing (an empty list), so the read does not say
--    which tenants exist. Granted to `authenticated` only.
-- 2. `redeem_invitation_v1(p_host)` — the invitee claiming a pending, unexpired `tenant_invitations`
--    row of the routed tenant (#179 invite model). The address matched is the caller's provider-verified
--    one, read from `auth.users` inside the definer function; there is no email or user argument. In one
--    transaction it creates the caller's profile if missing, inserts the membership as `active` with
--    the invited role, and marks the invitation `accepted`. A suspended or removed membership is never
--    resurrected, and an existing membership of any status answers `not_found`. Closed answers:
--    redeemed | not_found | email_mismatch. Host-keyed for the same reason as the Entra read: the
--    routed host is the only tenant input a pre-membership request has (AGENTS.md §4.1).
-- 3. `toi_identity.revoke_user_sessions_v1(p_user_id, p_host, p_now)` — a completed password reset
--    revokes the user's sessions on **every host of the same organisation** (#182); an unknown or
--    inactive host is refused, never "nothing to revoke"; `true` means the revocation ran, including
--    when it revoked zero rows (#183). Granted to `toi_session_worker`, the sixth function in its set
--    (#184, ADR-0003 §3a amended by name).

-- ---------------------------------------------------------------- host → organisation (internal)
create or replace function public.organisation_for_active_host(p_host text)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- Same guard and the same live-domain / live-organisation conditions as resolve_tenant_host.
  if p_host is null or p_host <> lower(btrim(p_host)) or p_host ~ '[[:space:]:/]' then
    raise exception 'host must be a normalized bare hostname' using errcode = '22023';
  end if;
  return (
    select d.organisation_id
      from public.tenant_domains d
      join public.organisations o on o.id = d.organisation_id
     where d.host = p_host
       and d.status = 'active'
       and o.status in ('provisioning', 'active')
     limit 1
  );
end;
$$;
comment on function public.organisation_for_active_host(text) is
  'Internal: the organisation a live host routes to, or null. Same guard and conditions as resolve_tenant_host. Not an API surface.';
revoke all on function public.organisation_for_active_host(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- Entra issuer allow-list
create table public.tenant_entra_issuers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  -- Entra tenant ids are uuids matched exactly (entra-linking.ts: "never case-folded"); the canonical
  -- form is CHECKed so a stored variant cannot silently never match.
  issuer_tenant_id text not null check (
    issuer_tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  created_at timestamptz not null default now(),
  unique (organisation_id, issuer_tenant_id)
);
comment on table public.tenant_entra_issuers is
  'Plan §4.2: the Entra tenant ids a tenant permits. Empty refuses every Entra sign-in; it never means unrestricted.';
alter table public.tenant_entra_issuers enable row level security;
revoke all on table public.tenant_entra_issuers from public, anon, authenticated, service_role;

create or replace function public.entra_allowed_issuers_v1(p_host text)
returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  v_org := public.organisation_for_active_host(p_host);
  if v_org is null then
    -- Indistinguishable from a tenant that allows nothing: both refuse, neither says which (#185).
    return '{}'::text[];
  end if;
  return coalesce(
    (select array_agg(i.issuer_tenant_id order by i.issuer_tenant_id)
       from public.tenant_entra_issuers i
      where i.organisation_id = v_org),
    '{}'::text[]);
end;
$$;
comment on function public.entra_allowed_issuers_v1(text) is
  'Entra issuer gate read (plan §4.2, #185): keyed on the routed host, resolved to the organisation inside; unknown host = empty = refusal. A named pre-membership read (ADR-0003 §3b). Granted to authenticated only.';
revoke all on function public.entra_allowed_issuers_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.entra_allowed_issuers_v1(text) to authenticated;

-- ---------------------------------------------------------------- invite claim
create or replace function public.redeem_invitation_v1(p_host text)
returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_org uuid;
  v_email text;
  v_confirmed timestamptz;
  v_invitation public.tenant_invitations%rowtype;
  v_membership uuid;
begin
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  v_org := public.organisation_for_active_host(p_host);
  if v_org is null then
    return 'not_found';
  end if;

  select lower(btrim(u.email)), u.email_confirmed_at
    into v_email, v_confirmed
    from auth.users u
   where u.id = v_user;
  -- Only a provider-verified address can claim (plan §4.2: never auto-link an unverified email).
  if v_email is null or v_confirmed is null then
    return 'email_mismatch';
  end if;

  -- Any existing membership — active, suspended or removed — is not claimable: re-instating a member
  -- is an admin act, never something a signed-in user does to themselves (#179).
  if exists (select 1 from public.organisation_memberships m
              where m.organisation_id = v_org and m.user_id = v_user) then
    return 'not_found';
  end if;

  select * into v_invitation
    from public.tenant_invitations i
   where i.organisation_id = v_org
     and i.email = v_email
     and i.status = 'pending'
     and i.expires_at > now()
   for update;
  if not found then
    return 'not_found';
  end if;

  insert into public.profiles (id, email)
  values (v_user, v_email)
  on conflict (id) do nothing;

  insert into public.organisation_memberships (organisation_id, user_id, status, joined_at)
  values (v_org, v_user, 'active', now())
  returning id into v_membership;

  insert into public.membership_roles (organisation_id, membership_id, role_id)
  values (v_org, v_membership, v_invitation.role_id);

  update public.tenant_invitations
     set status = 'accepted'
   where id = v_invitation.id
     and organisation_id = v_org;

  return 'redeemed';
end;
$$;
comment on function public.redeem_invitation_v1(text) is
  'T-201 invite claim (#179): the caller''s provider-verified address claims a pending, unexpired invitation of the routed tenant; membership becomes active with the invited role, invitation accepted, profile created if missing. Never resurrects a suspended/removed membership. Answers redeemed | not_found | email_mismatch. The only function that makes a membership active for the invitee.';
revoke all on function public.redeem_invitation_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.redeem_invitation_v1(text) to authenticated;

-- ---------------------------------------------------------------- reset revocation (organisation-wide)
create or replace function toi_identity.revoke_user_sessions_v1(
  p_user_id uuid,
  p_host text,
  p_now timestamptz
) returns boolean
language plpgsql volatile security definer set search_path = toi_identity, pg_temp as $$
declare
  v_org uuid;
begin
  if p_user_id is null then
    raise exception 'a user id is required' using errcode = '22023';
  end if;
  if p_now is null then
    raise exception 'a timestamp is required' using errcode = '22023';
  end if;
  v_org := public.organisation_for_active_host(p_host);
  if v_org is null then
    raise exception 'unknown or inactive host' using errcode = '28000';
  end if;

  -- Every not-yet-revoked session of this user on any host of this organisation (#182); sessions of
  -- the same user under another organisation are untouched. Already-revoked rows keep their instant.
  update toi_identity.sessions s
     set revoked_at = p_now
   where s.user_id = p_user_id
     and s.revoked_at is null
     and s.host in (select d.host from public.tenant_domains d where d.organisation_id = v_org);

  -- TRUE means the revocation ran, including zero rows (#183).
  return true;
end;
$$;
comment on function toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz) is
  'Password-reset revocation (#182/#183): every session of this user on every host of the routed host''s organisation; unknown/inactive host raises 28000; TRUE = the revocation ran. Granted to toi_session_worker only (#184).';
revoke all on function toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function toi_identity.revoke_user_sessions_v1(uuid, text, timestamptz) to toi_session_worker;
