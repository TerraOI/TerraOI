-- T-214 PR-1: project-scoped source audience (`source_acl_bindings`) and `authorize_source_access_v1`.
-- Plan §6.2, §8.2, §16; F08 minimal (retrieve/cite/history/download purpose gate; boolean, no leak).
-- Extends `collection_is_readable` / `source_is_readable` for archived projects and binding unions.

-- ---------------------------------------------------------------- source_acl_bindings
create table public.source_acl_bindings (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  source_id uuid not null,
  project_id uuid not null,
  created_at timestamptz not null default now(),
  unique (source_id, project_id),
  unique (id, organisation_id),
  constraint source_acl_bindings_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint source_acl_bindings_source_fk
    foreign key (source_id, organisation_id)
    references public.knowledge_sources (id, organisation_id) on delete cascade,
  constraint source_acl_bindings_project_fk
    foreign key (project_id, organisation_id)
    references public.projects (id, organisation_id) on delete cascade
);

comment on table public.source_acl_bindings is
  'Additional project audiences for a source beyond its collection''s project_id (T-214). A member of neither the collection project nor any bound project sees nothing from that source; bindings union with the collection audience when present.';

create index source_acl_bindings_source_idx on public.source_acl_bindings (organisation_id, source_id);
create index source_acl_bindings_project_idx on public.source_acl_bindings (organisation_id, project_id);

alter table public.source_acl_bindings enable row level security;

create policy source_acl_bindings_scoped_read on public.source_acl_bindings
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and exists (
      select 1
        from public.projects p
       where p.id = source_acl_bindings.project_id
         and p.organisation_id = source_acl_bindings.organisation_id
         and (p.visibility = 'organisation' or public.is_project_member(p.id))
    )
  );

revoke all on public.source_acl_bindings from anon, authenticated;
grant select on public.source_acl_bindings to authenticated;

-- ---------------------------------------------------------------- audience helpers (replace predicates)
create or replace function public.collection_is_readable(p_collection_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.knowledge_collections c
     where c.id = p_collection_id
       and c.organisation_id = public.current_organisation_id()
       and public.is_active_member(c.organisation_id)
       and (
         c.project_id is null
         or exists (
           select 1
             from public.projects p
            where p.id = c.project_id
              and p.organisation_id = c.organisation_id
              and p.status = 'active'
              and public.is_project_member(p.id)
         )
       )
  );
$$;

comment on function public.collection_is_readable(uuid) is
  'Tenant scope + project audience for the knowledge read path; archived projects stop collection visibility (T-214).';

/**
 * Union audience for a source: collection project rules when no bindings exist; when bindings exist,
 * the caller must satisfy at least one active bound project **or** the collection audience (§6.2).
 */
create or replace function public.source_audience_allows(p_source_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  with src as (
    select c.project_id as collection_project_id
      from public.knowledge_sources s
      join public.knowledge_collections c
        on c.id = s.collection_id and c.organisation_id = s.organisation_id
     where s.id = p_source_id
       and s.organisation_id = public.current_organisation_id()
  ),
  has_bindings as (
    select exists (
      select 1
        from public.source_acl_bindings b
       where b.source_id = p_source_id
         and b.organisation_id = public.current_organisation_id()
    ) as v
  ),
  collection_ok as (
    select case
      when (select collection_project_id from src) is null then true
      else exists (
        select 1
          from public.projects p
         where p.id = (select collection_project_id from src)
           and p.status = 'active'
           and public.is_project_member(p.id)
      )
    end as ok
  ),
  binding_ok as (
    select exists (
      select 1
        from public.source_acl_bindings b
        join public.projects p
          on p.id = b.project_id and p.organisation_id = b.organisation_id
       where b.source_id = p_source_id
         and b.organisation_id = public.current_organisation_id()
         and p.status = 'active'
         and public.is_project_member(b.project_id)
    ) as ok
  )
  select case
    when not exists (select 1 from src) then false
    when (select v from has_bindings) then
      (select ok from binding_ok) or (select ok from collection_ok)
    else
      (select ok from collection_ok)
  end;
$$;

comment on function public.source_audience_allows(uuid) is
  'Project audience union for one source: bindings OR collection project (T-214). SECURITY DEFINER; not granted to request roles.';

revoke execute on function public.source_audience_allows(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.source_is_readable(p_source_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.knowledge_sources s
      join public.knowledge_collections c
        on c.id = s.collection_id and c.organisation_id = s.organisation_id
     where s.id = p_source_id
       and s.organisation_id = public.current_organisation_id()
       and s.lifecycle_state = 'active'
       and public.is_active_member(s.organisation_id)
       and c.organisation_id = public.current_organisation_id()
       and public.source_audience_allows(p_source_id)
  );
$$;

-- ---------------------------------------------------------------- authorize_source_access_v1 (FAQ-0011)
create or replace function public.authorize_source_access_v1(
  p_organisation_id uuid,
  p_source_id uuid,
  p_purpose text
) returns boolean
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_arrived_scope uuid := public.current_organisation_id();
begin
  perform public.set_tenant_scope(p_organisation_id);

  if v_arrived_scope is not null and v_arrived_scope <> p_organisation_id then
    raise exception 'authorize_source_access_v1: this transaction is already scoped to organization %, so it cannot authorize in % (§4.1, #163)',
      v_arrived_scope, p_organisation_id using errcode = '28000';
  end if;

  if auth.uid() is null then
    raise exception 'authorize_source_access_v1: no authenticated user' using errcode = '28000';
  end if;

  if not public.is_active_member(p_organisation_id) then
    raise exception 'authorize_source_access_v1: not an active member of this organization (§4.2)'
      using errcode = '28000';
  end if;

  if p_purpose is null or p_purpose not in ('retrieve', 'cite', 'history', 'download') then
    raise exception 'authorize_source_access_v1: p_purpose must be retrieve, cite, history or download (F08)'
      using errcode = '22023';
  end if;

  return public.source_is_readable(p_source_id);
end;
$$;

comment on function public.authorize_source_access_v1(uuid, uuid, text) is
  'F08 minimal shared access decision (T-214 PR-1). FAQ-0011: p_organisation_id first; scope via set_tenant_scope. Returns true when source_is_readable; false when withheld (no existence leak). Invalid purpose → 22023; scope/membership → 28000.';

revoke execute on function public.authorize_source_access_v1(uuid, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.authorize_source_access_v1(uuid, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------- policy_revision on source_acl_bindings (#98)
create trigger source_acl_bindings_bump_policy_rev_insert
  after insert on public.source_acl_bindings
  referencing new table as new_rows
  for each statement execute function public.bump_policy_revision();

create trigger source_acl_bindings_bump_policy_rev_update
  after update on public.source_acl_bindings
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();

create trigger source_acl_bindings_bump_policy_rev_delete
  after delete on public.source_acl_bindings
  referencing old table as old_rows
  for each statement execute function public.bump_policy_revision();