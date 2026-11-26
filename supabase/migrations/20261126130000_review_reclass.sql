-- T-213 PR-3: review_reclass_v1 — atomic data-class raise cascade (#21 option A).
-- Consumes review/publish SQL (#267). Does not consume T-104 derived rows (#178).
-- Tenant scope: p_organisation_id first + set_tenant_scope (#163). FAQ-0010 privileges.

-- ---------------------------------------------------------------- audit (append-only)
create table public.knowledge_reclass_audits (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  collection_id uuid not null,
  reviewer_user_id uuid not null references public.profiles (id) on delete restrict,
  old_data_class text not null,
  new_data_class text not null,
  versions_raised integer not null check (versions_raised >= 0),
  chunks_raised integer not null check (chunks_raised >= 0),
  artifacts_raised integer not null check (artifacts_raised >= 0),
  embeddings_removed integer not null check (embeddings_removed >= 0),
  decided_at timestamptz not null default now(),
  constraint knowledge_reclass_audits_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint knowledge_reclass_audits_collection_fk
    foreign key (collection_id, organisation_id)
    references public.knowledge_collections (id, organisation_id) on delete restrict,
  constraint knowledge_reclass_audits_old_class_valid
    check (public.data_class_is_valid(old_data_class)),
  constraint knowledge_reclass_audits_new_class_valid
    check (public.data_class_is_valid(new_data_class)),
  unique (id, organisation_id)
);

comment on table public.knowledge_reclass_audits is
  'One row per successful review_reclass_v1: old/new class and descendant counts (#21).';

create index knowledge_reclass_audits_tenant_idx
  on public.knowledge_reclass_audits (organisation_id, decided_at desc);

alter table public.knowledge_reclass_audits enable row level security;

-- Only members who can read the collection see its reclass history (supervisor round 1 on #271):
-- a project collection's id and descendant counts are not tenant-wide information.
create policy knowledge_reclass_audits_scoped_read on public.knowledge_reclass_audits
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and public.collection_is_readable(collection_id)
  );

revoke all on public.knowledge_reclass_audits from anon, authenticated;
grant select on public.knowledge_reclass_audits to authenticated;

-- ---------------------------------------------------------------- extraction_artifacts: allow class raise
-- ADR-0005 made artifacts insert-only for content. #21 needs a data_class raise in the same
-- transaction as the collection reclass; content columns stay immutable.
create or replace function public.extraction_artifacts_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $fn$
declare
  v_class text;
begin
  if tg_op = 'INSERT' then
    select data_class into v_class from public.source_versions where id = new.source_version_id;
    if v_class is null then
      raise exception 'unknown source version for extraction artifact' using errcode = '23514';
    end if;
    if public.data_class_rank(new.data_class) < public.data_class_rank(v_class) then
      raise exception 'extraction artifact class % is below its version class %',
        new.data_class, v_class using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE: only a raise of data_class (review_reclass_v1 / #21). Everything else stays insert-only.
  if new.id is distinct from old.id
     or new.organisation_id is distinct from old.organisation_id
     or new.source_version_id is distinct from old.source_version_id
     or new.job_id is distinct from old.job_id
     or new.stage is distinct from old.stage
     or new.parser_generation is distinct from old.parser_generation
     or new.index_generation is distinct from old.index_generation
     or new.artifact_index is distinct from old.artifact_index
     or new.locator is distinct from old.locator
     or new.body_text is distinct from old.body_text
     or new.confidence is distinct from old.confidence
     or new.notes is distinct from old.notes
     or new.producer is distinct from old.producer
     or new.fence is distinct from old.fence
     or new.created_at is distinct from old.created_at
  then
    raise exception 'extraction artifacts are insert-only; a correction is a new artifact set'
      using errcode = '23514';
  end if;
  if public.data_class_rank(new.data_class) < public.data_class_rank(old.data_class) then
    raise exception 'extraction artifact data class may be raised but never lowered (§6.2)'
      using errcode = '23514';
  end if;
  select data_class into v_class from public.source_versions where id = new.source_version_id;
  if v_class is not null
     and public.data_class_rank(new.data_class) < public.data_class_rank(v_class) then
    raise exception 'extraction artifact class % is below its version class %',
      new.data_class, v_class using errcode = '23514';
  end if;
  return new;
end;
$fn$;

comment on function public.extraction_artifacts_guard() is
  'Insert validates class vs version; updates may only raise data_class for review_reclass_v1 (#21).';

revoke execute on function public.extraction_artifacts_guard()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- review_reclass_v1
create or replace function public.review_reclass_v1(
  p_organisation_id uuid,
  p_collection_id uuid,
  p_new_data_class text
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_collection public.knowledge_collections%rowtype;
  v_old text;
  v_versions int := 0;
  v_chunks int := 0;
  v_artifacts int := 0;
  v_embeddings int := 0;
  v_audit uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null or v_organisation is null or not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.user_may_review_knowledge(v_organisation) then
    raise exception 'not permitted to reclass knowledge' using errcode = '42501';
  end if;
  if p_new_data_class is null or not public.data_class_is_valid(p_new_data_class) then
    raise exception 'new data class is invalid' using errcode = '22023';
  end if;
  -- #21 constraint 2: restricted is not ingestible in M1 — revoke instead.
  if p_new_data_class = 'restricted' or not public.data_class_is_ingestible_in_m1(p_new_data_class) then
    raise exception 'raising to restricted is refused in M1; revoke the sources instead'
      using errcode = '23514';
  end if;

  select * into v_collection
    from public.knowledge_collections
   where id = p_collection_id
     and organisation_id = v_organisation
   for update;
  if not found then
    raise exception 'no such collection' using errcode = 'P0002';
  end if;
  -- #267 B2 / FAQ-0015: the project-audience check applies on top of the permission for every
  -- caller, knowledge.admin included. A reviewer outside a project cannot reclass its collection.
  if not public.user_in_collection_audience(p_collection_id) then
    raise exception 'not permitted to reclass this collection' using errcode = '42501';
  end if;

  v_old := v_collection.data_class;
  if public.data_class_rank(p_new_data_class) < public.data_class_rank(v_old) then
    raise exception 'a collection data class may be raised but never lowered' using errcode = '23514';
  end if;
  if public.data_class_rank(p_new_data_class) = public.data_class_rank(v_old) then
    -- Idempotent no-op: return a fresh audit id is wrong; refuse with 22023 like duplicate review.
    raise exception 'collection already has this data class' using errcode = '22023';
  end if;
  -- #21 constraint 3: tenant-wide → client_confidential is refused (CHECK + immutable project_id).
  if p_new_data_class = 'client_confidential' and v_collection.project_id is null then
    raise exception 'tenant-wide collections cannot become client_confidential; create a project-scoped collection and re-capture'
      using errcode = '23514';
  end if;

  update public.knowledge_collections
     set data_class = p_new_data_class,
         review_independent = case
           when p_new_data_class = 'client_confidential' then true
           else review_independent
         end,
         updated_at = now()
   where id = p_collection_id
     and organisation_id = v_organisation;

  update public.source_versions v
     set data_class = p_new_data_class,
         updated_at = now()
   where v.organisation_id = v_organisation
     and v.collection_id = p_collection_id
     and public.data_class_rank(v.data_class) < public.data_class_rank(p_new_data_class);
  get diagnostics v_versions = row_count;

  update public.knowledge_chunks c
     set data_class = p_new_data_class
    from public.source_versions v
   where c.source_version_id = v.id
     and c.organisation_id = v_organisation
     and v.organisation_id = v_organisation
     and v.collection_id = p_collection_id
     and public.data_class_rank(c.data_class) < public.data_class_rank(p_new_data_class);
  get diagnostics v_chunks = row_count;

  update public.extraction_artifacts a
     set data_class = p_new_data_class
    from public.source_versions v
   where a.source_version_id = v.id
     and a.organisation_id = v_organisation
     and v.organisation_id = v_organisation
     and v.collection_id = p_collection_id
     and public.data_class_rank(a.data_class) < public.data_class_rank(p_new_data_class);
  get diagnostics v_artifacts = row_count;

  -- #21 constraint 4 / E2: drop vectors whose index does not clear the new class.
  with doomed as (
    select e.id
      from public.chunk_embeddings e
      join public.knowledge_chunks c on c.id = e.chunk_id and c.organisation_id = e.organisation_id
      join public.source_versions v on v.id = c.source_version_id and v.organisation_id = c.organisation_id
      join public.embedding_indexes i on i.id = e.index_id and i.organisation_id = e.organisation_id
     where e.organisation_id = v_organisation
       and v.collection_id = p_collection_id
       and not (i.cleared_for @> array[p_new_data_class]::text[])
  )
  delete from public.chunk_embeddings e
   using doomed d
   where e.id = d.id;
  get diagnostics v_embeddings = row_count;

  insert into public.knowledge_reclass_audits (
    organisation_id, collection_id, reviewer_user_id,
    old_data_class, new_data_class,
    versions_raised, chunks_raised, artifacts_raised, embeddings_removed
  ) values (
    v_organisation, p_collection_id, v_user,
    v_old, p_new_data_class,
    v_versions, v_chunks, v_artifacts, v_embeddings
  )
  returning id into v_audit;

  return v_audit;
end;
$$;

comment on function public.review_reclass_v1(uuid, uuid, text) is
  'F13/#21: raise a collection data class and every descendant below it in one transaction; E2 drops uncleared vectors.';

revoke all on function public.review_reclass_v1(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_reclass_v1(uuid, uuid, text) to authenticated;
