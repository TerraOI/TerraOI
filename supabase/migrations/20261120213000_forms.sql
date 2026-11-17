-- T-301 (Lane 1): TerraOI forms. Versioned templates, and submissions that become knowledge.
--
-- Plan sections 7.6, 6.1 (Forms group), 6.2, 15.0 ("2-3 seeded forms") and 16 (Forms/OCR row);
-- TOI-ADR-16: a form submission is a capture, not a new pipeline. F33 over T-112/T-113.
-- The contract is src/contracts/form-template.ts (merged from T-002; unchanged here) and the
-- form_field variant of EvidenceRef in src/contracts/answer.ts.
--
-- Written against supabase/tests/database/080_forms.test.sql (COORDINATION section 6b, slot 080),
-- which was committed before this file and is red until it lands.
--
-- Shape, in one paragraph: a template is a versioned JSON Schema plus whitelisted UI hints, owned by
-- one organization (issue #195: even a `platform` template is *installed* per tenant, so every row
-- carries organisation_id and RLS works the same way for both scopes). A submission pins the exact
-- (template, version) it was validated against, because FormFieldEvidence cites
-- `submissionId + fieldPath + templateVersion` and a citation must not drift when the template is
-- re-versioned (section 16). Submitting writes one source, one immutable source_version and one
-- outbox event through the merged capture conventions; nothing here bypasses RLS or the class rules.

