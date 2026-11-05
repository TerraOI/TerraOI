-- T-111 Migration 0002: knowledge core — collections, sources, immutable source versions,
-- chunks, pinned embedding-index generations, ingestion jobs and the transactional outbox.
-- Plan §6.1, §6.2, §7.2, §7.5, §8.3, §12.4; F08, F10, F12, F13, F14.
-- SQL mirror of src/contracts/data-class.ts, src/contracts/provider-route.ts
-- (EmbeddingIndex, M1_MAX_INGESTION_CLASS, isIngestibleInM1) and
-- src/contracts/ingestion-job.ts (stages, executors, stage idempotency key).
--
-- Invariants encoded here, on top of the ones in 20261105060000_tenancy_core.sql:
--   * every knowledge row carries a non-null organisation_id and is reachable only through a
--     composite (id, organisation_id) key, so a chunk, job or embedding can never point at
--     another tenant's source version (plan §6.2);
--   * content identity is tenant-scoped: unique (organisation_id, content_hash) — deduplication
--     inside a tenant, and no cross-tenant deduplication side channel (§6.2);
--   * every collection, source version, chunk and job carries a data class, `restricted` is
--     refused in M1 (the SQL mirror of isIngestibleInM1, §12.4/§15.0) and a
--     client_confidential collection is always project-scoped (§6.2);
--   * a captured source version is immutable: corrections create a new version (§7.2). Only
--     lifecycle state, review/revocation markers and a *raised* data class may change;
--   * derived rows never carry a lower class than what they came from (§6.2, AGENTS.md §4.4);
--   * capture commits the source version and its outbox event in one transaction (§7.2 step 1);
--   * an embedding index generation pins provider/model/dimensions/metric/generation with no
--     fallback, and only one generation per tenant index is active at a time (§8.3, TOI-ADR-13);
--   * RLS is enabled (not forced) on every table, every policy requires active membership and,
--     on the scoped read path, the transaction's tenant, plus project audience where the
--     collection is project-scoped; every SECURITY DEFINER function pins search_path.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------- data-class helpers
/**
 * The four data classes of plan §6.2 / src/contracts/data-class.ts, spelled once here so a
 * column CHECK and the drift tests agree with the TypeScript enum.
 */
create or replace function public.data_class_is_valid(p_data_class text)
returns boolean language sql immutable strict set search_path = public, pg_temp as $$
  select p_data_class in ('public', 'internal', 'client_confidential', 'restricted');
$$;

/** Rank of the class; null for an unknown value so a comparison can never silently pass. */
create or replace function public.data_class_rank(p_data_class text)
returns integer language sql immutable strict set search_path = public, pg_temp as $$
  select case p_data_class
    when 'public' then 0
    when 'internal' then 1
    when 'client_confidential' then 2
    when 'restricted' then 3
    else null
  end;
$$;

/**
 * M1 cut: `restricted` content is not ingested at all (plan §12.4, §15.0). Mirrors
 * isIngestibleInM1 / M1_MAX_INGESTION_CLASS = 'client_confidential' in
 * src/contracts/provider-route.ts; 020_knowledge.test.sql fails if the two ever drift.
 * Lifting it needs an ADR, so it is a CHECK here and not a flag.
 */
create or replace function public.data_class_is_ingestible_in_m1(p_data_class text)
returns boolean language sql immutable strict set search_path = public, pg_temp as $$
  select coalesce(public.data_class_rank(p_data_class), -1)
         <= public.data_class_rank('client_confidential');
$$;

