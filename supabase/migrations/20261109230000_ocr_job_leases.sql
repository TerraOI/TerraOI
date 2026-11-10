-- T-211 PR-1: the job API, lease fencing, the extraction-artifact home, and the reconciler
-- (plan §7.2 extraction executors, §7.5 bounded retries + reconciler, §13 local box, §16; F12, F32).
-- Rulings this implements and does not re-open: #99 (max_attempts, inline reclaim, dead letter),
-- #134 (role `toi_job_api` over JOB_DB, the credential digest in the *same* compare as tenant,
-- version, stage, lease token and fence, retarget owned by the cloud worker), #135 (the lease guard
-- carries the credential's executor; `producer` on an artifact is that executor), #146 (a new
-- `object_ref_for_lease_v1` hands the leased job's object key to the worker, which mints the
-- short-lived URL under ADR-0011), #51 (extracted text lives in `extraction_artifacts`, never in a
-- version's `body_text`), #66 (retarget is an UPDATE, never a second job row).
-- Design: docs/decisions/0005-ocr-job-api-and-artifact-home.md (accepted by this PR) and
-- docs/decisions/0011-object-bytes-for-the-pull-worker.md (new here).
--
-- Timestamp claim (daily sync, COORDINATION §3): later than every merged migration
-- (`20261109160000_function_privileges.sql`) **and** later than the in-flight
-- `20261109203000_provider_configuration.sql` on PR #143, so a rebase stays in order. Exactly one
-- migration in this PR (`scripts/migrations.mjs:37`); merged migrations are never edited (`:22-24`).
--
-- Privilege discipline (#60 as merged, FAQ-0010): every function created here — in `public` and in
-- `job_api` — is revoked by full signature in this same transaction, and `EXECUTE` goes back only to
-- `toi_job_api`, by name. `001_function_privileges.test.sql` tests 31-33 enumerate every live
-- function, so an omission is a red CI run rather than a silently reachable endpoint. Every new table
-- is revoked from the request roles and from `service_role` explicitly: `supabase/config.toml:19-23`
-- grants new `public` tables to `service_role` by default, and #146 puts a service-role key on the
-- `workers/` deployment for exactly one Storage call, so this migration is what keeps that key from
-- reaching SQL (ADR-0005 §8, ADR-0011 Consequences).

begin;

-- ── 1. one column: the monotonic lease fence ───────────────────────────────────────────────────
-- Why a fence and not a clock (ADR-0005 §3): a worker whose lease expired still holds a valid
-- `lease_token`, and `updated_at` is maintained by a trigger (`20261105070000_knowledge_core.sql:799`)
-- so it cannot distinguish a re-lease from any other write. Two machines' clocks also disagree, and
-- the box is the one that cannot be trusted to agree. Every mutating call carries the fence it was
-- issued with, and the mutation is a guarded compare (§4 below).
alter table public.ingestion_jobs
  add column lease_fence bigint not null default 0
    constraint ingestion_jobs_lease_fence_nonnegative check (lease_fence >= 0);

comment on column public.ingestion_jobs.lease_fence is
  'Monotonic per-job lease counter. Bumped by a lease, an inline reclaim and a retarget; carried by the worker on every mutating call so a stale holder matches zero rows. Not `attempt`: that is capped (`:373`) and deliberately outside the stage idempotency key (`:398`, issue #16 N3).';

-- `service_role` reaches new `public` tables by default and bypasses RLS. The job surface is not a
-- request-role surface at all (`:884-894` grants it `select` to `authenticated` only), and after
-- #146 there is a service-role key inside the `workers/` deployment, so its SQL reach on the job row
-- is closed here. Same shape as `20261105210000_intake_service_role.sql:6-8`.
revoke all on public.ingestion_jobs from service_role;

-- ── 2. the job_api schema and its role ─────────────────────────────────────────────────────────
-- A non-exposed schema: `supabase/config.toml:13` exposes only `public` and `graphql_public`, so
-- nothing below is reachable over the Data API at all. The role is the ADR-0002 precedent (#134):
-- NOLOGIN, reached only through the owner-created `JOB_DB` Hyperdrive binding, `USAGE` on the schema
-- and `EXECUTE` on named functions, and **no table grant** — for the worker role the containment is
-- the absence of privileges, not RLS.
create schema if not exists job_api;
revoke all on schema job_api from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'toi_job_api') then
    create role toi_job_api nologin;
  end if;
end
$$;

comment on schema job_api is
  'Server-path job API for extraction workers (T-211, ADR-0005). Not exposed through the Data API (supabase/config.toml:13). Reached only as toi_job_api over the JOB_DB Hyperdrive binding; the login user, its password and the binding are owner human steps (T-004 §20.8).';

grant usage on schema job_api to toi_job_api;

-- ── 3. worker credentials: a digest, an executor, and the tenants it may serve ─────────────────
-- The presented token is never stored, only its SHA-256 digest (the `ip_hash` discipline of
-- ADR-0002 §4). One row per executor *instance*: `executor` is what enforces #135 — a box credential
-- can never lease a cloud job and the reverse. `scripts/worker-credential.mjs` (this PR) issues a
-- token and inserts only its digest; the clear-text half lives on the box or in `wrangler secret`.
--
-- Honest property, stated rather than glossed: because the digest is what the compares match on, a
-- read of this table is equivalent to holding every credential it lists. The table is therefore
-- owner-only — no grant to `toi_job_api`, none to any request role, none to `service_role` — and
-- `045_ingestion_jobs.test.sql` pins that. Rotation is a human step (§9 of ADR-0005).
create table job_api.worker_credentials (
  id uuid primary key default gen_random_uuid(),
  label text not null unique check (label ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  executor text not null check (executor in ('cloud_worker', 'local_box')),
  organisations uuid[] not null check (cardinality(organisations) between 1 and 8),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table job_api.worker_credentials is
  'One row per worker credential (T-211, #134): the SHA-256 digest of the token the worker presents, the single executor it may run, and the tenants it serves. Owner-only: not readable by toi_job_api, a request role, or service_role. `revoked_at` is consulted inside every mutating compare, so a revocation stops in-flight renew and complete too, not only new leases.';
comment on column job_api.worker_credentials.token_hash is
  'A capability: whoever can present a matching value is that worker. Stored hashed, never logged, never returned by any function here.';

revoke all on job_api.worker_credentials from public, anon, authenticated, service_role;

-- ── 4. the four bounds, in one place each ──────────────────────────────────────────────────────
-- #99 asked for a named constant; Postgres has none, and the same five would otherwise be written
-- twice (the lease eligibility arm and the reclaim cap) and drift. An immutable function is single-
-- source, callable from the view below, and assertable in pgTAP.
create or replace function job_api.max_attempts() returns integer
language sql immutable set search_path = job_api, public, pg_temp
as $fn$ select 5 $fn$;

create or replace function job_api.max_lease_seconds() returns integer
language sql immutable set search_path = job_api, public, pg_temp
as $fn$ select 1800 $fn$;

create or replace function job_api.abort_reasons() returns text[]
language sql immutable set search_path = job_api, public, pg_temp
as $fn$
  select array['abandoned_by_worker', 'source_revoked', 'unsupported_document', 'object_missing',
               'quality_failed', 'operator_cancel', 'clearance_refused']::text[]
$fn$;

-- The retarget vocabulary is the caller's *evidence*, and its caller is T-212's routing decision
-- (docs/tasks/T-212-document-extraction.md #66: the decision and the text-layer quality check are
-- pure functions there). Keeping the set here means a code T-212 emits that this API did not name is
-- a refusal, not a free-text field an operator later pattern-matches on.
create or replace function job_api.retarget_reasons() returns text[]
language sql immutable set search_path = job_api, public, pg_temp
as $fn$
  select array['no_text_layer', 'too_few_chars', 'page_coverage_low', 'replacement_ratio_high',
               'over_page_count', 'unsupported_filter', 'parse_failed', 'quality_failed',
               'class_not_cleared_for_cloud']::text[]
$fn$;

-- Executor clearance, one place (see §9 for the one arm that is a stated interim, not a ruling).
create or replace function job_api.executor_clears_class(p_executor text, p_class text)
returns boolean language sql stable set search_path = job_api, public, pg_temp
as $fn$
  select case
    -- `restricted` is un-ingestible in M1 (§12.4); no job row can carry it and no executor clears it.
    when p_executor is null or p_class is null or p_class = 'restricted' then false
    -- The box is the tenant''s own hardware (plan §13): it clears every class M1 ingests.
    when p_executor = 'local_box' then p_class in ('public', 'internal', 'client_confidential')
    -- Stated interim, not a widening: §12.4''s default matrix lists no cloud provider for
    -- client_confidential (src/contracts/provider-route.ts:81 — local_box, claude), and ADR-0007
    -- widened the matrix for **embeddings only** (docs/decisions/0007-e1-embedding-clearance.md:14).
    -- A client_confidential extract therefore retargets to the box. If the supervisor rules that
    -- extraction inside our own bounded worker clears it, this one line changes, in a new migration,
    -- and 045 assertions 62-63 flip with it.
    when p_executor = 'cloud_worker' then p_class in ('public', 'internal')
    else false
  end;
$fn$;

revoke execute on function
  job_api.max_attempts(),
  job_api.max_lease_seconds(),
  job_api.abort_reasons(),
  job_api.retarget_reasons(),
  job_api.executor_clears_class(text, text)
  from public, anon, authenticated, service_role;

-- ── 5. the artifact home (#51, ADR-0005 §4) ────────────────────────────────────────────────────
-- Why a separate table: `source_versions_immutable()` refuses any change to `parser_generation`
-- (knowledge_core.sql:575), `payload` (`:576`) and `body_text` (`:577`), so an extractor has no legal
-- column to write; and content dedup is `unique (collection_id, content_hash)` (`:220`), so "an
-- extraction creates a new version" collides on re-parse. Keyed by (version, stage, parser_generation,
-- index_generation, artifact_index), a re-parse writes a **second artifact set against the same
-- immutable version** — no new version row, `:220` untouched, and §7.2's "a correction creates a new
-- version" keeps its meaning. `index_generation` is in the key because a re-embed makes an old set
-- stale, and this keeps the stale set visible instead of silently overwriting it (§6.4).
create table public.extraction_artifacts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  source_version_id uuid not null,
  job_id uuid,
  stage text not null check (stage in ('validate', 'extract', 'index', 'publish')),
  parser_generation text not null check (parser_generation ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  index_generation integer not null check (index_generation > 0),
  artifact_index integer not null check (artifact_index >= 0),
  -- Identical shape check to knowledge_chunks.locator (`:242-248`), so a locator written for a chunk
  -- and one written for an artifact cannot drift. Note the honest limit of that identity: the merged
  -- check types page/section/table and says nothing about **extra** keys, so a sheet row or column
  -- rides as an unvalidated key. T-212 keeps those well-formed in TypeScript; SQL cannot.
  locator jsonb not null default '{}'::jsonb
    check (jsonb_typeof(locator) = 'object'
      and (locator -> 'page' is null or jsonb_typeof(locator -> 'page') = 'number')
      and (locator -> 'section' is null or jsonb_typeof(locator -> 'section') = 'string')
      and (locator -> 'table' is null or jsonb_typeof(locator -> 'table') = 'string')),
  body_text text not null check (char_length(body_text) between 1 and 100000),
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  notes jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  producer text not null check (producer in ('cloud_worker', 'local_box')),
  data_class text not null,
  -- The fence of the writer that produced this set, copied from the compare that succeeded. It is
  -- what `abort_parse_job_v1` matches against when it clears a dead holder''s partial output.
  fence bigint not null check (fence >= 0),
  created_at timestamptz not null default now(),
  constraint extraction_artifacts_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  -- The tenant boundary (ADR-0005 §4, AGENTS §4.2): a composite FK means a row cannot name another
  -- tenant''s version at all — the mechanism `:263-265` already uses for chunks.
  constraint extraction_artifacts_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete cascade,
  constraint extraction_artifacts_job_fk
    foreign key (job_id, organisation_id)
    references public.ingestion_jobs (id, organisation_id) on delete set null,
  constraint extraction_artifacts_data_class_is_valid
    check (public.data_class_is_valid(data_class)),
  constraint extraction_artifacts_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  unique (id, organisation_id),
  unique (organisation_id, source_version_id, stage, parser_generation, index_generation, artifact_index)
);

comment on table public.extraction_artifacts is
  'Extracted text with page/section/table locators and OCR confidence, one row per located unit (#51, ADR-0005 §4; F12, F32). Insert-only: a correction is a new artifact set under a new parser_generation, never an edit in place. Reads are RLS-gated through the parent version; writes happen only inside complete_parse_job_v1, which copies the generations from the job row.';

-- New `public` tables are privileged for anon, authenticated and service_role by default
-- (supabase/config.toml:19-23). Close all three, then grant only the member read the policy below
-- scopes (precedent knowledge_core.sql:884-894). Writes go through job_api, never through a grant.
revoke all on public.extraction_artifacts from anon, authenticated, service_role;
grant select on public.extraction_artifacts to authenticated;

alter table public.extraction_artifacts enable row level security;

-- Same shape as knowledge_chunks_scoped_read (`:833-838`), with the parent predicate that exists for
-- a version rather than a chunk. All three AGENTS §4.2 negatives are provable through it: another
-- tenant (the composite FK), another project (`collection_is_readable`'s project arm, `:442`), and a
-- deactivated member (`is_active_member` filters status = 'active',
-- 20261105060000_tenancy_core.sql:184).
create policy extraction_artifacts_scoped_read on public.extraction_artifacts
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.source_version_is_readable(source_version_id)
  );

-- The guard, both halves of the merged precedent (knowledge_chunks_guard, `:661-696`): content
-- immutability and class non-lowering. The second half only ever fires on an UPDATE the guard
-- permits, and this guard permits no UPDATE at all — so class non-lowering is asserted at insert,
-- where the parent is still readable, and the insert-only arm is what keeps a later "fix the text"
-- path from quietly rewriting an artifact instead of re-running the parser.
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
  raise exception 'extraction artifacts are insert-only; a correction is a new artifact set'
    using errcode = '23514';
end;
$fn$;

create trigger extraction_artifacts_guard
  before insert or update on public.extraction_artifacts
  for each row execute function public.extraction_artifacts_guard();

-- #60 as merged (FAQ-0010): revoked by full signature in the creating transaction, and **not**
-- granted back — a trigger fires because the table has it, not because the invoking role holds
-- EXECUTE (precedent: the eight in 20261109160000_function_privileges.sql:24-40, and
-- user_may_publish_into left closed at 20261106100000_knowledge_uploads.sql:601-606). Without this
-- line, 001's generic rules 31-32 fail this PR.
revoke execute on function public.extraction_artifacts_guard()
  from public, anon, authenticated, service_role;

-- ── 6. compare arms shared by every mutating call ─────────────────────────────────────────────
-- The ruling (#134) is that the credential arm is not a separate gate: it sits in the same statement
-- as tenant, version, stage, lease token and fence. Two arms matter against two different failures
-- (ADR-0005 §3, corrected): the fence defeats a **re-leased** worker, and the server-side
-- `lease_expires_at > now()` defeats an **abandoned** one whose fence never moved. Removing either
-- reopens a case the packet asks 045 to pin.
--
--   where id = p_job_id
--     and lease_token = p_lease_token and lease_fence = p_fence
--     and status in ('leased','running') and lease_expires_at > now()
--     and <credential arm>: token_hash = p_token_hash and revoked_at is null
--                           and organisation_id = any (organisations) and executor = <c.executor>

-- ── 7. lease, with the inline reclaim (#99) ────────────────────────────────────────────────────
-- Order inside one transaction: reclaim first, then select, then the issuing UPDATE. Without the
-- sweep, one poisoned extract job starves the tenant's queue forever: `attempt` is capped by a CHECK
-- (`:373`), the lease bumps it, and the select is `order by created_at limit 1` over rows still in
-- ('queued','leased','running') — so the first-in-line row raises 23514 on every later call
-- (ADR-0005 §5b). `attempt` is read as "trials performed so far": a row may be leased while
-- attempt <= max_attempts, which yields exactly max_attempts leases before the sweep dead-letters it.
create or replace function job_api.lease_parse_job_v1(
  p_token_hash text,
  p_stage text,
  p_lease_seconds integer
) returns table (
  o_found boolean, o_job_id uuid, o_organisation_id uuid, o_source_version_id uuid,
  o_stage text, o_executor text, o_parser_generation text, o_index_generation integer,
  o_data_class text, o_lease_token text, o_fence bigint, o_attempt integer
)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_job public.ingestion_jobs;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  -- Only extraction is leased by this API in M1: index and publish stages belong to T-113 and T-213,
  -- and the merged CHECK already pins local_box to extract (`:390-391`).
  if p_stage is null or p_stage <> 'extract' then
    raise exception 'this job API leases extraction only in M1' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and job_api.max_lease_seconds() then
    raise exception 'lease seconds must be between 60 and %', job_api.max_lease_seconds()
      using errcode = '22023';
  end if;

  -- Reclaim first (#99). Expired leases for the tenants and the executor this credential serves:
  -- under the cap back to `queued` with the pair cleared together (`:392-393`) and the fence bumped,
  -- so the abandoned holder matches zero rows later; at the cap to `failed`, which is the dead letter
  -- and a state, never a deletion (ADR-0005 §10b).
  update public.ingestion_jobs j
     set status = case when j.attempt > job_api.max_attempts() then 'failed' else 'queued' end,
         lease_token = null,
         lease_expires_at = null,
         lease_fence = j.lease_fence + 1,
         last_error = case when j.attempt > job_api.max_attempts()
                           then 'retries_exhausted' else j.last_error end
   where j.stage = 'extract'
     and j.status in ('leased', 'running')
     and j.lease_expires_at is not null
     and j.lease_expires_at <= now()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations));

  -- Tenant comes from the row, never from an argument (AGENTS §4.1). A foreign job id and an unknown
  -- job id answer identically — o_found = false, the same shape as "no work" — which is the
  -- no-existence-oracle discipline of knowledge_uploads.sql:422-427 and #13(2). `limit 1` precedes
  -- `for update skip locked`: Postgres rejects the other order, and skip locked is what lets two
  -- workers of the same tenant take different jobs instead of blocking each other.
  select * into v_job from public.ingestion_jobs j
   where j.stage = 'extract'
     and j.status in ('queued', 'leased', 'running')
     and (j.lease_token is null or j.lease_expires_at <= now())
     and j.attempt <= job_api.max_attempts()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations))
   order by j.created_at
   limit 1
   for update skip locked;

  if not found then
    o_found := false;
    return next;
    return;
  end if;

  update public.ingestion_jobs
     set status = 'leased',
         lease_token = encode(extensions.gen_random_bytes(24), 'base64'),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         lease_fence = lease_fence + 1,
         attempt = attempt + 1
   where id = v_job.id
   returning lease_token, lease_fence, attempt into o_lease_token, o_fence, o_attempt;

  o_found := true;
  o_job_id := v_job.id;
  o_organisation_id := v_job.organisation_id;
  o_source_version_id := v_job.source_version_id;
  o_stage := v_job.stage;
  o_executor := v_job.executor;
  o_parser_generation := v_job.parser_generation;
  o_index_generation := v_job.index_generation;
  o_data_class := v_job.data_class;
  return next;
end;
$fn$;

-- ── 8. renew ───────────────────────────────────────────────────────────────────────────────────
-- A zero-row match is a named refusal, never a silent no-op: a worker that believes it still holds a
-- lease has to find out immediately (ADR-0005 §3).
create or replace function job_api.renew_parse_lease_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint,
  p_lease_seconds integer
) returns table (o_outcome text, o_expires_at timestamptz, o_fence bigint)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and job_api.max_lease_seconds() then
    raise exception 'lease seconds must be between 60 and %', job_api.max_lease_seconds()
      using errcode = '22023';
  end if;

  update public.ingestion_jobs j
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations))
   returning j.lease_expires_at, j.lease_fence into o_expires_at, o_fence;

  if not found then
    o_outcome := 'refused';
    return next;
    return;
  end if;
  o_outcome := 'renewed';
  return next;
