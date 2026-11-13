-- T-102h (#171, review B2): the sign-in bootstrap reads go through RPCs, not table SELECTs.
-- AGENTS.md §4.2 and plan §4.3 say tenant access goes through scoped RPCs; until now
-- `src/platform/identity/tenancy-data-api.ts` reached `organisation_memberships` and
-- `organisations` through PostgREST's direct table endpoints. Both reads stay authenticated as the
-- signed-in user — no service-role key anywhere — and neither takes a user id from the caller.
--
-- Two functions, and they are deliberately shaped differently:
--
--  * `current_policy_revision_v1` is an ordinary tenant-scoped read and follows FAQ-0011 exactly:
--    `p_organisation_id uuid` first, `set_tenant_scope` as its first statement, in the same
--    transaction as the work. Its caller has an active membership by construction (it runs after a
--    session has been issued), so the scope helper is the right gate.
--  * `current_membership_v1` answers the question that gate cannot: "is this caller a member at all,
--    and in what status?" `set_tenant_scope` raises 28000 unless `is_active_member` is true
--    (20261105060000_tenancy_core.sql:214), and the invited claim in F05 has to see its own
--    `invited` row before it can become active. So this one sets no scope and reads exactly one
--    thing: the caller's own row, with `user_id` taken from `auth.uid()` and never from an argument.
--    `memberships_read_own` is the ceiling. Recorded as a named carve-out in ADR-0003 §3b.

-- ---------------------------------------------------------------- tenant-scoped read (FAQ-0011)
create or replace function public.current_policy_revision_v1(p_organisation_id uuid)
returns bigint
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_revision bigint;
begin
  perform public.set_tenant_scope(p_organisation_id);
  select o.policy_revision into v_revision
    from public.organisations o
   where o.id = p_organisation_id;
  if v_revision is null then
    -- The scope helper already refused any non-member, so a missing row here is a tenancy fact and
    -- it gets the same code: never "empty", which would read as a page with no policy.
    raise exception 'organisation not visible under this scope' using errcode = '28000';
  end if;
  return v_revision;
end;
$$;

comment on function public.current_policy_revision_v1(uuid) is
  'F02/§6.2: the policy revision of the scoped organization. Scoped RPC per FAQ-0011; caller is withTenantRpc or the sign-in path once a session exists.';

-- ---------------------------------------------------------------- the bootstrap read (ADR-0003 §3b)
create or replace function public.current_membership_v1(p_organisation_id uuid)
returns table (membership_id uuid, organisation_id uuid, status text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select m.id, m.organisation_id, m.status
    from public.organisation_memberships m
   where m.organisation_id = p_organisation_id
     and m.user_id = auth.uid();
$$;

comment on function public.current_membership_v1(uuid) is
  'The pre-activation membership read (F02, F05): own row only, keyed by auth.uid(), sets no tenant scope by design — set_tenant_scope refuses non-active members, and the invited claim must see its own row first. ADR-0003 §3b.';

-- ---------------------------------------------------------------- privileges (FAQ-0010)
-- PostgreSQL grants EXECUTE to PUBLIC on every new function and a migration cannot close that
-- default, so both are revoked by full signature and granted back only to the request role that
-- needs them. Neither is reachable anonymously: both depend on auth.uid().
revoke execute on function
  public.current_policy_revision_v1(uuid),
  public.current_membership_v1(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.current_policy_revision_v1(uuid),
  public.current_membership_v1(uuid)
  to authenticated;