-- ---------------------------------------------------------------- knowledge ownership
create table public.knowledge_collections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  -- Stable, tenant-scoped handle for later binding tables (tenant_services, T-121).
  key text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  -- Services are not a table yet; the key is validated against ServiceKey in
  -- src/contracts/keys.ts, and the composite FK to an enabled tenant service lands with T-121.
  service_key text not null check (service_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- null audience = tenant-wide; non-null = the named project only (plan §1.1, §6.2).
  project_id uuid,
  name text not null check (char_length(name) between 1 and 200),
  data_class text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_collections_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  -- Composite FK: a collection can never be scoped to another tenant's project.
  -- RESTRICT, not cascade: a project that still anchors collections has to be archived or its
  -- collections moved first, so dropping a project can never silently widen or destroy a
  -- corpus. Tenant teardown removes knowledge rows before projects (§6.1 deletion order).
  constraint knowledge_collections_project_fk
    foreign key (project_id, organisation_id)
    references public.projects (id, organisation_id) on delete restrict,
  constraint knowledge_collections_data_class_is_valid
    check (public.data_class_is_valid(data_class)),
  constraint knowledge_collections_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  -- client_confidential must be project-scoped in M1 (plan §6.2).
  constraint knowledge_collections_confidential_requires_project
    check (data_class <> 'client_confidential' or project_id is not null),
  unique (id, organisation_id),
  unique (organisation_id, key),
  unique (organisation_id, service_key, name)
);
comment on table public.knowledge_collections is
  'A corpus with one data class and one audience (tenant-wide or project). Sources inherit the class; it can be raised by a reviewer, never lowered (§6.2).';
comment on column public.knowledge_collections.project_id is
  'Audience boundary. A non-null project narrows visibility to that project''s members; client_confidential requires it (§6.2).';

create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  collection_id uuid not null,
  kind text not null check (kind in ('upload', 'note', 'form_submission', 'connector')),
  -- Connector-side identity. Tenant-scoped unique, so two tenants may share an external id
  -- without learning anything about each other (§6.2).
  external_id text check (external_id is null or char_length(external_id) between 1 and 200),
  owner_user_id uuid references public.profiles (id) on delete set null,
  -- The version retrieval should use. Set only by the publish path (F13); a trigger below
  -- requires it to be a version of this same source. The composite FK is added after
  -- source_versions exists (the two tables reference each other on purpose: a source names its
  -- current version, a version names its source).
  current_version_id uuid,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in ('active', 'revoked', 'deleted')),
  revoked_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_sources_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint knowledge_sources_collection_fk
    foreign key (collection_id, organisation_id)
    references public.knowledge_collections (id, organisation_id) on delete restrict,
  constraint knowledge_sources_revoked_marker check (revoked_at is null or lifecycle_state <> 'active'),
  constraint knowledge_sources_deleted_marker check (deleted_at is null or lifecycle_state = 'deleted'),
  unique (id, organisation_id),
  unique (organisation_id, collection_id, external_id)
);
comment on table public.knowledge_sources is
  'A logical document or note inside one collection: stable identity, owner, current published version, revoked/deleted state (F13, F14).';

create table public.source_versions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  source_id uuid not null,
  version_number integer not null check (version_number > 0),
  data_class text not null,
  -- Lowercase hex sha-256 of the accepted object, verified at capture (F10).
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Server-issued private object key, never a URL and never caller-chosen (F09/F10, §7.2).
  -- Shape by regex, length by char_length: Postgres bounds a repetition count at 255, so
  -- `{2,509}` here is a syntax error (`invalid repetition count(s)`) rather than a long match.
  object_ref text not null check (
    object_ref ~ '^knowledge/[a-z0-9][a-z0-9/_.-]*$'
    and char_length(object_ref) between 12 and 512
    and object_ref not like '%//%'
    and object_ref not like '%../%'
  ),
  -- The visible state set of plan §7.2 / docs/contracts/knowledge-and-jobs.md.
  state text not null default 'received'
    check (state in ('received', 'validating', 'extracting', 'indexing', 'awaiting_review',
                     'published', 'quarantined', 'failed', 'superseded', 'revoked',
                     'deleting', 'deleted')),
  parser_generation text not null default 'v1'
    check (parser_generation ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- Structured values (form submissions, extraction warnings, OCR confidence): metadata only.
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  -- Extracted or rendered text for lexical retrieval; null until extraction has run (F12/F32).
  body_text text check (body_text is null or char_length(body_text) between 1 and 200000),
  failure_note text check (failure_note is null or char_length(failure_note) between 1 and 500),
  published_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_versions_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint source_versions_source_fk
    foreign key (source_id, organisation_id)
    references public.knowledge_sources (id, organisation_id) on delete cascade,
  constraint source_versions_data_class_is_valid
    check (public.data_class_is_valid(data_class)),
  constraint source_versions_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  constraint source_versions_published_marker
    check (published_at is null or state in ('published', 'superseded', 'revoked', 'deleting', 'deleted')),
  unique (id, organisation_id),
  unique (organisation_id, source_id, version_number),
  -- Within-tenant content deduplication (§7.2 step 4). No global hash uniqueness: that would
  -- be a cross-tenant side channel (§6.2).
  unique (organisation_id, content_hash)
);
comment on table public.source_versions is
  'Immutable captured version: hash, object ref, state machine, parser generation and extracted text. A correction is a new row (§7.2).';