end;
$fn$;

-- ── 9. complete, and the artifact write ────────────────────────────────────────────────────────
-- The caller names the stage, the version and the index generation it was told to work on, and every
-- one of them is checked against the authoritative job row rather than trusted: docs/contracts/
-- knowledge-and-jobs.md:35 requires the re-check on **every** call, and a replayed message from
-- before a re-enqueue must not write a generation that never ran. The generations that land in the
-- artifact key are copied from the job row, never taken from p_artifacts (ADR-0005 §4).
create or replace function job_api.complete_parse_job_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint,
  p_source_version_id uuid,
  p_stage text,
  p_index_generation integer,
  p_artifacts jsonb,
  p_notes jsonb,
  p_ocr_confidence numeric
) returns table (o_outcome text, o_artifact_count integer, o_event_id uuid)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_job public.ingestion_jobs;
  v_state text;
  v_total_chars bigint;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  if p_artifacts is null or jsonb_typeof(p_artifacts) <> 'array'
     or p_notes is not null and jsonb_typeof(p_notes) <> 'array' then
    raise exception 'artifacts and notes must be JSON arrays' using errcode = '22023';
  end if;
  -- A bounded payload: 2 MB of extracted text is far past any real document this pipeline accepts
  -- (pdf-text-extract.ts caps text at 200 000 chars) and stops a caller turning one RPC into a
  -- memory problem. Per-row length is the table's own CHECK.
  select coalesce(sum(char_length(e ->> 'body_text')), 0) into v_total_chars
    from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb)) e;
  if jsonb_array_length(p_artifacts) not between 1 and 2000 or v_total_chars > 2000000 then
    raise exception 'artifact set out of bounds (rows 1..2000, 2000000 characters)'
      using errcode = '22023';
  end if;
  if exists (
        select 1
          from jsonb_array_elements(p_artifacts) a
         where jsonb_typeof(a) <> 'object'
            or jsonb_typeof(a -> 'body_text') <> 'string'
            or char_length(a ->> 'body_text') not between 1 and 100000
            or jsonb_typeof(a -> 'artifact_index') <> 'number'
            or (a -> 'locator') is not null and jsonb_typeof(a -> 'locator') <> 'object'
            or (a -> 'locator' -> 'notes') is not null
            or (a -> 'confidence') is not null and jsonb_typeof(a -> 'confidence') <> 'number'
       ) then
    raise exception 'each artifact needs body_text (1..100000) and a numeric artifact_index'
      using errcode = '22023';
  end if;
  if exists (
        select 1
          from (select (a ->> 'artifact_index')::int as ix
                  from jsonb_array_elements(p_artifacts) a) s
         group by s.ix having count(*) > 1) then
    raise exception 'artifact_index values must be distinct within one completion'
      using errcode = '22023';
  end if;
  if p_ocr_confidence is not null and (p_ocr_confidence < 0 or p_ocr_confidence > 1) then
    raise exception 'ocr confidence must be between 0 and 1' using errcode = '22023';
  end if;

  -- Authoritative re-read, under a row lock, before anything is written.
  select * into v_job from public.ingestion_jobs j
   where j.id = p_job_id
     for update;
  if not found then
    -- Foreign == unknown == gone: one indistinguishable refusal (knowledge_uploads.sql:368-372).
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;
  if v_job.source_version_id <> p_source_version_id
     or v_job.stage <> p_stage
     or v_job.index_generation <> p_index_generation then
    -- A stale payload: the answer is a refusal, not a write into a generation that never ran.
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;
  if not job_api.executor_clears_class(v_job.executor, v_job.data_class) then
    raise exception 'executor does not clear this data class' using errcode = '42501';
  end if;
  select state into v_state from public.source_versions where id = v_job.source_version_id;
  if v_state is null or v_state in ('revoked', 'deleting', 'deleted') then
    -- Same filter as source_version_is_readable (knowledge_core.sql:471): a revoked source stops
    -- producing output the moment its state changes (F14).
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  update public.ingestion_jobs j
     set status = 'succeeded',
         lease_token = null,
         lease_expires_at = null,
         completed_at = now(),
         last_error = null
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations));

  if not found then
    -- Zero rows: either a superseded holder, or the same completion delivered twice. A duplicate
    -- delivery must be a no-op **after writing nothing**, which is what makes one artifact set and
    -- one outbox event under at-least-once dispatch (plan §7.5).
    if v_job.status = 'succeeded' then
      o_outcome := 'already_completed';
      o_artifact_count := (select count(*)::integer from public.extraction_artifacts
                            where job_id = p_job_id and organisation_id = v_job.organisation_id);
      o_event_id := null;
      return next;
      return;
    end if;
    raise exception 'job not available to this worker' using errcode = '42501';
  end if;

  insert into public.extraction_artifacts (
    organisation_id, source_version_id, job_id, stage, parser_generation, index_generation,
    artifact_index, locator, body_text, confidence, notes, producer, data_class, fence
  )
  select v_job.organisation_id, v_job.source_version_id, p_job_id, v_job.stage,
         v_job.parser_generation, v_job.index_generation,
         (a ->> 'artifact_index')::int,
         coalesce(a -> 'locator', '{}'::jsonb),
         a ->> 'body_text',
         coalesce((a ->> 'confidence')::numeric, p_ocr_confidence),
         coalesce(a -> 'notes', p_notes, '[]'::jsonb),
         -- #135: the producer is the credential''s executor, not a value the caller sends.
         v_job.executor,
         -- §6.2: the class of derived content is the job's, which capture already derived from the
         -- collection. A caller cannot lower or raise it here.
         v_job.data_class,
         p_fence
    from jsonb_array_elements(p_artifacts) a;

  get diagnostics o_artifact_count = row_count;

  -- One outbox row for the completed stage, in the transaction that changed the aggregate
  -- (knowledge_core.sql:424-425). Shapes pinned by :409-411.
  insert into public.outbox_events (organisation_id, event_type, aggregate_type, aggregate_id, payload)
       values (
         v_job.organisation_id,
         'knowledge.ingestion_job.extract_succeeded',
         'ingestion_job',
         p_job_id,
         jsonb_build_object(
           'job_id', p_job_id,
           'source_version_id', v_job.source_version_id,
           'artifacts', o_artifact_count,
           'executor', v_job.executor
         )
       )
    returning id into o_event_id;

  o_outcome := 'completed';
  return next;
