-- T-112d / U-1: find_upload_session_v1 + private Storage bucket RLS (#38, #37(b)).
--
-- find_upload_session_v1: the upload-session SELECT policy requires current_organisation_id(),
-- which is only set inside a scoped RPC. A bare PostgREST select would always see no rows, so the
-- complete path needs this reader (FAQ-0011).
--
-- Storage: private bucket `knowledge`. Object paths match begin_upload_session_v1's object_ref
-- (`knowledge/<organisation_id>/uploads/<uuid>/object`). Insert and select are allowed only when
-- the caller is an active member of that organisation, owns an open awaiting_upload session for
-- that exact object_ref, and may still publish into the session's collection. No service-role.

-- ---------------------------------------------------------------- find_upload_session_v1
create or replace function public.find_upload_session_v1(
  p_organisation_id uuid,
  p_upload_session_id uuid
) returns table (
  o_session_id uuid,
  o_organisation_id uuid,
  o_collection_id uuid,
  o_created_by uuid,
  o_idempotency_key text,
  o_object_ref text,
  o_max_size_bytes bigint,
  o_state text,
  o_reason_code text,
  o_expires_at timestamptz,
  o_created_at timestamptz,
  o_source_id uuid,
  o_source_version_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_session public.knowledge_upload_sessions;
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;

  select * into v_session
    from public.knowledge_upload_sessions
   where id = p_upload_session_id
     and organisation_id = v_organisation
     and created_by = v_user;
  if not found then
    return;
  end if;

  o_session_id := v_session.id;
  o_organisation_id := v_session.organisation_id;
  o_collection_id := v_session.collection_id;
  o_created_by := v_session.created_by;
  o_idempotency_key := v_session.idempotency_key;
  o_object_ref := v_session.object_ref;
  o_max_size_bytes := v_session.max_size_bytes;
  o_state := v_session.state;
  o_reason_code := v_session.reason_code;
  o_expires_at := v_session.expires_at;
  o_created_at := v_session.created_at;
  o_source_id := v_session.source_id;
  o_source_version_id := v_session.source_version_id;
  return next;
end;
$$;

comment on function public.find_upload_session_v1(uuid, uuid) is
  'Scoped read of the caller''s own upload session for complete/verify (#38 wiring). p_organisation_id first; set_tenant_scope as the first statement (FAQ-0011). Empty result for unknown, foreign-tenant or other-user sessions — no existence signal (#13(2)).';

revoke execute on function public.find_upload_session_v1(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_upload_session_v1(uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------- Storage bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'knowledge',
  'knowledge',
  false,
  20971520,
  array['application/pdf']::text[]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Helper: may the caller insert/select this storage object path?
-- Storage requests do not run set_tenant_scope, so this predicate must not depend on
-- current_organisation_id(). It binds the path to an open session row and re-checks membership
-- plus publish permission against that row's organisation (same rules as user_may_publish_into).
create or replace function public.user_may_access_knowledge_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.knowledge_upload_sessions s
      join public.knowledge_collections c
        on c.id = s.collection_id
       and c.organisation_id = s.organisation_id
      join public.organisations o
        on o.id = s.organisation_id and o.status = 'active'
      join public.organisation_memberships m
        on m.organisation_id = s.organisation_id
       and m.user_id = auth.uid()
       and m.status = 'active'
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.area in ('knowledge.write', 'knowledge.admin')
       and rp.level in ('write', 'admin')
     where s.object_ref = p_object_name
       and s.created_by = auth.uid()
       and s.state = 'awaiting_upload'
       and s.expires_at > now()
       and (c.project_id is null or public.is_project_member(c.project_id))
  );
$$;

comment on function public.user_may_access_knowledge_object(text) is
  'Storage RLS predicate (#38): open, unexpired, caller-owned upload session whose object_ref equals the storage path, with publish permission still held. Does not read current_organisation_id (Storage has no tenant scope GUC). Not an API surface.';
revoke execute on function public.user_may_access_knowledge_object(text)
  from public, anon, authenticated;

-- Drop prior policies if a re-run is needed in a branch tip
drop policy if exists knowledge_objects_insert on storage.objects;
drop policy if exists knowledge_objects_select on storage.objects;

create policy knowledge_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'knowledge'
    and public.user_may_access_knowledge_object(name)
  );

create policy knowledge_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'knowledge'
    and public.user_may_access_knowledge_object(name)
  );