comment on column public.source_versions.object_ref is
  'Private storage key issued by the server. No signed URLs, no tokens: the job API issues a short-lived URL when a worker asks (§13).';

-- Circular by design: a source names its current version and a version names its source. The
-- composite key keeps the pointer inside one tenant; knowledge_sources_guard requires that it
-- is a version of that same source (F13).
alter table public.knowledge_sources
  add constraint knowledge_sources_current_version_fk
  foreign key (current_version_id, organisation_id)
  references public.source_versions (id, organisation_id) on delete set null;

-- ---------------------------------------------------------------- retrieval
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  source_version_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  -- page/section/table/row locators and OCR confidence (F12, F32). Shape-checked, not free text.
  locator jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(locator) = 'object'
      and (locator -> 'page' is null or jsonb_typeof(locator -> 'page') = 'number')
      and (locator -> 'section' is null or jsonb_typeof(locator -> 'section') = 'string')
      and (locator -> 'table' is null or jsonb_typeof(locator -> 'table') = 'string')
    ),
  body_text text not null check (char_length(body_text) between 1 and 100000),
  -- The lexical lane of hybrid retrieval (§8.1). Generated, so it can never disagree with the
  -- text: to_tsvector with an explicit config is immutable, which a generated column needs.
  -- 'simple' is deliberate: no stemming of aviation or survey vocabulary in M1; the analyzer is
  -- a retrieval-profile decision (T-114), not something to change under a RLS migration.
  search_vector tsvector generated always as (to_tsvector('simple'::regconfig, body_text)) stored,
  data_class text not null,
  token_count integer check (token_count is null or token_count between 0 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_chunks_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  -- The composite FK is the tenant boundary for chunks: a chunk of tenant A can only ever
  -- reference a source version of tenant A (23503 otherwise).
  constraint knowledge_chunks_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete cascade,
  constraint knowledge_chunks_data_class_is_valid
    check (public.data_class_is_valid(data_class)),
  constraint knowledge_chunks_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  unique (id, organisation_id),
  unique (organisation_id, source_version_id, chunk_index)
);
-- FTS lane (§8.1, §8.2): the lexical half of hybrid retrieval, always available even when the
-- pinned embedding route is down.
create index knowledge_chunks_search_idx on public.knowledge_chunks using gin (search_vector);
comment on table public.knowledge_chunks is
  'Version-specific chunk with page/section locators, its own (highest-inherited) data class and a full-text index (§6.2, §7.2 step 4).';