-- ---------------------------------------------------------------- templates
create table public.form_templates (
  id uuid primary key default gen_random_uuid(),
  -- Every template row belongs to one tenant: `scope = 'platform'` means "the platform seeded it
  -- into this tenant", not "no tenant owns the row" (#195, provisional). RLS is unchanged by scope.
  organisation_id uuid not null,
  scope text not null check (scope in ('platform', 'tenant')),
  -- Same grammar as contracts/keys.ts ServiceKey, and the same rule as knowledge_collections: a
  -- template is addressed by (service_key, name, version), never by a bare id the client invented.
  service_key text not null check (service_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text not null check (char_length(name) between 1 and 200),
  description text check (description is null or char_length(description) between 1 and 2000),
  -- Same grammar as contracts/keys.ts VersionTag. A submission names the version it was validated
  -- against, so versions are never reused or edited in place (section 16).
  version text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- The JSON Schema (contracts/form-template.ts). Type and vocabulary checks are the guard trigger's
  -- job; this CHECK only fixes the container so the trigger can rely on it.
  json_schema jsonb not null check (jsonb_typeof(json_schema) = 'object'),
  ui_hints jsonb not null default '{}'::jsonb check (jsonb_typeof(ui_hints) = 'object'),
  -- Where a submission of this template lands. Composite FK: the collection must belong to the same
  -- organization, so a company1 template can never name a company2 corpus (section 6.2, #6).
  default_collection_id uuid not null,
  project_id uuid,
  -- Section 6.2: the class comes from the template and must be ingestible; `restricted` is never
  -- ingested (section 12.4), so a restricted template is not expressible here at all.
  data_class text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint form_templates_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint form_templates_collection_fk
    foreign key (default_collection_id, organisation_id)
    references public.knowledge_collections (id, organisation_id) on delete restrict,
  constraint form_templates_project_fk
    foreign key (project_id, organisation_id)
    references public.projects (id, organisation_id) on delete restrict,
  constraint form_templates_data_class_valid
    check (public.data_class_is_valid(data_class)),
  constraint form_templates_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  -- client_confidential is project-scoped in M1, exactly as for collections (section 6.2).
  constraint form_templates_confidential_requires_project
    check (data_class <> 'client_confidential' or project_id is not null),
  -- Audience vs collection is enforced in form_templates_guard (below): Postgres forbids a subquery
  -- inside a CHECK (SQLSTATE 0A000), and the corpus the reviewer authorized is still what decides.
  constraint form_templates_published_marker
    check (published_at is null or status = 'published'),
  -- Anti-cross-tenant key for children (tenancy_core convention).
  constraint form_templates_tenant_id_key unique (id, organisation_id),
  constraint form_templates_versioned_key unique (organisation_id, service_key, name, version),
  -- What a submission's composite FK points at: one exact version of one exact template.
  constraint form_templates_template_version_key unique (id, organisation_id, version)
);
comment on table public.form_templates is
  'A versioned form template: JSON Schema plus whitelisted UI hints, owned by one organization. M1 seeds these per tenant (scope platform) and allows tenant-published ones (scope tenant); section 16 keeps a submission bound to one exact version.';
comment on column public.form_templates.scope is
  'Who authored it, not who may see it. Both scopes are per-tenant rows with the same RLS: a platform template is installed into a tenant (issue #195).';
comment on column public.form_templates.default_collection_id is
  'The corpus a submission of this template is captured into. The class of the captured version is this collection''s, never the template''s, and it can be raised by a reviewer and never lowered (section 6.2).';

-- Templates are untrusted content with a path into retrieval (AGENTS.md section 4.8): a submission
-- becomes an indexed source_version, so a template that could carry a script, a stylesheet or a
-- remote URL is an injection into every tenant member''s answer. contracts/form-template.ts has
-- containsUnsafeFormContent for the boundary; a row can also arrive from seed.sql or from a
-- superuser path, so the database enforces the same rule. It is deliberately *stronger*: markup in a
-- string value is refused here even though the contract only refuses remote/inlined URLs (flagged as
-- a contract gap in PR #197 rather than quietly widened).
create function public.form_template_value_is_safe(p_value jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  with recursive node (key, value) as (
    select null::text, p_value
    union all
    select f.key, f.value
      from node n,
           jsonb_each(case when jsonb_typeof(n.value) = 'object' then n.value
                           else '{}'::jsonb end) as f(key, value)
    union all
    select null, e.item
      from node n,
           jsonb_array_elements(case when jsonb_typeof(n.value) = 'array' then n.value
                                     else '[]'::jsonb end) as e(item)
  )
  select not exists (
    select 1
      from node
     -- Key shapes mirror UNSAFE_KEY in contracts/form-template.ts.
     where (key is not null and (
              key ~* '^on(click|change|input|submit|focus|blur|load|error|mouse|key|wheel|toggle)[a-z]*$'
              or key ~* '^(script|style|html|css|src|href|url|action|iframe|embed|import|require)$'
              or key ~* '[-_$.](script|style|html|css|src|href|url|action|iframe|embed|ref)$'
              or key = '$ref'))
       -- String values: remote or inlined handlers (REMOTE_OR_INLINE), plus any tag that a renderer
       -- could execute. A lone '<' stays legal, so "wind < 5 m/s" is a valid answer.
       or (jsonb_typeof(value) = 'string' and (
             value #>> '{}' ~* '(https?:|ftp:|file:|data:|javascript:|vbscript:)//[a-z0-9.-]'
             or value #>> '{}' ~* '(^|[^a-z0-9])//[^ ]+/'
             or value #>> '{}' ~* '</?(script|style|iframe|embed|object|link|meta|form|svg|img)[ >/]'))
  );
$$;
comment on function public.form_template_value_is_safe(jsonb) is
  'Recursive guard for template JSON: no handler or style/script/url keys, no $ref, no remote or inlined resource, no markup. The database-side twin of contracts/form-template.ts containsUnsafeFormContent, and one notch stricter on string values.';

-- The schema root must be a JSON Schema object (contract superRefine) and ui_hints must stay inside
-- the whitelisted FormFieldUiHint keys, which is what makes a hint unable to carry a style.
create function public.form_template_is_wellformed(p_json_schema jsonb, p_ui_hints jsonb)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_json_schema ->> 'type' = 'object'
     -- Every property declaration must itself be a schema object. An absent properties map is legal
     -- JSON Schema; save_form_draft_v1 then refuses every value as undeclared.
     and not exists (
       select 1 from jsonb_each(p_json_schema -> 'properties') as f
        where jsonb_typeof(f.value) <> 'object')
     -- FormFieldUiHint is a strictObject: unknown keys are rejected at the boundary, and a hint key
     -- like "css" or "href" is exactly how a template would inject a stylesheet, so enforce it here.
     and not exists (
       select 1 from jsonb_each(p_ui_hints) as f
        where f.key !~ '^[a-z0-9_][a-z0-9_.]{0,127}$'
           or jsonb_typeof(f.value) <> 'object'
           or exists (select 1 from jsonb_each(f.value) as g
                       where g.key not in ('order', 'placeholder', 'helpText', 'unit'))
           or not public.form_template_value_is_safe(f.value));
$$;
comment on function public.form_template_is_wellformed(jsonb, jsonb) is
  'Root-type check plus the FormFieldUiHint key whitelist (order, placeholder, helpText, unit). Unknown hint keys are what would let a template inject CSS, so they are refused here as well as at the boundary.';

create function public.form_templates_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.form_template_value_is_safe(new.json_schema) then
    raise exception 'a form template cannot contain scripts, styles, remote urls or $ref'
      using errcode = '23514';
  end if;
  if not public.form_template_is_wellformed(new.json_schema, new.ui_hints) then
    raise exception 'a form template schema must be a JSON Schema object and its ui hints must be whitelisted'
      using errcode = '23514';
  end if;
  -- Same rule the abandoned CHECK stated: a set project_id must equal the collection's project_id.
  -- Lives here because CHECK cannot contain a subquery (SQLSTATE 0A000 on apply).
  if new.project_id is not null
     and new.project_id is distinct from (
           select kc.project_id
             from public.knowledge_collections kc
            where kc.id = new.default_collection_id
              and kc.organisation_id = new.organisation_id) then
    raise exception 'a form template project audience must match its default collection'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    -- Published content is frozen: re-validating an existing submission against edited fields is
    -- exactly the silent re-validation section 16 forbids. Retiring is allowed, editing is not.
    if old.status = 'published' and (
         new.json_schema is distinct from old.json_schema
         or new.ui_hints is distinct from old.ui_hints
         or new.version is distinct from old.version
         or new.service_key is distinct from old.service_key
         or new.default_collection_id is distinct from old.default_collection_id
         or new.project_id is distinct from old.project_id
         or new.scope is distinct from old.scope) then
      raise exception 'a published form template version is immutable; publish a new version instead'
        using errcode = '23514';
    end if;
    if new.status <> 'draft' and old.status = 'retired' then
      raise exception 'a retired form template cannot be revived' using errcode = '23514';
    end if;
    if new.status = 'published' and old.status <> 'published' then
      new.published_at := coalesce(new.published_at, now());
    elsif new.status = 'published' then
      new.published_at := old.published_at;
    end if;
  end if;
  return new;
end;
$$;
comment on function public.form_templates_guard() is
  'Refuses unsafe template content at write time, keeps project_id aligned with the default collection (CHECK cannot express that subquery), and freezes a published version''s content; only lifecycle fields may change afterwards.';

create trigger form_templates_guard
  before insert or update on public.form_templates
  for each row execute function public.form_templates_guard();

-- RLS: members of the owning, currently-scoped organization, narrowed to the project audience when
-- the template has one. Read-only: templates are written by seeds and by an admin path that M1 does
-- not expose, so no insert/update/delete policy exists at all (plan section 4.3).
alter table public.form_templates enable row level security;

create policy form_templates_scoped_read on public.form_templates
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and (project_id is null or public.is_project_member(project_id))
  );

revoke all on public.form_templates from anon, authenticated;
grant select on public.form_templates to authenticated;
-- ---------------------------------------------------------------- submissions
create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  template_id uuid not null,
  -- The exact version these values were validated against, stored on the row and never re-resolved
  -- from the newest one: FormFieldEvidence cites submissionId + fieldPath + templateVersion
  -- (contracts/answer.ts), and section 16 forbids a silent re-validation after a re-version.
  template_version text not null,
  -- Audience copied from the template when the draft is created. Kept on the row so a submitted
  -- submission''s visibility does not depend on a template row that could later be retired.
  project_id uuid,
  created_by uuid not null,
  -- `draft` is private to its author and holds no knowledge; `submitted` is immutable and has a
  -- source_version. A correction is a new row linked by supersedes_submission_id, never an edit
  -- (plan section 7.6 step 4).
  state text not null default 'draft' check (state in ('draft', 'submitted')),
  values_json jsonb not null check (jsonb_typeof(values_json) = 'object'),
  -- Rendered at capture (#51 option 1: extracted text is written once, at capture, for text-like
  -- payloads) so the chunker and the form_field evidence have one stable text to work from.
  body_text text check (body_text is null or char_length(body_text) between 1 and 200000),
  source_id uuid,
  source_version_id uuid,
  supersedes_submission_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint form_submissions_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  -- Two composite FKs to the same table on purpose: the tenant check (a company1 submission can
  -- never name a company2 template, 23503 even to a superuser) and the version pin.
  constraint form_submissions_template_fk
    foreign key (template_id, organisation_id)
    references public.form_templates (id, organisation_id) on delete restrict,
  constraint form_submissions_template_version_fk
    foreign key (template_id, organisation_id, template_version)
    references public.form_templates (id, organisation_id, version) on delete restrict,
  constraint form_submissions_project_fk
    foreign key (project_id, organisation_id)
    references public.projects (id, organisation_id) on delete restrict,
  constraint form_submissions_created_by_fk
    foreign key (created_by) references public.profiles (id) on delete restrict,
  -- The capture this submission produced, through the merged knowledge tables. Never edited by a
  -- member: the RPCs are the only writer, and they fill it inside one transaction.
  constraint form_submissions_source_fk
    foreign key (source_id, organisation_id)
    references public.knowledge_sources (id, organisation_id) on delete restrict,
  constraint form_submissions_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete restrict,
  constraint form_submissions_supersedes_fk
    foreign key (supersedes_submission_id, organisation_id)
    references public.form_submissions (id, organisation_id) on delete restrict,
  constraint form_submissions_tenant_id_key unique (id, organisation_id),
  -- Draft and submitted are told apart by more than the flag: a draft has no knowledge behind it, a
  -- submitted row always does. A half-written capture cannot be represented.
  constraint form_submissions_capture_markers check (
    (state = 'draft' and body_text is null and source_id is null and source_version_id is null)
    or (state = 'submitted' and body_text is not null and source_id is not null
        and source_version_id is not null)),
  constraint form_submissions_not_self_superseded
    check (supersedes_submission_id is null or supersedes_submission_id <> id)
);
comment on table public.form_submissions is
  'One filled form, pinned to one exact template version. A draft is private to its author; a submitted row is immutable and owns exactly one source_version in the knowledge pipeline (plan section 7.6, TOI-ADR-16).';
comment on column public.form_submissions.body_text is
  'The rendered text written at capture (#51 option 1): "field: value" one field per line, in schema order. Deterministic so a chunk can be cited against a single field.';
comment on column public.form_submissions.supersedes_submission_id is
  'A correction links the row it replaces instead of editing it (section 7.6 step 4). The superseded row keeps its own capture: history is never rewritten.';

create index form_submissions_tenant_state_idx
  on public.form_submissions (organisation_id, state, created_at desc);
create index form_submissions_author_idx
  on public.form_submissions (organisation_id, created_by)
  where state = 'draft';

create function public.form_submissions_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  -- Audience comes from the template, never from the caller: a submission may not choose a wider
  -- project than the corpus its template writes into (section 6.2).
  if new.project_id is distinct from (
       select t.project_id from public.form_templates t
        where t.id = new.template_id and t.organisation_id = new.organisation_id) then
    raise exception 'a submission cannot choose its own project audience' using errcode = '23514';
  end if;
  if new.supersedes_submission_id is not null and not exists (
       select 1 from public.form_submissions s
        where s.id = new.supersedes_submission_id
          and s.organisation_id = new.organisation_id
          and s.template_id = new.template_id) then
    raise exception 'a correction must supersede a submission of the same template'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    -- Append-only in M1: an edit in place would change a row an earlier answer already cited. The
    -- RPCs write values_json once, at insert, and only ever change state plus the capture pointers.
    if new.values_json is distinct from old.values_json
       or new.template_id is distinct from old.template_id
       or new.template_version is distinct from old.template_version
       or new.created_by is distinct from old.created_by
       or new.organisation_id is distinct from old.organisation_id then
      raise exception 'a form submission is never edited in place; create a correction'
        using errcode = '23514';
    end if;
    if old.state = 'submitted' then
      raise exception 'a submitted form submission is immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
comment on function public.form_submissions_guard() is
  'Defense in depth behind the RPCs: no self-chosen audience, corrections stay on one template, and nothing about a submission''s content or state changes once written.';

create trigger form_submissions_guard
  before insert or update on public.form_submissions
  for each row execute function public.form_submissions_guard();

-- RLS. Two read paths, one grant, no write grants at all: writes go through the scoped RPCs below
-- (plan section 4.3). A draft is visible only to its author; a submitted row follows the template''s
-- audience, and always requires an active membership in the currently scoped organization.
alter table public.form_submissions enable row level security;

create policy form_submissions_author_read on public.form_submissions
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and created_by = auth.uid()
  );

create policy form_submissions_submitted_read on public.form_submissions
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and state = 'submitted'
    and (project_id is null or public.is_project_member(project_id))
  );

revoke all on public.form_submissions from anon, authenticated;
grant select on public.form_submissions to authenticated;
-- ---------------------------------------------------------------- validation (plan section 7.6 step 2)
-- A deliberately small subset of JSON Schema: root object, declared keys, required keys, scalar
-- types and maxLength. That is the whole vocabulary the seeded templates use and the whole
-- vocabulary contracts/form-template.ts can express; anything richer is refused as "unsupported"
-- rather than silently ignored, so a template can never promise a rule the platform does not
-- enforce. Conditional logic is out of scope for the packet (section 7.6).
create function public.form_values_reject_reason(p_json_schema jsonb, p_values jsonb)
returns text
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_props jsonb := coalesce(p_json_schema -> 'properties', '{}'::jsonb);
  v_required jsonb := coalesce(p_json_schema -> 'required', '[]'::jsonb);
  v_field record;
  v_decl jsonb;
  v_max integer;
begin
  if jsonb_typeof(p_values) <> 'object' then
    return 'the submission must be a JSON object';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_required) as r(key)
     where not (p_values ? r.key)) then
    return 'a required field is missing';
  end if;
  if exists (
    select 1 from jsonb_each(p_values) as f
     where not (v_props ? f.key)) then
    return 'a value names a field the template does not declare';
  end if;
  for v_field in select * from jsonb_each(p_values) loop
    v_decl := v_props -> v_field.key;
    case v_decl ->> 'type'
      when 'string' then
        if jsonb_typeof(v_field.value) <> 'string' then
          return 'a text field was given a non-text value';
        end if;
      when 'number' then
        if jsonb_typeof(v_field.value) <> 'number' then
          return 'a numeric field was given a non-numeric value';
        end if;
      when 'integer' then
        if jsonb_typeof(v_field.value) <> 'number' or (v_field.value #>> '{}') ~ '[.]' then
          return 'a whole-number field was given a non-whole value';
        end if;
      when 'boolean' then
        if jsonb_typeof(v_field.value) <> 'boolean' then
          return 'a yes/no field was given a non-boolean value';
        end if;
      else
        return 'the template declares a field type the platform does not validate';
    end case;
    if (v_decl ->> 'maxLength') ~ '^[0-9]+$' then
      v_max := (v_decl ->> 'maxLength')::integer;
      if char_length(v_field.value #>> '{}') > v_max then
        return 'a value is longer than the template allows';
      end if;
    end if;
  end loop;
  if char_length(p_values #>> '{}') > 100000 then
    return 'the submission is larger than the platform accepts';
  end if;
  return null;
end;
$$;
comment on function public.form_values_reject_reason(jsonb, jsonb) is
  'Null when the values satisfy the template schema, otherwise one short reason. Never echoes a value back: a value is untrusted text and a reason string can reach a log (AGENTS.md section 4.8).';

-- The rendered text of a submission (#51 option 1: written once, at capture). Order comes from the
-- template''s ui_hints order, then the field name, so the same values always render the same text
-- and a chunk of it can be cited against one field (FormFieldEvidence.fieldPath).
create function public.form_submission_body_text(p_ui_hints jsonb, p_values jsonb)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select string_agg(s.line, E'\n' order by s.ord, s.line)
    from (
      select p.key || ': ' || coalesce(p.value #>> '{}', '') as line,
             case when (p_ui_hints -> p.key ->> 'order') ~ '^[0-9]+$'
                  then (p_ui_hints -> p.key ->> 'order')::integer else 999 end as ord
        from jsonb_each(p_values) as p
    ) as s;
$$;
comment on function public.form_submission_body_text(jsonb, jsonb) is
  '"field: value" per line, in template order. Deterministic: the content hash and any later chunk depend on it.';

-- ---------------------------------------------------------------- scoped RPCs (plan section 4.3)
/**
 * F33 step 1-2: save a draft of one exact published template version. The tenant comes in as
 * p_organisation_id from withTenantRpc and the scope is set first (FAQ-0011); nothing else about
 * the caller is taken from the client, and created_by is auth.uid().
 *
 * Error vocabulary: 28000 not a member of that organization (from set_tenant_scope), 42501 the
 * template or the corrected submission belongs to someone else or to a project the caller is not in,
 * 22023 the version is not open for submissions or the values fail the schema.
 */
create function public.save_form_draft_v1(
  p_organisation_id uuid,
  p_template_id uuid,
  p_template_version text,
  p_values jsonb,
  p_supersedes_submission_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_template public.form_templates%rowtype;
  v_other public.form_templates%rowtype;
  v_reason text;
  v_submission_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);

  select * into v_template
    from public.form_templates
   where id = p_template_id and organisation_id = p_organisation_id;
  if not found then
    -- A template id from another tenant is a permission answer, never a "not found": the difference
    -- would let a caller enumerate which ids exist in other organizations.
    select * into v_other from public.form_templates where id = p_template_id;
    if found then
      raise exception 'this template belongs to another organization' using errcode = '42501';
    end if;
    raise exception 'no such template version' using errcode = '22023';
  end if;
  if v_template.version <> p_template_version or v_template.status <> 'published' then
    -- Section 16: the refusal names the version asked for, and nothing is validated against a
    -- newer one behind the caller''s back.
    raise exception 'version % of this template is not open for submissions', p_template_version
      using errcode = '22023';
  end if;
  if v_template.project_id is not null and not public.is_project_member(v_template.project_id) then
    raise exception 'this template belongs to a project you are not a member of'
      using errcode = '42501';
  end if;

  v_reason := public.form_values_reject_reason(v_template.json_schema, p_values);
  if v_reason is not null then
    raise exception 'form values were rejected: %', v_reason using errcode = '22023';
  end if;

  if p_supersedes_submission_id is not null and not exists (
    select 1 from public.form_submissions s
     where s.id = p_supersedes_submission_id
       and s.organisation_id = p_organisation_id
       and s.template_id = p_template_id) then
    raise exception 'that submission is not one you may correct' using errcode = '42501';
  end if;

  insert into public.form_submissions (
    organisation_id, template_id, template_version, project_id, created_by, state,
    values_json, supersedes_submission_id
  ) values (
    p_organisation_id, p_template_id, p_template_version, v_template.project_id, auth.uid(),
    'draft', p_values, p_supersedes_submission_id
  )
  returning id into v_submission_id;

  return v_submission_id;
end;
$$;
comment on function public.save_form_draft_v1(uuid, uuid, text, jsonb, uuid) is
  'Scoped write of a private draft against one exact published template version. Creates a linked correction when p_supersedes_submission_id names one (plan section 7.6 step 4).';
/**
 * F33 step 3: capture a draft as knowledge. One transaction writes the source, the immutable
 * source_version and (through the merged source_versions_outbox trigger) one outbox event, then
 * flips the submission. There is no path from here to `published`: the class comes from the
 * collection, the state stays `received`, and publication is the review/publish path (T-113), which
 * is exactly what the packet means by "a submission becomes knowledge, not an answer".
 *
 * Publish permission is the merged predicate user_may_publish_into(uuid) (#39), re-checked at submit
 * rather than at draft time: a draft is private and costs nothing, so a member without
 * `knowledge.write` may fill a form and is refused only when it becomes a corpus entry.
 */
create function public.submit_form_v1(p_organisation_id uuid, p_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
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
   where id = p_submission_id and organisation_id = p_organisation_id;
  if not found then
    raise exception 'no such submission' using errcode = '42501';
  end if;
  if v_submission.state = 'submitted' then
    -- A replay is refused by name of the submission, and the unique (collection, content_hash)
    -- constraint is the backstop if two clients race on identical values.
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
  v_hash := encode(extensions.digest(convert_to(v_body, 'utf8'), 'sha256'), 'hex');

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
    -- Section 6.2: the class is the collection''s, and a reviewer may raise it later, never lower it.
    v_collection.data_class, v_hash,
    -- A form has no uploaded object. The ref is a synthetic, server-issued key with the same shape
    -- an uploaded one has, so the storage path and its checks are not special-cased for forms; it
    -- points at nothing on disk and no code is allowed to fetch it.
    'knowledge/forms/' || p_organisation_id::text || '/' || p_submission_id::text || '.json',
    'received', 'v1', v_body,
    jsonb_build_object(
      'submission_id', p_submission_id,
      'template_id', v_template.id,
      'template_version', v_template.version,
      'service_key', v_template.service_key,
      'name', v_template.name,
      -- Structured values are metadata, not the retrievable body (source_versions.payload); the body
      -- is the rendered text above, which is what a chunk cites.
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
    -- Identical values captured twice into one collection collide on
    -- unique (collection_id, content_hash). Nothing is half-written: the failing statement rolled
    -- the capture back, and the submission is still a draft.
    raise exception 'an identical submission is already in this collection' using errcode = '22023';
end;
$$;
comment on function public.submit_form_v1(uuid, uuid) is
  'Captures one of the caller''s own drafts as a knowledge source plus one source_version (structured values in payload, rendered text in body_text) and one outbox event, in one transaction. Idempotent by refusal: a replay is 22023, never a second version.';

-- ---------------------------------------------------------------- privileges (#60, FAQ-0010)
-- Every function created above is revoked from public, anon and authenticated by full signature in
-- this migration. Only the two request-role RPCs are granted back; the validators and the capture
-- predicate are internal. `001`'s rule-32 allow-list carries the same two signatures.
revoke execute on function
  public.form_template_value_is_safe(jsonb),
  public.form_template_is_wellformed(jsonb, jsonb),
  public.form_values_reject_reason(jsonb, jsonb),
  public.form_submission_body_text(jsonb, jsonb),
  public.form_templates_guard(),
  public.form_submissions_guard(),
  public.save_form_draft_v1(uuid, uuid, text, jsonb, uuid),
  public.submit_form_v1(uuid, uuid)
  from public, anon, authenticated;

grant execute on function
  public.save_form_draft_v1(uuid, uuid, text, jsonb, uuid),
  public.submit_form_v1(uuid, uuid)
  to authenticated;
