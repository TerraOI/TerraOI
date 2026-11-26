-- T-213 PR-1 — review queue, publish (F13) and revoke (F14).
-- Plan §7.2 steps 7–9, §7.5; docs/contracts/knowledge-and-jobs.md.
--
-- Does not consume T-104 derived-output invalidation (#178) or review_reclass_v1 (#21).
-- Tenant scope: every RPC takes p_organisation_id first and opens with set_tenant_scope (#163).
-- #60 / FAQ-0010: revoke EXECUTE by full signature, grant authenticated only; 001 allow-list in same PR.

-- ---------------------------------------------------------------- collection publication policy
alter table public.knowledge_collections
  add column if not exists review_independent boolean not null default false,
  add column if not exists auto_publish boolean not null default false;

comment on column public.knowledge_collections.review_independent is
  'When true, review_decision_v1 refuses the version''s uploaded_by (#8). Defaults on for client_confidential.';
comment on column public.knowledge_collections.auto_publish is
  'When true, low-risk notes (kind=note, public|internal) may publish without a prior approve decision (§7.2 step 7).';

-- Existing confidential corpora require independent review.
update public.knowledge_collections
   set review_independent = true
 where data_class = 'client_confidential'
   and review_independent = false;

create or replace function public.knowledge_collections_review_defaults()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.data_class = 'client_confidential' then
    new.review_independent := true;
  end if;
  return new;
end;
$$;

drop trigger if exists knowledge_collections_review_defaults on public.knowledge_collections;
create trigger knowledge_collections_review_defaults
  before insert or update of data_class on public.knowledge_collections
  for each row execute function public.knowledge_collections_review_defaults();

revoke all on function public.knowledge_collections_review_defaults() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- review decisions (append-only)
create table public.knowledge_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  source_version_id uuid not null,
  decision text not null check (decision in ('approve', 'reject')),
  reviewer_user_id uuid not null references public.profiles (id) on delete restrict,
  reason text check (reason is null or char_length(reason) between 1 and 500),
  decided_at timestamptz not null default now(),
  constraint knowledge_review_decisions_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint knowledge_review_decisions_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete cascade,
  unique (id, organisation_id),
  -- One decisive row per version: duplicate approve/reject is a no-op at the RPC, enforced here.
  unique (organisation_id, source_version_id)
);

comment on table public.knowledge_review_decisions is
  'Append-once review outcome for a source_version. Separation of duties uses uploaded_by on the version (#8).';

alter table public.knowledge_review_decisions enable row level security;

create policy knowledge_review_decisions_scoped_read on public.knowledge_review_decisions
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

revoke all on table public.knowledge_review_decisions from public, anon, authenticated;
grant select on table public.knowledge_review_decisions to authenticated;

-- ---------------------------------------------------------------- policy_revision on source lifecycle
create trigger knowledge_sources_bump_policy_rev_update
  after update on public.knowledge_sources
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();

create trigger source_versions_bump_policy_rev_update
  after update on public.source_versions
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();

-- ---------------------------------------------------------------- helpers (not granted)
-- Owner ruling on #267 B1 (2026-11-25, FAQ-0015): review, publish and revoke are their own
-- permission area. `knowledge.review` at write or above, or `knowledge.admin` at admin. Contributors
-- (`knowledge.write` only, FAQ-0006) capture but never publish.
create or replace function public.user_may_review_knowledge(p_organisation_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.organisation_memberships m
      join public.organisations o
        on o.id = m.organisation_id and o.status = 'active'
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and (   (rp.area = 'knowledge.review' and rp.level in ('write', 'admin'))
            or (rp.area = 'knowledge.admin' and rp.level = 'admin'))
     where m.organisation_id = p_organisation_id
       and m.user_id = auth.uid()
       and m.status = 'active'
  );
$$;

comment on function public.user_may_review_knowledge(uuid) is
  'Internal: active member holding knowledge.review at write|admin, or knowledge.admin at admin, may review/publish/revoke (FAQ-0015). knowledge.write alone never does (FAQ-0006).';

revoke all on function public.user_may_review_knowledge(uuid) from public, anon, authenticated, service_role;

-- The audience half (#267 B2): the collection is in the current tenant scope and, when it is
-- project-bound, the caller is a member of that project. Applies to every caller, knowledge.admin
-- included. Kept apart from user_may_publish_into because that predicate also demands
-- knowledge.write, which a reviewer need not hold.
create or replace function public.user_in_collection_audience(p_collection_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.knowledge_collections c
     where c.id = p_collection_id
       and c.organisation_id = public.current_organisation_id()
       and (c.project_id is null or public.is_project_member(c.project_id))
  );
$$;

comment on function public.user_in_collection_audience(uuid) is
  'Internal: collection is in the current tenant scope and, if project-bound, the caller is a project member (#267 B2).';

revoke all on function public.user_in_collection_audience(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- review_decision_v1
create or replace function public.review_decision_v1(
  p_organisation_id uuid,
  p_source_version_id uuid,
  p_decision text,
  p_reason text default null
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_version public.source_versions%rowtype;
  v_collection public.knowledge_collections%rowtype;
  v_existing uuid;
  v_existing_decision text;
  v_id uuid;
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
    raise exception 'not permitted to review knowledge' using errcode = '42501';
  end if;

  select * into v_version
    from public.source_versions
   where id = p_source_version_id
     and organisation_id = v_organisation;
  if not found then
    raise exception 'not permitted to review knowledge' using errcode = '42501';
  end if;
  if v_version.state <> 'awaiting_review' then
    raise exception 'version is not awaiting review' using errcode = '22023';
  end if;

  select * into v_collection
    from public.knowledge_collections
   where id = v_version.collection_id
     and organisation_id = v_organisation;
  if not found
     or not public.collection_is_readable(v_collection.id)
     or not public.user_in_collection_audience(v_collection.id) then
    raise exception 'not permitted to review knowledge' using errcode = '42501';
  end if;

  if v_collection.review_independent and v_version.uploaded_by = v_user then
    raise exception 'uploader cannot review their own version' using errcode = '42501';
  end if;

  select id, decision into v_existing, v_existing_decision
    from public.knowledge_review_decisions
   where organisation_id = v_organisation
     and source_version_id = p_source_version_id;
  if v_existing is not null then
    if v_existing_decision <> p_decision then
      -- #267 N2: a different second decision must not read as success.
      raise exception 'version already decided as %', v_existing_decision using errcode = '22023';
    end if;
    return v_existing; -- the same decision again is a no-op
  end if;

  insert into public.knowledge_review_decisions (
    organisation_id, source_version_id, decision, reviewer_user_id, reason
  ) values (
    v_organisation, p_source_version_id, p_decision, v_user, nullif(btrim(coalesce(p_reason, '')), '')
  ) returning id into v_id;

  if p_decision = 'reject' then
    update public.source_versions
       set state = 'failed',
           failure_note = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'rejected_in_review'),
           updated_at = now()
     where id = p_source_version_id
       and organisation_id = v_organisation
       and state = 'awaiting_review';
  end if;

  return v_id;
end;
$$;

comment on function public.review_decision_v1(uuid, uuid, text, text) is
  'F13 review: approve or reject an awaiting_review version. Independent collections refuse the uploader (#8).';

-- ---------------------------------------------------------------- publish_knowledge_version_v1
create or replace function public.publish_knowledge_version_v1(
  p_organisation_id uuid,
  p_source_version_id uuid
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_version public.source_versions%rowtype;
  v_collection public.knowledge_collections%rowtype;
  v_source public.knowledge_sources%rowtype;
  v_approved boolean;
  v_chunk_count int;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null or v_organisation is null or not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.user_may_review_knowledge(v_organisation) then
    raise exception 'not permitted to publish knowledge' using errcode = '42501';
  end if;

  -- #267 B5: take the source row first, FOR UPDATE, so two publishes of versions of one source
  -- (this RPC, or this RPC racing the worker switch in chunk_publish, which locks the same row)
  -- serialize. The version is read after the lock so its state is the committed one.
  select s.* into v_source
    from public.knowledge_sources s
    join public.source_versions v
      on v.source_id = s.id and v.organisation_id = s.organisation_id
   where v.id = p_source_version_id
     and s.organisation_id = v_organisation
     for update of s;
  if not found or v_source.lifecycle_state <> 'active' then
    raise exception 'not permitted to publish knowledge' using errcode = '42501';
  end if;

  select * into v_version
    from public.source_versions
   where id = p_source_version_id
     and organisation_id = v_organisation;
  if not found then
    raise exception 'not permitted to publish knowledge' using errcode = '42501';
  end if;

  select * into v_collection
    from public.knowledge_collections
   where id = v_version.collection_id
     and organisation_id = v_organisation;
  if not found or not public.user_in_collection_audience(v_collection.id) then
    raise exception 'not permitted to publish knowledge' using errcode = '42501';
  end if;

  if v_version.state = 'published' then
    return v_version.id; -- idempotent
  end if;
  if v_version.state <> 'awaiting_review' then
    raise exception 'version is not publishable' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.knowledge_review_decisions d
     where d.organisation_id = v_organisation
       and d.source_version_id = p_source_version_id
       and d.decision = 'approve'
  ) into v_approved;

  if not v_approved then
    if not (
      v_collection.auto_publish
      and v_source.kind = 'note'
      and v_version.data_class in ('public', 'internal')
    ) then
      raise exception 'version requires an approve decision before publish' using errcode = '22023';
    end if;
  end if;

  select count(*)::int into v_chunk_count
    from public.knowledge_chunks c
   where c.source_version_id = p_source_version_id
     and c.organisation_id = v_organisation;
  if v_chunk_count < 1 then
    raise exception 'version embedding is incomplete' using errcode = '22023';
  end if;

  -- Supersede any prior published version of this source.
  update public.source_versions
     set state = 'superseded',
         updated_at = now()
   where organisation_id = v_organisation
     and source_id = v_version.source_id
     and state = 'published'
     and id <> p_source_version_id;

  update public.source_versions
     set state = 'published',
         published_at = coalesce(published_at, now()),
         updated_at = now()
   where id = p_source_version_id
     and organisation_id = v_organisation;

  update public.knowledge_sources
     set current_version_id = p_source_version_id,
         updated_at = now()
   where id = v_version.source_id
     and organisation_id = v_organisation;

  return p_source_version_id;
end;
$$;

comment on function public.publish_knowledge_version_v1(uuid, uuid) is
  'F13: atomically publish an awaiting_review version (approved or auto_publish note) and supersede the prior published pointer.';

-- ---------------------------------------------------------------- revoke_source_v1
create or replace function public.revoke_source_v1(
  p_organisation_id uuid,
  p_source_id uuid,
  p_reason text default null
) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_source public.knowledge_sources%rowtype;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null or v_organisation is null or not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.user_may_review_knowledge(v_organisation) then
    raise exception 'not permitted to revoke knowledge' using errcode = '42501';
  end if;

  select * into v_source
    from public.knowledge_sources
   where id = p_source_id
     and organisation_id = v_organisation
     for update;
  -- #267 B2: the same audience rule as review and publish. A permitted user outside a project
  -- cannot revoke that project's sources.
  if not found or not public.user_in_collection_audience(v_source.collection_id) then
    raise exception 'not permitted to revoke knowledge' using errcode = '42501';
  end if;
  if v_source.lifecycle_state = 'revoked' then
    return; -- idempotent
  end if;
  if v_source.lifecycle_state = 'deleted' then
    raise exception 'source is deleted' using errcode = '22023';
  end if;

  update public.source_versions
     set state = case when state in ('published', 'awaiting_review', 'indexing', 'extracting', 'validating', 'received')
                      then 'revoked' else state end,
         revoked_at = coalesce(revoked_at, now()),
         failure_note = coalesce(failure_note, nullif(btrim(coalesce(p_reason, '')), ''), 'revoked'),
         updated_at = now()
   where organisation_id = v_organisation
     and source_id = p_source_id
     and state not in ('revoked', 'deleting', 'deleted', 'superseded');

  update public.knowledge_sources
     set lifecycle_state = 'revoked',
         revoked_at = coalesce(revoked_at, now()),
         current_version_id = null,
         updated_at = now()
   where id = p_source_id
     and organisation_id = v_organisation;

  -- Abort in-flight jobs for this source's versions (cannot republish).
  update public.ingestion_jobs j
     set status = 'failed',
         last_error = 'source_revoked',
         lease_token = null,
         lease_expires_at = null,
         updated_at = now()
   where j.organisation_id = v_organisation
     and j.source_version_id in (
       select v.id from public.source_versions v
        where v.source_id = p_source_id and v.organisation_id = v_organisation
     )
     and j.status in ('queued', 'leased', 'running');
end;
$$;

comment on function public.revoke_source_v1(uuid, uuid, text) is
  'F14: revoke a source — retrieval blocked by lifecycle/state; in-flight jobs fail closed.';

-- ---------------------------------------------------------------- privileges (FAQ-0010)
revoke all on function public.review_decision_v1(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.publish_knowledge_version_v1(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.revoke_source_v1(uuid, uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.review_decision_v1(uuid, uuid, text, text) to authenticated;
grant execute on function public.publish_knowledge_version_v1(uuid, uuid) to authenticated;
grant execute on function public.revoke_source_v1(uuid, uuid, text) to authenticated;
