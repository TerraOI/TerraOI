-- T-203 / F24 citation open — AGENT PROPOSAL, pending the Q-10 ruling (not an approved decision). Shape: the server
-- re-authorizes on every click and streams the object with the reader's own token — **no URL is ever
-- minted** for a reader, so ADR-0011's single-minter rule and workers/import-boundary.test.ts stand
-- unchanged, and nothing durable (URL, object key) reaches the browser or an answer row (plan §4.4).
--
-- 1. public.source_readable_in(p_org, p_source): the T-214 read predicate (source_is_readable /
--    source_audience_allows) with the organisation explicit instead of the transaction scope — Storage
--    requests carry no tenant scope GUC. Internal.
-- 2. Storage SELECT policy knowledge_objects_reader_select: a signed-in member may read a knowledge
--    object only while it is the object of a **published** version whose source they may read now.
--    Revocation, a removed project membership or a suspended membership closes it at once.
-- 3. public.cite_source_object_v1(p_org, p_chunk_id): the scoped re-authorization the route calls
--    first; answers the object key only for a readable, published chunk, and no row otherwise (forged,
--    foreign, revoked and absent ids look the same).

create or replace function public.source_readable_in(p_organisation_id uuid, p_source_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  with src as (
    select s.id, c.project_id as collection_project_id
      from public.knowledge_sources s
      join public.knowledge_collections c on c.id = s.collection_id and c.organisation_id = s.organisation_id
     where s.id = p_source_id
       and s.organisation_id = p_organisation_id
       and s.lifecycle_state = 'active'
  ),
  collection_project_ok as (
    select exists (
      select 1 from public.projects p
       where p.id = (select collection_project_id from src)
         and p.organisation_id = p_organisation_id
         and p.status = 'active'
         and public.is_project_member(p.id)) as ok
  ),
  has_bindings as (
    select exists (select 1 from public.source_acl_bindings b
                    where b.source_id = p_source_id and b.organisation_id = p_organisation_id) as v
  ),
  binding_ok as (
    select exists (
      select 1 from public.source_acl_bindings b
        join public.projects p on p.id = b.project_id and p.organisation_id = b.organisation_id
       where b.source_id = p_source_id
         and b.organisation_id = p_organisation_id
         and p.status = 'active'
         and public.is_project_member(b.project_id)) as ok
  )
  select public.is_active_member(p_organisation_id)
     and exists (select 1 from src)
     and case
           when (select v from has_bindings) then
             (select ok from binding_ok)
             or ((select collection_project_id from src) is not null and (select ok from collection_project_ok))
           when (select collection_project_id from src) is null then true
           else (select ok from collection_project_ok)
         end;
$$;
comment on function public.source_readable_in(uuid, uuid) is
  'Internal: source_is_readable with an explicit organisation (T-214 audience rules), for paths with no tenant scope GUC such as Storage RLS.';
revoke all on function public.source_readable_in(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.user_may_read_published_object(p_object_name text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.source_versions sv
     where sv.object_ref = p_object_name
       and sv.state = 'published'
       and public.source_readable_in(sv.organisation_id, sv.source_id)
  );
$$;
comment on function public.user_may_read_published_object(text) is
  'Storage RLS predicate (F24): the object of a published version whose source the caller may read now. Not an API surface.';
revoke all on function public.user_may_read_published_object(text) from public, anon, authenticated, service_role;
-- A policy predicate runs with the privileges of the querying role, so Storage (which queries as
-- `authenticated`) needs EXECUTE on it — the member_has_evals_review precedent. It answers only about
-- the caller (auth.uid()) and one object name.
grant execute on function public.user_may_read_published_object(text) to authenticated;

drop policy if exists knowledge_objects_reader_select on storage.objects;
create policy knowledge_objects_reader_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'knowledge'
    and public.user_may_read_published_object(name)
  );

create or replace function public.cite_source_object_v1(
  p_organisation_id uuid,
  p_chunk_id uuid
) returns table (
  object_ref text,
  data_class text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.set_tenant_scope(p_organisation_id);
  if p_chunk_id is null then
    return;
  end if;
  return query
    select sv.object_ref, sv.data_class
      from public.knowledge_chunks kc
      join public.source_versions sv
        on sv.id = kc.source_version_id and sv.organisation_id = kc.organisation_id
     where kc.id = p_chunk_id
       and kc.organisation_id = public.current_organisation_id()
       and sv.state = 'published'
       and public.source_is_readable(sv.source_id);
end;
$$;
comment on function public.cite_source_object_v1(uuid, uuid) is
  'F24 re-authorization for opening a citation: the object key of a readable, published chunk, or no row (forged, foreign, revoked and absent ids alike). The route streams the object with the reader''s own token; no URL is minted.';
revoke all on function public.cite_source_object_v1(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cite_source_object_v1(uuid, uuid) to authenticated;