create table public.embedding_indexes (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  -- Shape mirrors EmbeddingIndex.indexKey in src/contracts/provider-route.ts.
  index_key text not null check (index_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  -- ProviderKey of src/contracts/keys.ts: a format guard, not a whitelist. Which providers exist
  -- is platform data (model_providers, plan §6.1, T-115), and which of them may embed which
  -- class is the §12.4 clearance matrix enforced by the gateway — a CHECK here would be a code
  -- constant that silently outranks both.
  provider_key text not null check (provider_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  model text not null check (char_length(model) between 1 and 128),
  dimensions integer not null check (dimensions between 1 and 4096),
  metric text not null check (metric in ('cosine', 'l2', 'ip')),
  generation integer not null check (generation > 0),
  status text not null default 'building' check (status in ('building', 'active', 'retired')),
  -- Every class whose text may be embedded into this generation (§12.4). An index that is not
  -- cleared for a class simply holds no chunks of that class; the build job re-checks this
  -- against the chunks it writes (T-113).
  cleared_for text[] not null default '{}'::text[]
    check (cleared_for <@ array['public', 'internal', 'client_confidential', 'restricted']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint embedding_indexes_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  unique (id, organisation_id),
  unique (organisation_id, index_key, generation)
);
-- §8.3: a shadow generation is built, evaluated, then the pointer switches atomically — never
-- two active generations for one logical index.
create unique index embedding_indexes_one_active_per_key_idx
  on public.embedding_indexes (organisation_id, index_key)
  where status = 'active';
comment on table public.embedding_indexes is
  'A pinned embedding generation: one provider+model+dimensions+metric per row, no fallback field (TOI-ADR-13).';

create table public.chunk_embeddings (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  chunk_id uuid not null,
  index_id uuid not null,
  -- Denormalized from embedding_indexes so a stale writer cannot attach a vector to the wrong
  -- generation; a trigger below requires the two to agree.
  index_generation integer not null check (index_generation > 0),
  -- pgvector in schema `extensions`, the same extension layout as `pgcrypto` in the tenancy
  -- migration. Plan D-05 and §8: vectors stay in Postgres under the same RLS as the records
  -- they cite — no external vector store. CI's `supabase start -x ...,vector,...` excludes the
  -- Supabase *Vector service* container, not the pgvector extension in the Postgres image.
  -- Deliberately no `vector(1536)` typmod: embedding_indexes.dimensions pins a generation, and
  -- a shadow generation (§8.3) may use a different model with a different shape. A column
  -- typmod would silently cap the whole table at one model's dimensions; the guard trigger
  -- below enforces the length against the pinned index row instead, per write.
  -- If a deployment ever cannot install pgvector, the fallback is `float8[]` plus the same
  -- dimension guard — but that loses the distance operators, so it needs its own ADR (§8).
  embedding extensions.vector not null,
  created_at timestamptz not null default now(),
  constraint chunk_embeddings_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint chunk_embeddings_chunk_fk
    foreign key (chunk_id, organisation_id)
    references public.knowledge_chunks (id, organisation_id) on delete cascade,
  constraint chunk_embeddings_index_fk
    foreign key (index_id, organisation_id)
    references public.embedding_indexes (id, organisation_id) on delete cascade,
  unique (id, organisation_id),
  unique (organisation_id, index_id, chunk_id)
);
-- No ANN index yet: plan §8.2 starts with an exact-search recall baseline for pilot-sized
-- corpora and only adds HNSW when volume and latency justify it.
comment on table public.chunk_embeddings is
  'One vector per (chunk, pinned index generation). Immutable: re-embedding writes a new generation, it never rewrites a vector (§8.3).';

-- ---------------------------------------------------------------- jobs and outbox
create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  source_version_id uuid not null,
  -- IngestionStage of src/contracts/ingestion-job.ts. The version's `state` is the progress
  -- record; a job row only asks a worker to run one stage (§7.5).
  stage text not null check (stage in ('validate', 'extract', 'index', 'publish')),
  -- JobExecutor of the same contract.
  executor text not null check (executor in ('cloud_worker', 'local_box')),
  status text not null default 'queued'
    check (status in ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  -- Carried so the enqueue rule (§12.4) and the executor rule (§13) are enforceable in SQL,
  -- exactly as IngestionJobPayload's superRefine does in TypeScript.
  data_class text not null,
  parser_generation text not null default 'v1'
    check (parser_generation ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- The pinned EmbeddingIndex generation this stage must use. Validated against
  -- embedding_indexes by the job API (T-113/T-211); no FK so a generation stays addressable
  -- while its index row is still building.
  index_generation integer not null check (index_generation > 0),
  attempt integer not null default 1 check (attempt between 1 and 100),
  lease_token text check (lease_token is null or char_length(lease_token) between 8 and 128),
  lease_expires_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ingestion_jobs_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint ingestion_jobs_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete cascade,
  constraint ingestion_jobs_data_class_is_valid
    check (public.data_class_is_valid(data_class)),
  constraint ingestion_jobs_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  -- §13: the local box only runs extraction (OCR and inference are separate processes).
  constraint ingestion_jobs_local_box_runs_only_extract
    check (executor <> 'local_box' or stage = 'extract'),
  constraint ingestion_jobs_lease_pair
    check ((lease_token is null) = (lease_expires_at is null)),
  unique (id, organisation_id),
  -- Stage idempotency key of plan §7.5 / §6.2. Cloudflare Queues is at-least-once, so a
  -- duplicate delivery must be a no-op: one row per (tenant, version, stage, parser/index
  -- generation) and `attempt` is incremented in place on retry.
  unique (organisation_id, source_version_id, stage, parser_generation, index_generation)
);
create index ingestion_jobs_dispatch_idx on public.ingestion_jobs (organisation_id, created_at)
  where status in ('queued', 'leased', 'running');
comment on table public.ingestion_jobs is
  'One row per stage of a source version, with lease and idempotency state. Workers never hold database credentials; the job API drives this through narrow privileged interfaces (§13).';

create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  -- Dotted lower-case name, same shape as the permission areas of role_permissions.
  event_type text not null check (event_type ~ '^[a-z0-9_]+(\.[a-z0-9_]+){1,4}$'),
  aggregate_type text not null
    check (aggregate_type in ('source_version', 'knowledge_source', 'ingestion_job', 'embedding_index')),
  aggregate_id uuid not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint outbox_events_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  unique (id, organisation_id)
);
-- Dispatcher scan: the queue is the unprocessed tail, not the whole table.
create index outbox_events_pending_idx on public.outbox_events (created_at)
  where processed_at is null;
create index outbox_events_aggregate_idx on public.outbox_events (organisation_id, aggregate_type, aggregate_id);
comment on table public.outbox_events is
  'Transactional outbox (plan §7.2 step 1, §7.5). Events are written by the same transaction that changes the aggregate; a dispatcher publishes at-least-once and marks processed_at.';

-- ---------------------------------------------------------------- scope and visibility helpers
/**
 * True when the caller may see this collection *in the current tenant scope*: active
 * membership, the transaction's organization, and project audience. SECURITY DEFINER so the
 * policies below never recurse into another table's policy, and pinned search_path satisfies
 * the guardrail (supabase/tests/database/000_guardrails.test.sql).
 */
create or replace function public.collection_is_readable(p_collection_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.knowledge_collections c
     where c.id = p_collection_id
       and c.organisation_id = public.current_organisation_id()
       and public.is_active_member(c.organisation_id)
       and (c.project_id is null or public.is_project_member(c.project_id))
  );
$$;

/** A source is visible when it is in scope, not revoked or deleted, and its collection is. */
create or replace function public.source_is_readable(p_source_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.knowledge_sources s
     where s.id = p_source_id
       and s.organisation_id = public.current_organisation_id()
       and s.lifecycle_state = 'active'
       and public.collection_is_readable(s.collection_id)
  );
$$;

/**
 * Version visibility for the read path. F14: a revoked or deleting version stops being
 * reachable the moment its state changes, so its chunks and vectors go with it — retrieval
 * additionally requires state = 'published' (T-114), which is narrower than row visibility.
 */
create or replace function public.source_version_is_readable(p_source_version_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.source_versions v
     where v.id = p_source_version_id
       and v.organisation_id = public.current_organisation_id()
       and v.state not in ('revoked', 'deleting', 'deleted')
       and public.source_is_readable(v.source_id)
  );
$$;

/** Chunk visibility follows its version, so derived rows never outlive the source (§6.2, F14). */
create or replace function public.chunk_is_readable(p_chunk_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.knowledge_chunks k
     where k.id = p_chunk_id
       and k.organisation_id = public.current_organisation_id()
       and public.source_version_is_readable(k.source_version_id)
  );
$$;

-- ---------------------------------------------------------------- write-path guards
/**
 * A source version is immutable (plan §7.2: "corrections are new versions"). The columns that
 * give the version its identity and content may never change; state, review/revocation
 * markers, failure notes and a *raised* data class may.
 * SQLSTATE 23514 (check_violation) is the code this schema reports for "this row may not
 * change", so a caller sees an integrity failure rather than an internal error.
 */
create or replace function public.source_versions_immutable()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.organisation_id is distinct from old.organisation_id
     or new.source_id is distinct from old.source_id
     or new.version_number is distinct from old.version_number
     or new.content_hash is distinct from old.content_hash
     or new.object_ref is distinct from old.object_ref
     or new.parser_generation is distinct from old.parser_generation
     or new.payload is distinct from old.payload
     or new.body_text is distinct from old.body_text
     or new.created_at is distinct from old.created_at
  then
    raise exception 'source version % is immutable: a correction creates a new version (§7.2)', old.id
      using errcode = '23514';
  end if;
  if public.data_class_rank(new.data_class) is null
     or public.data_class_rank(new.data_class) < public.data_class_rank(old.data_class)
  then
    raise exception 'a source version''s data class may be raised by a reviewer but never lowered (§6.2)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger source_versions_immutable before update on public.source_versions
  for each row execute function public.source_versions_immutable();

/**
 * `deleted` and `deleting` are terminal, and a revoked version can only move toward deletion.
 * The full stage-by-stage transition map belongs to the orchestrator (T-211); this guard only
 * stops a stale or replayed job from resurrecting a source (§7.3, F14).
 */
create or replace function public.source_versions_no_resurrection()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.state in ('deleting', 'deleted') and new.state is distinct from old.state then
    raise exception 'source version % in state % is terminal (§7.3)', old.id, old.state
      using errcode = '23514';
  end if;
  if old.state = 'revoked' and new.state not in ('deleting', 'deleted') then
    raise exception 'a revoked source version % cannot return to service (F14)', old.id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger source_versions_no_resurrection before update on public.source_versions
  for each row execute function public.source_versions_no_resurrection();

/** The current version pointer must be a version of this same source, in this same tenant. */
create or replace function public.knowledge_sources_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_version_source uuid;
begin
  if TG_OP = 'UPDATE' then
    if new.id is distinct from old.id
       or new.organisation_id is distinct from old.organisation_id
       or new.collection_id is distinct from old.collection_id
       or new.kind is distinct from old.kind
       or new.external_id is distinct from old.external_id
       or new.created_at is distinct from old.created_at
    then
      raise exception 'knowledge source % identity columns (collection, kind, external id) are immutable; a different document is a different source', old.id
        using errcode = '23514';
    end if;
  end if;
  if new.current_version_id is not null then
    select source_id into v_version_source
      from public.source_versions
     where id = new.current_version_id and organisation_id = new.organisation_id;
    if not found or v_version_source is distinct from new.id then
      -- 23503: the composite FK already put the version in this tenant, so what fails here is
      -- the reference itself — "this version belongs to this source" (F13).
      raise exception 'source % cannot point at version % as its current version (F13)', new.id, new.current_version_id
        using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

create trigger knowledge_sources_guard before insert or update on public.knowledge_sources
  for each row execute function public.knowledge_sources_guard();

/**
 * A chunk may carry the same class as its version or a higher one, never lower (§6.2,
 * AGENTS.md §4.4). SECURITY DEFINER so the parent lookup does not depend on the caller's
 * scope; when the parent does not exist in this tenant the trigger stays out of the way and
 * the composite FK reports 23503 (the cross-tenant case the packet asks for).
 */
create or replace function public.knowledge_chunks_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_parent_class text;
begin
  if TG_OP = 'UPDATE' then
    if new.id is distinct from old.id
       or new.organisation_id is distinct from old.organisation_id
       or new.source_version_id is distinct from old.source_version_id
       or new.chunk_index is distinct from old.chunk_index
       or new.body_text is distinct from old.body_text
       or new.locator is distinct from old.locator
       or new.created_at is distinct from old.created_at
    then
      raise exception 'chunk % content is immutable: a correction creates a new source version (§7.2)', old.id
        using errcode = '23514';
    end if;
    if public.data_class_rank(new.data_class) < public.data_class_rank(old.data_class) then
      raise exception 'chunk % data class may be raised but never lowered (§6.2)', old.id
        using errcode = '23514';
    end if;
    return new;
  end if;

  select data_class into v_parent_class
    from public.source_versions
   where id = new.source_version_id and organisation_id = new.organisation_id;
  if v_parent_class is not null
     and public.data_class_rank(new.data_class) < public.data_class_rank(v_parent_class)
  then
    raise exception 'chunk data class % is below its source version class % (§6.2)',
      new.data_class, v_parent_class using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger knowledge_chunks_guard before insert or update on public.knowledge_chunks
  for each row execute function public.knowledge_chunks_guard();

/**
 * A vector must match the generation and the dimensions of the index row it is written
 * against: vectors from different models are incomparable, so a mismatched write is data
 * corruption, not a warning (TOI-ADR-13, §8.3). Embeddings are append-only: re-embedding
 * writes a new generation, it never rewrites a vector.
 */
create or replace function public.chunk_embeddings_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_index public.embedding_indexes;
begin
  if TG_OP = 'UPDATE' then
    raise exception 'chunk_embeddings rows are append-only: re-embedding builds a new generation (§8.3)'
      using errcode = '23514';
  end if;
  select * into v_index from public.embedding_indexes
   where id = new.index_id and organisation_id = new.organisation_id;
  if not found then
    return new;  -- the composite FK reports 23503
  end if;
  if v_index.status = 'retired' then
    raise exception 'embedding index % generation % is retired: no new vectors (§8.3)',
      v_index.index_key, v_index.generation using errcode = '23514';
  end if;
  if new.index_generation <> v_index.generation then
    raise exception 'index_generation % does not match embedding index % generation %',
      new.index_generation, v_index.index_key, v_index.generation using errcode = '23514';
  end if;
  if extensions.vector_dims(new.embedding) <> v_index.dimensions then
    raise exception 'embedding has % dimensions, index % pins % (§12.4)',
      extensions.vector_dims(new.embedding), v_index.index_key, v_index.dimensions
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger chunk_embeddings_guard before insert or update on public.chunk_embeddings
  for each row execute function public.chunk_embeddings_guard();

/**
 * §7.2 step 1: capture commits the immutable version and its outbox event in one transaction.
 * A trigger, not application discipline, is what makes "version without an event" impossible.
 * Only capture is guaranteed by the schema; publish/revoke events are appended by the
 * privileged RPC that performs the transition (T-112, T-211), so nothing double-writes here.
 * SECURITY DEFINER because outbox_events is not writable by a member role.
 */
create or replace function public.source_versions_outbox()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.outbox_events (organisation_id, event_type, aggregate_type, aggregate_id, payload)
    values (
      new.organisation_id,
      'knowledge.source_version.received',
      'source_version',
      new.id,
      jsonb_build_object(
        'source_version_id', new.id,
        'source_id', new.source_id,
        'organisation_id', new.organisation_id,
        'version_number', new.version_number,
        'state', new.state,
        'data_class', new.data_class
      )
    );
  return new;
end;
$$;

create trigger source_versions_outbox after insert on public.source_versions
  for each row execute function public.source_versions_outbox();

create trigger knowledge_collections_touch_updated before update on public.knowledge_collections
  for each row execute function public.touch_updated_at();
create trigger knowledge_sources_touch_updated before update on public.knowledge_sources
  for each row execute function public.touch_updated_at();
create trigger source_versions_touch_updated before update on public.source_versions
  for each row execute function public.touch_updated_at();
create trigger knowledge_chunks_touch_updated before update on public.knowledge_chunks
  for each row execute function public.touch_updated_at();
create trigger embedding_indexes_touch_updated before update on public.embedding_indexes
  for each row execute function public.touch_updated_at();
create trigger ingestion_jobs_touch_updated before update on public.ingestion_jobs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- RLS
-- Enabled, not FORCEd, exactly like the tenancy migration: the SECURITY DEFINER helpers and
-- the privileged paths of plan §4.3/§13 run as the migration owner, while anon and
-- authenticated are filtered by the policies below.
alter table public.knowledge_collections enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.source_versions enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.embedding_indexes enable row level security;
alter table public.chunk_embeddings enable row level security;
alter table public.ingestion_jobs enable row level security;
alter table public.outbox_events enable row level security;

-- Reads: active membership AND the transaction's tenant AND project audience (plan §6.2's
-- effective read predicate, minus service/effective-date which arrive with their packets).
create policy knowledge_collections_scoped_read on public.knowledge_collections
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and (project_id is null or public.is_project_member(project_id))
  );

create policy knowledge_sources_scoped_read on public.knowledge_sources
  for select to authenticated
  using (public.source_is_readable(id));

create policy source_versions_scoped_read on public.source_versions
  for select to authenticated
  using (public.source_version_is_readable(id));

create policy knowledge_chunks_scoped_read on public.knowledge_chunks
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and public.chunk_is_readable(id)
  );