end;
$fn$;

-- ── 10. abort, and the closed reason vocabulary ────────────────────────────────────────────────
create or replace function job_api.abort_parse_job_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint,
  p_reason_code text
) returns table (o_outcome text, o_status text)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  -- Closed vocabulary (#99): a free-text reason becomes a field operators pattern-match on and a
  -- channel for document-derived text into job metadata (AGENTS §4.8).
  if p_reason_code is null or not (p_reason_code = any (job_api.abort_reasons())) then
    raise exception 'reason must be a named abort code' using errcode = '22023';
  end if;

  update public.ingestion_jobs j
     set status = 'cancelled',
         lease_token = null,
         lease_expires_at = null,
         last_error = p_reason_code
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations))
   returning j.organisation_id, j.status into v_org, o_status;

  if not found then
    o_outcome := 'refused';
    return next;
    return;
  end if;

  -- A deliberate exception to a merged convention, argued rather than slipped past
  -- (knowledge_core.sql:900-901 keeps DELETE away from request roles because "hard deletion is a
  -- retention job"). This is not retention: it removes the **partial output of a writer that no
  -- longer holds the lease** — artifacts whose fence is not the one that just aborted — so a revoked
  -- or abandoned run cannot leave located text that a later completion would silently duplicate or
  -- contradict. It runs inside job_api only; no request role holds DELETE anywhere.
  delete from public.extraction_artifacts
   where job_id = p_job_id and organisation_id = v_org and fence <> p_fence;

  o_outcome := 'aborted';
  return next;
end;
$fn$;

-- ── 11. retarget, which belongs to the cloud worker (#134, #66) ────────────────────────────────
-- Why an UPDATE and never a second job row: the stage key `:398` does not include `executor`, and
-- capture enqueues with `on conflict … do nothing` (`20261106100000_knowledge_uploads.sql:470-478`),
-- so inserting a box row for a scan is **silently discarded** — a scanned PDF with a cloud row and no
-- visible failure. Why it cannot be decided at capture: `sniffSignature` types bytes by signature
-- alone (`object-validator.ts:65-87`) while "digital PDF with a usable text layer" is only knowable
-- after a parse.
--
-- #134 narrowed the caller: the cloud worker retargets its **own leased** job under a valid fence.
-- It bumps `lease_fence` and clears the lease pair — the same invariant as the reclaim sweep — because
-- the abandoned holder must match zero rows afterwards. The box never retargets (a box credential has
-- executor local_box, so the credential arm refuses it).
create or replace function job_api.retarget_extract_job_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint,
  p_reason_code text
) returns table (o_outcome text, o_executor text, o_status text, o_fence bigint)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;
  if p_reason_code is null or not (p_reason_code = any (job_api.retarget_reasons())) then
    raise exception 'reason must be a named retarget code' using errcode = '22023';
  end if;

  update public.ingestion_jobs j
     set executor = 'local_box',
         status = 'queued',
         lease_token = null,
         lease_expires_at = null,
         lease_fence = j.lease_fence + 1,
         last_error = p_reason_code
   where j.id = p_job_id
     and j.stage = 'extract'
     and j.executor = 'cloud_worker'
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = 'cloud_worker'
                    and j.organisation_id = any (c.organisations))
   returning j.executor, j.status, j.lease_fence into o_executor, o_status, o_fence;

  if not found then
    o_outcome := 'refused';
    return next;
    return;
  end if;
  o_outcome := 'retargeted';
  return next;
