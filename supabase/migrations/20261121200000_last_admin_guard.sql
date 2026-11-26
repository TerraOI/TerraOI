-- T-202 last-admin guard (#202 / FAQ-0014).
-- Refuses revoke_membership_role_v1 when the change would leave the tenant with zero **active**
-- holders of members.admin. Count under FOR UPDATE so two concurrent demotions cannot both pass.
-- Refuse with 23514 and a fixed message (a state rule, not a permission failure).
-- Merged PR-1 migration is not edited (AGENTS.md §6); this replaces the revoke body only.
-- Deactivate/suspend membership RPCs are not in M1 yet; when added they must call the same check.

create or replace function public.revoke_membership_role_v1(
  p_organisation_id uuid,
  p_user_id uuid,
  p_role_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
  v_membership uuid;
  v_remaining int;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to revoke a role' using errcode = '28000';
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
  if p_user_id is null or p_role_id is null then
    raise exception 'a user id and a role id are required to revoke a role' using errcode = '22023';
  end if;

  select m.id into v_membership
    from public.organisation_memberships m
   where m.organisation_id = v_organisation
     and m.user_id = p_user_id;
  if v_membership is null then
    raise exception 'no such member in this organization' using errcode = '42501';
  end if;

  -- #202 / FAQ-0014: last active members.admin holder cannot be removed by revoke.
  if exists (
    select 1
      from public.role_permissions rp
     where rp.organisation_id = v_organisation
       and rp.role_id = p_role_id
       and rp.area = 'members.admin'
       and rp.level = 'admin'
  ) then
    perform 1
      from public.membership_roles mr
      join public.organisation_memberships m on m.id = mr.membership_id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'members.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.status = 'active'
     for update of mr;

    select count(distinct m.id)::int into v_remaining
      from public.organisation_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'members.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.status = 'active'
       and not (m.id = v_membership and mr.role_id = p_role_id);

    if v_remaining = 0 then
      raise exception 'cannot remove the last active members.admin holder'
        using errcode = '23514';
    end if;
  end if;

  delete from public.membership_roles
   where membership_id = v_membership
     and role_id = p_role_id
     and organisation_id = v_organisation;

  if not found then
    raise exception 'no such role assignment in this organization' using errcode = '42501';
  end if;
end;
$$;

comment on function public.revoke_membership_role_v1(uuid, uuid, uuid) is
  'Scoped RPC (FAQ-0011): the demotion path. organisation_id is in the DELETE predicate because a DELETE has no composite FK to enforce the tenant bound. #202 / FAQ-0014: refuses with 23514 when revoking the last active members.admin assignment; counts under FOR UPDATE so concurrent demotions cannot both pass. Effect is immediate: the permission gate is re-read from these tables on every request.';

-- Signature unchanged: revoke/grant from request roles already set by PR-1; restate so a fresh
-- apply of this file alone cannot leave EXECUTE open (FAQ-0010).
revoke all on function public.revoke_membership_role_v1(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_membership_role_v1(uuid, uuid, uuid) to authenticated;
