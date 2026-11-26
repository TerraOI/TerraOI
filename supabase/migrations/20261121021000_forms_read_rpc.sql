-- T-301 PR-2 (Lane 1, second migration authorized by supervisor Round-1 on PR #220):
--   B1. Scoped template read RPCs (`list_form_templates_v1`, `get_form_template_v1`) in the
--       FAQ-0011 shape (`p_organisation_id` first, `set_tenant_scope` as first statement,
--       `is_project_member` enforced live in SQL) so runtime forms never read a hard-coded seed
--       catalog.
--   B2. `create or replace function public.submit_form_v1` so `source_versions.content_hash`
--       hashes `p_submission_id` together with `body_text`; two distinct drafts with identical
--       values now both capture into the same collection, while `state = 'submitted'` (and
--       `for update`) continues to refuse replays of a single draft.
--
-- Does not edit merged `20261120213000_forms.sql` (AGENTS.md §6). Covered by
-- `supabase/tests/database/080_forms.test.sql` (tests 70..96) and the allow-list in
-- `supabase/tests/database/001_function_privileges.test.sql` (FAQ-0010).

-- ---------------------------------------------------------------- B1: scoped template read RPCs

/**
 * List published form templates installed in `p_organisation_id` that the active member may fill,
 * filtered live by tenant membership (`set_tenant_scope`) and project audience
 * (`is_project_member`). Retired and unpublished draft templates are omitted so a retired template
 * no longer appears open on `/forms` (plan §16, Round-1 B1).
 */
create or replace function public.list_form_templates_v1(p_organisation_id uuid)
returns table (
  id uuid,
  organisation_id uuid,
  scope text,
  service_key text,
  name text,
  description text,
  version text,
  json_schema jsonb,
  ui_hints jsonb,
  default_collection_id uuid,
  project_id uuid,
  data_class text,
  status text,
  published_at timestamptz
)
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  perform public.set_tenant_scope(p_organisation_id);

  return query
    select t.id,
           t.organisation_id,
           t.scope,
           t.service_key,
           t.name,
           t.description,
           t.version,
           t.json_schema,
           t.ui_hints,
           t.default_collection_id,
           t.project_id,
           t.data_class,
           t.status,
           t.published_at
      from public.form_templates t
     where t.organisation_id = public.current_organisation_id()
       and public.is_active_member(t.organisation_id)
       and t.status = 'published'
       and (t.project_id is null or public.is_project_member(t.project_id))
     order by t.service_key, t.name, t.version, t.id;
end;
$$;
comment on function public.list_form_templates_v1(uuid) is
  'Scoped read of published form templates visible to the signed-in member in p_organisation_id, enforcing set_tenant_scope and is_project_member live in SQL (FAQ-0011, Round-1 B1).';

/**
 * Fetch one form template in `p_organisation_id` visible to the active member. Returns 0 rows for
 * unknown ids, foreign-tenant ids, templates outside the member''s project audience, and
 * unpublished drafts (no cross-tenant or cross-project existence oracle). Returns `retired` rows
 * alongside `published` ones so the submit boundary can refuse a mid-draft retirement by naming
 * the closed version (plan §16), while the detail view refuses to open a retired form.
 */
create or replace function public.get_form_template_v1(
  p_organisation_id uuid,
  p_template_id uuid
)
returns table (
  id uuid,
  organisation_id uuid,
  scope text,
  service_key text,
  name text,
  description text,
  version text,
  json_schema jsonb,
  ui_hints jsonb,
  default_collection_id uuid,
  project_id uuid,
  data_class text,
  status text,
  published_at timestamptz
)
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  perform public.set_tenant_scope(p_organisation_id);

  return query
    select t.id,
           t.organisation_id,
           t.scope,
           t.service_key,
           t.name,
           t.description,
           t.version,
           t.json_schema,
           t.ui_hints,
           t.default_collection_id,
           t.project_id,
           t.data_class,
           t.status,
           t.published_at
      from public.form_templates t
     where t.id = p_template_id
       and t.organisation_id = public.current_organisation_id()
       and public.is_active_member(t.organisation_id)
       and t.status in ('published', 'retired')
       and (t.project_id is null or public.is_project_member(t.project_id));
end;
$$;
comment on function public.get_form_template_v1(uuid, uuid) is
  'Scoped single-template read in p_organisation_id enforcing set_tenant_scope and is_project_member. Hides foreign, out-of-project and draft rows; keeps retired status visible so submit refusals name the closed version (plan §16, Round-1 B1).';

-- ---------------------------------------------------------------- B2: submission-scoped content hash

create or replace function public.submit_form_v1(p_organisation_id uuid, p_submission_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_submission public.form_submissions%rowtype;
  v_template public.form_templates%rowtype;
  v_collection public.knowledge_collections%rowtype;
  v_body text;
  v_hash text;
  v_source_id uuid;
  v_version_id uuid;
  v_reason text;
begin
  perform public.set_tenant_scope(p_organisation_id);

  select * into v_submission
    from public.form_submissions
   where id = p_submission_id and organisation_id = p_organisation_id
   for update;
  if not found then
    raise exception 'no such submission' using errcode = '42501';
  end if;
  if v_submission.state = 'submitted' then
    -- Replay protection lives on the submission row itself (locked FOR UPDATE above): a replayed
    -- submit of one draft is refused with 22023 without blocking a second legitimate draft that
    -- carries the same field values (Round-1 B2).
    raise exception 'this submission was already captured' using errcode = '22023';
  end if;
  if v_submission.created_by <> auth.uid() then
    raise exception 'only the author may submit a draft' using errcode = '42501';
  end if;

  select * into v_template
    from public.form_templates
   where id = v_submission.template_id and organisation_id = v_submission.organisation_id
     and version = v_submission.template_version;
  if not found or v_template.status <> 'published' then
    raise exception 'version % of this template is no longer open for submissions',
      v_submission.template_version using errcode = '22023';
  end if;

  -- The values are re-validated against the *pinned* version, never against the newest one (§16).
  v_reason := public.form_values_reject_reason(v_template.json_schema, v_submission.values_json);
  if v_reason is not null then
    raise exception 'form values were rejected: %', v_reason using errcode = '22023';
  end if;

  if not public.user_may_publish_into(v_template.default_collection_id) then
    raise exception 'not permitted to publish into this collection' using errcode = '42501';
  end if;

  select * into v_collection
    from public.knowledge_collections
   where id = v_template.default_collection_id;

  v_body := public.form_submission_body_text(v_template.ui_hints, v_submission.values_json);
  -- Round-1 B2: hash the submission id together with the rendered body so two distinct drafts with
  -- identical answers (e.g. repeated daily pre-flight checks) each produce a distinct content_hash
  -- and both capture into the same collection.
  v_hash := encode(
    extensions.digest(convert_to(p_submission_id::text || E'\n' || v_body, 'utf8'), 'sha256'),
    'hex'
  );

  insert into public.knowledge_sources (
    organisation_id, collection_id, kind, external_id, owner_user_id
  ) values (
    p_organisation_id, v_template.default_collection_id, 'form_submission',
    'form_submission/' || p_submission_id::text, auth.uid()
  )
  returning id into v_source_id;

  insert into public.source_versions (
    organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
    content_hash, object_ref, state, parser_generation, body_text, payload
  ) values (
    p_organisation_id, v_source_id, v_template.default_collection_id, 1, auth.uid(),
    v_collection.data_class, v_hash,
    'knowledge/forms/' || p_organisation_id::text || '/' || p_submission_id::text || '.json',
    'received', 'v1', v_body,
    jsonb_build_object(
      'submission_id', p_submission_id,
      'template_id', v_template.id,
      'template_version', v_template.version,
      'service_key', v_template.service_key,
      'name', v_template.name,
      'values', v_submission.values_json
    )
  )
  returning id into v_version_id;

  update public.form_submissions
     set state = 'submitted', body_text = v_body,
         source_id = v_source_id, source_version_id = v_version_id
   where id = p_submission_id and organisation_id = p_organisation_id;

  return p_submission_id;
exception
  when unique_violation then
    raise exception 'this submission was already captured' using errcode = '22023';
end;
$$;
comment on function public.submit_form_v1(uuid, uuid) is
  'Captures one of the caller''s own drafts as a knowledge source plus one source_version (structured values in payload, rendered text in body_text) and one outbox event, in one transaction. Hashes submission id with body so distinct drafts with identical values both capture; replay of one draft is refused with 22023 (Round-1 B2).';

-- ---------------------------------------------------------------- privileges (FAQ-0010)
revoke execute on function
  public.list_form_templates_v1(uuid),
  public.get_form_template_v1(uuid, uuid),
  public.submit_form_v1(uuid, uuid)
  from public, anon, authenticated;

grant execute on function
  public.list_form_templates_v1(uuid),
  public.get_form_template_v1(uuid, uuid),
  public.submit_form_v1(uuid, uuid)
  to authenticated;
