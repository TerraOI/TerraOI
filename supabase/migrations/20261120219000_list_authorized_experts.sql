-- T-311 PR-4 (#221 N1): scoped registry read for Auto / routeExpert.
--
-- `expert_definitions` grants zero privileges to request roles (§9.3 / #143 B8), and under
-- FAQ-0011 a direct SELECT cannot see `current_organisation_id()`, so the entitlement tables
-- have no working read path for routing. This SECURITY DEFINER returns only what Auto needs:
-- expert key, pinned version, authorizing service key, and release status. It deliberately
-- omits `model_chains` (provider secrecy) and `collection_bindings` (project-only collection
-- ids must not reach ordinary members — #221 N1).
--
-- Caller: `withTenantRpc` → `listAuthorizedExperts` (src/platform/agents/list-authorized-experts.ts).

create or replace function public.list_authorized_experts_v1(
  p_organisation_id uuid
) returns table (
  expert_key text,
  expert_version text,
  service_key text,
  status text
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  -- FAQ-0011: p_organisation_id first; scope established inside the same transaction.
  -- set_tenant_scope refuses unless auth.uid() is an active member (28000).
  -- Volatile because set_config inside set_tenant_scope is volatile.
  perform public.set_tenant_scope(p_organisation_id);

  return query
    select
      te.expert_key,
      te.expert_version,
      te.service_key,
      ed.status
    from public.tenant_experts te
    inner join public.expert_definitions ed
      on ed.expert_key = te.expert_key
     and ed.version = te.expert_version
     and ed.service_key = te.service_key
    inner join public.tenant_services ts
      on ts.organisation_id = te.organisation_id
     and ts.service_key = te.service_key
     and ts.enabled = true
   where te.organisation_id = public.current_organisation_id()
     and te.enabled = true
   order by te.service_key, te.expert_key, te.expert_version;
end;
$$;

comment on function public.list_authorized_experts_v1(uuid) is
  'T-311 #221 N1: scoped Auto/routing projection of entitled experts (key, version, service, status). SECURITY DEFINER so expert_definitions status is readable without granting the table (#143 B8). Never returns model_chains or collection_bindings. Empty when unscoped or unentitled; set_tenant_scope raises 28000 for non-members.';

-- FAQ-0010: revoke by full signature, grant only authenticated.
revoke execute on function
  public.list_authorized_experts_v1(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.list_authorized_experts_v1(uuid)
  to authenticated;