end;
$fn$;

-- ── 12. the object locator for a live lease (#146) ─────────────────────────────────────────────
-- The worker never receives a URL, a key or a token inside a job payload
-- (src/contracts/ingestion-job.ts:13-17,33), and #146 put the minting in the `workers/` deployment
-- under a service-role key scoped to one Storage call (ADR-0011). What SQL supplies is the object
-- **key**, and only under the same compare as every other mutating call: an unknown tenant's job, an
-- expired lease, a stale fence or a revoked credential all return no row.
create or replace function job_api.object_ref_for_lease_v1(
  p_token_hash text,
  p_job_id uuid,
  p_lease_token text,
  p_fence bigint
) returns table (o_found boolean, o_object_ref text, o_data_class text, o_executor text)
language plpgsql security definer set search_path = job_api, public, pg_temp
as $fn$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'worker credential digest is required' using errcode = '22023';
  end if;

  -- The key is read from the version row the lease points at, so it cannot be asked for by name and
  -- cannot be steered by request input. `limit 1` is redundant against the composite FK but keeps the
  -- plan cheap and the row count obvious to a reviewer.
  select v.object_ref, j.data_class, j.executor
    into o_object_ref, o_data_class, o_executor
    from public.ingestion_jobs j
    join public.source_versions v
      on v.id = j.source_version_id and v.organisation_id = j.organisation_id
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.lease_fence = p_fence
     and j.status in ('leased', 'running')
     and j.lease_expires_at > now()
     and v.state not in ('revoked', 'deleting', 'deleted')
     and job_api.executor_clears_class(j.executor, j.data_class)
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations))
   limit 1;

  if not found then
    -- No existence signal, the same discipline as lease_parse_job_v1: another tenant's job id, an
    -- expired lease, a stale fence and a revoked credential all answer "no row".
    o_found := false;
    o_object_ref := null;
    o_data_class := null;
    o_executor := null;
  else
    o_found := true;
  end if;
  return next;
