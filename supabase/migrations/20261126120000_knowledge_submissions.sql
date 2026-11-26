-- T-302b PR-1: knowledge_submissions + submit/review/withdraw RPCs (F15, #73).
-- Consumes T-213 review/publish (#267). Does not consume T-104 agent_runs FK (#178):
-- agent_run_id is an opaque uuid with no FK until chat tables exist.
-- Tenant scope: every RPC takes p_organisation_id first and opens with set_tenant_scope (#163).
-- #60 / FAQ-0010: revoke EXECUTE by full signature, grant authenticated only; 001 allow-list in same PR.

-- ---------------------------------------------------------------- table
create table public.knowledge_submissions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  collection_id uuid not null,
  -- Copied from the collection at submit so a later project remapping cannot widen audience.
  project_id uuid,
  author_user_id uuid not null,
  reviewer_user_id uuid,
  kind text not null check (kind in ('note', 'answer', 'correction')),
  proposed_text text not null check (char_length(proposed_text) between 1 and 200000),
  data_class text not null,
  -- Opaque until T-104 / #178 lands agent_runs; never trusted as authorization.
  agent_run_id uuid,
  cited_source_version_ids uuid[] not null default '{}'::uuid[],
  state text not null default 'submitted'
    check (state in ('submitted', 'approved', 'rejected', 'withdrawn')),
  review_reason text check (review_reason is null or char_length(review_reason) between 1 and 2000),
  review_by timestamptz,
  reviewed_at timestamptz,
  source_id uuid,
  source_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_submissions_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint knowledge_submissions_collection_fk
    foreign key (collection_id, organisation_id)
    references public.knowledge_collections (id, organisation_id) on delete restrict,
  constraint knowledge_submissions_project_fk
    foreign key (project_id, organisation_id)
    references public.projects (id, organisation_id) on delete restrict,
  constraint knowledge_submissions_author_fk
    foreign key (author_user_id) references public.profiles (id) on delete restrict,
  constraint knowledge_submissions_reviewer_fk
    foreign key (reviewer_user_id) references public.profiles (id) on delete restrict,
  constraint knowledge_submissions_source_fk
    foreign key (source_id, organisation_id)
    references public.knowledge_sources (id, organisation_id) on delete restrict,
  constraint knowledge_submissions_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete restrict,
  constraint knowledge_submissions_data_class_is_valid
    check (public.data_class_is_valid(data_class)),
  constraint knowledge_submissions_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  constraint knowledge_submissions_tenant_id_key unique (id, organisation_id),
  constraint knowledge_submissions_capture_markers check (
    (state <> 'approved' and source_id is null and source_version_id is null and reviewed_at is null
      and reviewer_user_id is null)
    or (state = 'approved' and source_id is not null and source_version_id is not null
      and reviewed_at is not null and reviewer_user_id is not null)
    or (state in ('rejected', 'withdrawn') and source_id is null and source_version_id is null
      and reviewed_at is not null)
  )
);

comment on table public.knowledge_submissions is
  'F15 employee knowledge capture: a proposal, never a source. Approval promotes through the normal note pipeline (T-213).';
comment on column public.knowledge_submissions.agent_run_id is
  'Opaque provenance until T-104 agent_runs exists (#178); not an authorization input.';
comment on column public.knowledge_submissions.data_class is
  'Highest class among cited versions and the conversation context (§6.2); never lowered.';

create index knowledge_submissions_tenant_state_idx
  on public.knowledge_submissions (organisation_id, state, created_at desc);
create index knowledge_submissions_author_idx
  on public.knowledge_submissions (organisation_id, author_user_id, created_at desc);

create or replace function public.knowledge_submissions_touch()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger knowledge_submissions_touch
  before update on public.knowledge_submissions
  for each row execute function public.knowledge_submissions_touch();

alter table public.knowledge_submissions enable row level security;

-- Author can always see their own proposals.
create policy knowledge_submissions_author_read on public.knowledge_submissions
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and author_user_id = auth.uid()
  );

-- Reviewers can see open proposals in collections they can read.
-- Permission is inlined (same predicate as user_may_review_knowledge): that helper is revoked from
-- authenticated, and RLS expressions run as the request role, so a call would 42501 (#60).
-- FAQ-0015 (owner ruling on #267): knowledge.review at write|admin, or knowledge.admin at admin.
-- knowledge.write alone is capture, never review (FAQ-0006), so a contributor sees only their own.
create policy knowledge_submissions_reviewer_read on public.knowledge_submissions
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and state = 'submitted'
    and public.collection_is_readable(collection_id)
    and exists (
      select 1
        from public.organisation_memberships m
        join public.membership_roles mr on mr.membership_id = m.id
        join public.role_permissions rp
          on rp.role_id = mr.role_id
         and rp.organisation_id = m.organisation_id
         and (   (rp.area = 'knowledge.review' and rp.level in ('write', 'admin'))
              or (rp.area = 'knowledge.admin' and rp.level = 'admin'))
       where m.organisation_id = knowledge_submissions.organisation_id
         and m.user_id = auth.uid()
         and m.status = 'active'
    )
  );

revoke all on public.knowledge_submissions from anon, authenticated;
grant select on public.knowledge_submissions to authenticated;

-- ---------------------------------------------------------------- submit_employee_knowledge_v1
create or replace function public.submit_employee_knowledge_v1(
  p_organisation_id uuid,
  p_collection_id uuid,
  p_kind text,
  p_proposed_text text,
  p_context_data_class text,
  p_cited_source_version_ids uuid[] default '{}'::uuid[],
  p_agent_run_id uuid default null,
  p_review_by timestamptz default null
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_collection public.knowledge_collections%rowtype;
  v_cited uuid;
  v_version public.source_versions%rowtype;
  v_rank int;
  v_max_rank int;
  v_class text;
  v_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null or v_organisation is null or not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('note', 'answer', 'correction') then
    raise exception 'kind must be note, answer or correction' using errcode = '22023';
  end if;
  if p_proposed_text is null or char_length(btrim(p_proposed_text)) < 1
     or char_length(p_proposed_text) > 200000 then
    raise exception 'proposed text is required' using errcode = '22023';
  end if;
  if p_context_data_class is null or not public.data_class_is_valid(p_context_data_class)
     or not public.data_class_is_ingestible_in_m1(p_context_data_class) then
    raise exception 'context data class is invalid' using errcode = '22023';
  end if;

  select * into v_collection
    from public.knowledge_collections
   where id = p_collection_id
     and organisation_id = v_organisation;
  if not found or not public.collection_is_readable(v_collection.id) then
    raise exception 'collection is not readable' using errcode = '42501';
  end if;

  v_max_rank := public.data_class_rank(p_context_data_class);
  v_class := p_context_data_class;

  if p_cited_source_version_ids is not null then
    foreach v_cited in array p_cited_source_version_ids loop
      select * into v_version
        from public.source_versions
       where id = v_cited
         and organisation_id = v_organisation;
      if not found or not public.source_version_is_readable(v_cited) then
        raise exception 'a cited source version is not readable' using errcode = '42501';
      end if;
      v_rank := public.data_class_rank(v_version.data_class);
      if v_rank > v_max_rank then
        v_max_rank := v_rank;
        v_class := v_version.data_class;
      end if;
    end loop;
  end if;

  -- Target collection must clear the inherited class (§6.2): never land higher-class text in a
  -- lower-class corpus.
  if public.data_class_rank(v_collection.data_class) < v_max_rank then
    raise exception 'collection does not clear the submission data class' using errcode = '23514';
  end if;

  insert into public.knowledge_submissions (
    organisation_id, collection_id, project_id, author_user_id, kind, proposed_text,
    data_class, agent_run_id, cited_source_version_ids, state, review_by
  ) values (
    v_organisation, v_collection.id, v_collection.project_id, v_user, p_kind,
    p_proposed_text, v_class, p_agent_run_id,
    coalesce(p_cited_source_version_ids, '{}'::uuid[]), 'submitted', p_review_by
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.submit_employee_knowledge_v1(uuid, uuid, text, text, text, uuid[], uuid, timestamptz) is
  'F15: create a knowledge_submissions row. Class is max(context, cited versions); collection must clear it. No knowledge.write required (#39).';

-- ---------------------------------------------------------------- review_knowledge_submission_v1
create or replace function public.review_knowledge_submission_v1(
  p_organisation_id uuid,
  p_submission_id uuid,
  p_decision text,
  p_reason text default null
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_submission public.knowledge_submissions%rowtype;
  v_collection public.knowledge_collections%rowtype;
  v_hash text;
  v_source_id uuid;
  v_version_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null or v_organisation is null or not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject' using errcode = '22023';
  end if;
  if not public.user_may_review_knowledge(v_organisation) then
    raise exception 'not permitted to review knowledge submissions' using errcode = '42501';
  end if;

  select * into v_submission
    from public.knowledge_submissions
   where id = p_submission_id
     and organisation_id = v_organisation
   for update;
  if not found then
    raise exception 'no such submission' using errcode = 'P0002';
  end if;
  if v_submission.state <> 'submitted' then
    -- Duplicate review is a no-op refusal: never a second source (#73 / acceptance).
    raise exception 'submission is no longer awaiting review' using errcode = '22023';
  end if;
  if v_submission.author_user_id = v_user then
    raise exception 'author cannot review their own submission' using errcode = '42501';
  end if;
  if not public.collection_is_readable(v_submission.collection_id) then
    raise exception 'collection is not readable' using errcode = '42501';
  end if;

  if p_decision = 'reject' then
    update public.knowledge_submissions
       set state = 'rejected',
           reviewer_user_id = v_user,
           review_reason = nullif(btrim(coalesce(p_reason, '')), ''),
           reviewed_at = now()
     where id = p_submission_id
       and organisation_id = v_organisation;
    return p_submission_id;
  end if;

  select * into v_collection
    from public.knowledge_collections
   where id = v_submission.collection_id
     and organisation_id = v_organisation;

  -- Re-check clearance at approve time (class may not have changed, but collection rules can).
  if public.data_class_rank(v_collection.data_class) < public.data_class_rank(v_submission.data_class) then
    raise exception 'collection does not clear the submission data class' using errcode = '23514';
  end if;

  v_hash := encode(extensions.digest(convert_to(v_submission.proposed_text, 'utf8'), 'sha256'), 'hex');

  insert into public.knowledge_sources (
    organisation_id, collection_id, kind, external_id, owner_user_id
  ) values (
    v_organisation, v_submission.collection_id, 'note',
    'knowledge_submission/' || p_submission_id::text, v_submission.author_user_id
  )
  returning id into v_source_id;

  insert into public.source_versions (
    organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
    content_hash, object_ref, state, parser_generation, body_text, payload
  ) values (
    v_organisation, v_source_id, v_submission.collection_id, 1,
    -- uploaded_by is the author (server-set provenance for T-213 independence), not the reviewer.
    v_submission.author_user_id,
    v_submission.data_class, v_hash,
    'knowledge/submissions/' || v_organisation::text || '/' || p_submission_id::text || '.json',
    'received', 'v1', v_submission.proposed_text,
    jsonb_build_object(
      'submission_id', p_submission_id,
      'kind', v_submission.kind,
      'agent_run_id', v_submission.agent_run_id,
      'cited_source_version_ids', to_jsonb(v_submission.cited_source_version_ids),
      -- §7.4: promoted answers are never independent corroboration of the sources they cited.
      'independent_corroboration', false
    )
  )
  returning id into v_version_id;

  update public.knowledge_submissions
     set state = 'approved',
         reviewer_user_id = v_user,
         review_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         reviewed_at = now(),
         source_id = v_source_id,
         source_version_id = v_version_id
   where id = p_submission_id
     and organisation_id = v_organisation;

  return p_submission_id;
exception
  when unique_violation then
    raise exception 'an identical note is already in this collection' using errcode = '22023';
end;
$$;

comment on function public.review_knowledge_submission_v1(uuid, uuid, text, text) is
  'F15 review: approve promotes a note into the normal pipeline; reject closes without a source. Author may not decide (#8).';

-- ---------------------------------------------------------------- withdraw_knowledge_submission_v1
create or replace function public.withdraw_knowledge_submission_v1(
  p_organisation_id uuid,
  p_submission_id uuid
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_submission public.knowledge_submissions%rowtype;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null or v_organisation is null or not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;

  select * into v_submission
    from public.knowledge_submissions
   where id = p_submission_id
     and organisation_id = v_organisation
   for update;
  if not found then
    raise exception 'no such submission' using errcode = 'P0002';
  end if;
  if v_submission.author_user_id <> v_user then
    raise exception 'only the author may withdraw a submission' using errcode = '42501';
  end if;
  if v_submission.state <> 'submitted' then
    raise exception 'submission is no longer withdrawable' using errcode = '22023';
  end if;

  update public.knowledge_submissions
     set state = 'withdrawn',
         reviewed_at = now()
   where id = p_submission_id
     and organisation_id = v_organisation;

  return p_submission_id;
end;
$$;

comment on function public.withdraw_knowledge_submission_v1(uuid, uuid) is
  'F15: author withdraws an open submission; no source is created.';

-- ---------------------------------------------------------------- privileges (FAQ-0010)
revoke all on function public.knowledge_submissions_touch() from public, anon, authenticated, service_role;
revoke all on function public.submit_employee_knowledge_v1(uuid, uuid, text, text, text, uuid[], uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.review_knowledge_submission_v1(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.withdraw_knowledge_submission_v1(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.submit_employee_knowledge_v1(uuid, uuid, text, text, text, uuid[], uuid, timestamptz)
  to authenticated;
grant execute on function public.review_knowledge_submission_v1(uuid, uuid, text, text)
  to authenticated;
grant execute on function public.withdraw_knowledge_submission_v1(uuid, uuid)
  to authenticated;