create policy embedding_indexes_scoped_read on public.embedding_indexes
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

create policy chunk_embeddings_scoped_read on public.chunk_embeddings
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.chunk_is_readable(chunk_id)
  );

create policy ingestion_jobs_scoped_read on public.ingestion_jobs
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.source_version_is_readable(source_version_id)
  );

create policy outbox_events_scoped_read on public.outbox_events
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

-- Writes for the walking skeleton. Every one of them requires active membership *and* the
-- transaction's tenant, so a forged organisation_id in the row grants nothing (§4.1).
-- T-112/T-211 may move these into SECURITY DEFINER RPCs; that only narrows this surface.
create policy knowledge_collections_scoped_write on public.knowledge_collections
  for insert to authenticated
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    -- A member may only bind a collection to a project they belong to: creating a
    -- collection cannot widen anyone's audience (§6.2).
    and (project_id is null or public.is_project_member(project_id))
  );

create policy knowledge_collections_scoped_update on public.knowledge_collections
  for update to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and (project_id is null or public.is_project_member(project_id))
  )
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and (project_id is null or public.is_project_member(project_id))
  );

create policy knowledge_sources_scoped_write on public.knowledge_sources
  for insert to authenticated
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.collection_is_readable(collection_id)
  );

create policy knowledge_sources_scoped_update on public.knowledge_sources
  for update to authenticated
  using (public.source_is_readable(id))
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.collection_is_readable(collection_id)
  );