end;
$fn$;

-- ── 13. the reconciler (#99): a view, not a dashboard ──────────────────────────────────────────
-- Plan §7.5 asks for "a dead-letter path and a reconciler". The dead letter is `failed` (§7); this is
-- the reconciler half: three named findings, provable in pgTAP today, and the surface a later
-- dashboard (T-405) reads. Service/admin only — no grant to any request role, and none to
-- `toi_job_api`: a worker fixes its own queue by leasing, not by reading the whole tenant's.
create or replace view job_api.reconciler_findings as
  select 'stuck_job'::text as finding,
         j.id as job_id,
         j.organisation_id,
         j.source_version_id,
         j.stage,
         j.status,
         j.attempt,
         j.created_at,
         jsonb_build_object(
           'age_seconds', floor(extract(epoch from (now() - j.created_at)))::integer,
           'lease_expires_at', j.lease_expires_at
         ) as detail
    from public.ingestion_jobs j
   where j.status in ('queued', 'leased', 'running')
     -- Older than twice the maximum lease: one lease cycle has definitively been missed.
     and j.created_at < now() - make_interval(secs => 2 * job_api.max_lease_seconds())
  union all
  select 'recent_failure',
         j.id,
         j.organisation_id,
         j.source_version_id,
         j.stage,
         j.status,
         j.attempt,
         j.created_at,
         jsonb_build_object('last_error', coalesce(j.last_error, ''),
                            'updated_at', j.updated_at)
    from public.ingestion_jobs j
   where j.status in ('failed', 'cancelled')
     and j.updated_at >= now() - interval '7 days'
  union all
  -- A version in a live pipeline state with no job row is the case a queue cannot report: nothing
  -- will ever run it. This is the arm the packet's "box offline" evidence leans on.
  select 'missing_job',
         null,
         v.organisation_id,
         v.id,
         null,
         v.state,
         null,
         v.created_at,
         jsonb_build_object('state', v.state)
    from public.source_versions v
   where v.state in ('received', 'validating', 'extracting', 'indexing', 'awaiting_review')
     and not exists (select 1 from public.ingestion_jobs j2
                      where j2.source_version_id = v.id
                        and j2.organisation_id = v.organisation_id);

comment on view job_api.reconciler_findings is
  'The reconciler of plan §7.5 as three named findings: stuck_job (non-final, older than twice job_api.max_lease_seconds()), recent_failure (failed or cancelled in the last 7 days) and missing_job (a version in a live pipeline state with no job row). Read by an owner or a later T-405 dashboard through a privileged path; granted to no request role and not to toi_job_api.';

revoke all on job_api.reconciler_findings from public, anon, authenticated, service_role;
revoke all on job_api.reconciler_findings from toi_job_api;

-- ── 14. per-function revoke and grant, by name (#60 as merged, FAQ-0010) ───────────────────────
-- Revoke first: PostgreSQL starts a new function with EXECUTE to PUBLIC, and the request roles are
-- members of PUBLIC, so leaving any of these open is a reachable endpoint in `job_api` (which the
-- Data API does not expose anyway — `supabase/config.toml:13` — but a direct connection would see
-- it). `001_function_privileges.test.sql` test 33 now names `job_api` alongside `toi_identity` and
-- `intake`, so an omission here fails the allow-list suite.
revoke execute on function
  job_api.lease_parse_job_v1(text, text, integer),
  job_api.renew_parse_lease_v1(text, uuid, text, bigint, integer),
  job_api.complete_parse_job_v1(text, uuid, text, bigint, uuid, text, integer, jsonb, jsonb, numeric),
  job_api.abort_parse_job_v1(text, uuid, text, bigint, text),
  job_api.retarget_extract_job_v1(text, uuid, text, bigint, text),
  job_api.object_ref_for_lease_v1(text, uuid, text, bigint)
  from public, anon, authenticated, service_role;

-- #134: EXECUTE by name on the job-API functions, nothing else. No table grant, no schema-wide
-- grant, no sequence, no view. A leaked JOB_DB credential can call these six functions with a
-- credential digest and do nothing else — the containment statement of ADR-0002 §Consequences,
-- restated for this path in ADR-0005 §6.
grant execute on function
  job_api.lease_parse_job_v1(text, text, integer),
  job_api.renew_parse_lease_v1(text, uuid, text, bigint, integer),
  job_api.complete_parse_job_v1(text, uuid, text, bigint, uuid, text, integer, jsonb, jsonb, numeric),
  job_api.abort_parse_job_v1(text, uuid, text, bigint, text),
  job_api.retarget_extract_job_v1(text, uuid, text, bigint, text),
  job_api.object_ref_for_lease_v1(text, uuid, text, bigint)
  to toi_job_api;

-- ── 15. function comments: the shapes a reviewer should not have to re-read the body for ──────
comment on function job_api.lease_parse_job_v1(text, text, integer) is
  'Reclaim expired leases for this credential''s tenants and executor, dead-letter the capped ones, then take the oldest eligible extract job under the credential arm. Tenant is read from the row (AGENTS §4.1); a foreign job id, an unknown job and an empty queue answer the same way. Bumps lease_fence and attempt; returns the issued token and fence.';
comment on function job_api.renew_parse_lease_v1(text, uuid, text, bigint, integer) is
  'Extend only lease_expires_at, under the token+fence+status+expiry+credential compare. A zero-row match is a named refusal (o_outcome = refused): a holder that lost its lease must learn it now.';
comment on function job_api.complete_parse_job_v1(text, uuid, text, bigint, uuid, text, integer, jsonb, jsonb, numeric) is
  'The only write path for extracted text. Re-checks version, stage and index generation against the job row, refuses a revoked parent and an uncleared executor, flips the job to succeeded under the compare, then inserts the artifact set with the generations copied from the job row and producer = the credential''s executor, and appends exactly one outbox event. A duplicate delivery writes nothing and returns already_completed.';
comment on function job_api.abort_parse_job_v1(text, uuid, text, bigint, text) is
  'Cancel a live lease with a named reason from job_api.abort_reasons(), clear the lease pair together, and delete the partial artifacts of a writer whose fence is not this one. No request role holds DELETE on extraction_artifacts anywhere.';
comment on function job_api.retarget_extract_job_v1(text, uuid, text, bigint, text) is
  'The cloud worker''s one-way door on its own leased extract job: cloud_worker -> local_box, queued, lease pair cleared, lease_fence bumped so the abandoned holder matches zero rows afterwards. A box credential is refused by the executor arm (#134, #66).';
comment on function job_api.object_ref_for_lease_v1(text, uuid, text, bigint) is
  'The object key of the leased job''s object, under the same compare as every mutating call and only for an executor the version''s class clears. SQL never mints a URL; the workers/ deployment signs this key for 60 seconds under ADR-0011 and never stores or logs the result.';

commit;