create policy source_versions_scoped_write on public.source_versions
  for insert to authenticated
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.source_is_readable(source_id)
  );

-- Publish, revoke, quarantine and failure markers are updates of state only; the immutability
-- trigger above is what keeps the content fixed.
create policy source_versions_scoped_update on public.source_versions
  for update to authenticated
  using (public.source_version_is_readable(id))
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.source_is_readable(source_id)
  );

-- The parent link is enforced by the composite FK, not by this policy: that is what makes a
-- cross-tenant chunk a 23503 foreign-key failure rather than a policy rejection (§6.2).
create policy knowledge_chunks_scoped_write on public.knowledge_chunks
  for insert to authenticated
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

create policy knowledge_chunks_scoped_update on public.knowledge_chunks
  for update to authenticated
  using (
    public.is_active_member(organisation_id)
    and public.chunk_is_readable(id)
  )
  with check (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

-- No member write path for vectors, jobs or outbox rows: an employee must not be able to
-- poison an index, lease a job or acknowledge an event. Those move through privileged
-- server interfaces (plan §13, T-113, T-211): authenticated holds select on the three tables
-- above and no insert or update, and no table here grants delete to any request role — hard
-- deletion is a retention job, and the state machines carry the user-visible meaning.

-- ---------------------------------------------------------------- grants
-- Supabase grants default privileges on new public tables to anon/authenticated
-- (auto_expose_new_tables). Revoked here per table rather than with
-- `revoke all on all tables in schema public`, which would also strip the tenancy grants that
-- 20261105060000 established. Nothing is granted to anon: knowledge is behind sign-in.
revoke all on
  public.knowledge_collections, public.knowledge_sources, public.source_versions,
  public.knowledge_chunks, public.embedding_indexes, public.chunk_embeddings,
  public.ingestion_jobs, public.outbox_events
  from anon, authenticated;

grant select on
  public.knowledge_collections, public.knowledge_sources, public.source_versions,
  public.knowledge_chunks, public.embedding_indexes, public.chunk_embeddings,
  public.ingestion_jobs, public.outbox_events
  to authenticated;

grant insert, update on
  public.knowledge_collections, public.knowledge_sources,
  public.source_versions, public.knowledge_chunks
  to authenticated;

grant execute on function
  public.data_class_is_valid(text),
  public.data_class_rank(text),
  public.data_class_is_ingestible_in_m1(text),
  public.collection_is_readable(uuid),
  public.source_is_readable(uuid),
  public.source_version_is_readable(uuid),
  public.chunk_is_readable(uuid)
  to authenticated;

comment on function public.data_class_is_ingestible_in_m1(text) is
  'SQL mirror of isIngestibleInM1 in src/contracts/provider-route.ts. Change one, change the other; 020_knowledge.test.sql pins the four classes and the M1 cut.';
comment on function public.collection_is_readable(uuid) is
  'Tenant scope + project audience for the knowledge read path; SECURITY DEFINER so RLS policies do not recurse (§4.3).';
