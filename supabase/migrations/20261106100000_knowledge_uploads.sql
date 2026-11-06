-- T-112: the upload session and the capture write path — `knowledge_upload_sessions` plus the three
-- scoped RPCs Lane 2 owns. Plan §7.2 steps 1–2, §9.2.1 (`POST /api/knowledge/uploads`,
-- `POST /api/knowledge/uploads/:id/complete`), §6.2, §4.3; F09, F10; #13(1), #13(2), FAQ-0004.
--
-- Why this migration exists at all: `20261105070000_knowledge_core.sql` left `authenticated` with
-- SELECT and nothing else on the knowledge tables (review finding B1 on PR #12), and named
-- `register_source_version_v1` as the capture path that would supply `uploaded_by`, the tenant, the
-- verified content hash and the object key **server-side**. This is that write path.
--
-- Invariants encoded here:
--   * the object key is generated inside `begin_upload_session_v1` from the transaction's tenant and
--     a fresh uuid. No function in this file takes an object key, a tenant, an uploader or a data
--     class as an argument, so there is nothing to forge (§4.1, F09);
--   * a session row is bound to one tenant, one uploader and one collection, and it is the only
--     thing a completion may consume: `register_source_version_v1` re-reads it under
--     `organisation_id = current_organisation_id() and created_by = auth.uid()`, so a session issued
--     for tenant A cannot be completed under tenant B's host, and a colleague's session is not
--     yours to complete. Unknown, foreign and somebody-else's session give the identical 42501, so a
--     probe learns nothing (#13(2));
--   * publish permission is re-checked at completion, not only at session start: role level can
--     change, or a project membership can be removed, between the two calls (§4.2, §6.2);
--   * `uploaded_by` is `auth.uid()` and the tenant is `current_organisation_id()` — never a body
--     value (AGENTS.md §4.1, issue #8: this column is what T-213 compares a reviewer against);
--   * the data class is inherited from the collection (never lowered by a relabel, §6.2), and the
--     `extract` stage row carries the tenant's *active* `corpus` index generation. If no generation
--     is active the capture is refused whole — inventing a generation would decide the open pin in
--     issue #6 and would write a job no worker could honour (§8.3, §12.4);
--   * capture is atomic: one source, one version, the outbox event (written by the merged
--     `source_versions_outbox` trigger, not here) and one stage row, or nothing at all. Cloudflare
--     Queues is at-least-once, so the stage row also has to survive a duplicate completion —
--     `ingestion_jobs`' unique stage key is what makes the second delivery a no-op, and `attempt` is
--     deliberately not part of it (§7.5, issue #16 N3);
--   * content dedup stays collection-scoped (`unique (collection_id, content_hash)`, #13(2)). A hit
--     is only ever reported to a caller who can read that collection; otherwise the write is simply
--     refused with the same code as any other refusal, so the constraint cannot be used as an
--     existence oracle across a project or tenant boundary;
--   * `knowledge_upload_sessions` is SELECT-only for `authenticated`, and only for the caller's own
--     sessions in the caller's own tenant scope. Every write goes through the three RPCs, and the
--     guard trigger below keeps even a privileged update from rewriting a session's identity, its
--     object key or a completed capture;
--   * every SECURITY DEFINER function pins `search_path`, and privileges are revoked and granted
--     **per function**: a blanket `revoke execute on all functions in schema public` would strip the
--     grants `20261105060000_tenancy_core.sql` gave on purpose. The still-open knowledge
--     function-EXECUTE gap is not fixed here; that is the supervisor's call.

-- ---------------------------------------------------------------- upload sessions
create table public.knowledge_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  collection_id uuid not null,
  -- The member who was handed the key. Not null and never writable from a request body: the RPC
  -- takes auth.uid(). A completion may only consume a session whose created_by is its own caller.
  created_by uuid not null references public.profiles (id) on delete cascade,
  -- Client-supplied retry key, validated by shape. Unique per (tenant, uploader) so a retried
  -- `POST /api/knowledge/uploads` returns the same session and the same key instead of issuing a
  -- second object for the same logical upload.
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  -- Advisory label for the UI only. Control characters and path separators are refused at the
  -- column, and the value never contributes to object_ref, to the detected type, or to dedup.
  filename text not null check (
    char_length(filename) between 1 and 200
    and filename !~ '[[:cntrl:]/\\]'
  ),
  -- Server-issued private key. Same shape rules as source_versions.object_ref, and the same reason
  -- (a length bound that fits Postgres' 255 repetition limit, no `..` segments, no empty segments).
  object_ref text not null unique check (
    object_ref ~ '^knowledge/[a-z0-9][a-z0-9/_.-]*$'
    and char_length(object_ref) between 12 and 512
    and object_ref not like '%//%'
    and object_ref not like '%../%'
  ),
  -- Byte bound of the grant. The ceiling is plan §7.5's 20 MB pilot document; a caller may declare
  -- less, never more, and `register_source_version_v1` re-checks the measured size against it.
  max_size_bytes bigint not null check (max_size_bytes between 1 and 20971520),
  state text not null default 'awaiting_upload'
    check (state in ('awaiting_upload', 'completed', 'quarantined', 'failed', 'expired')),
  -- Closed vocabulary of safe reason codes. Detail never travels in the database or the API: the
  -- file name, the object key and document text are not error messages (plan §8.2).
  reason_code text check (
    reason_code is null or reason_code in (
      'object_missing', 'empty_object', 'size_exceeded', 'hash_mismatch', 'signature_mismatch',
      'unsupported_type', 'malformed_pdf', 'encrypted_pdf', 'decompression_bomb', 'scan_truncated',
      'session_expired'
    )
  ),
  -- Set when the session closes: the source/version this session captured (or pointed at, on a
  -- content hit). ON DELETE SET NULL: losing the document must not destroy the record that someone
  -- captured it (audit and retention are per category, §7.5).
  source_id uuid,
  source_version_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_upload_sessions_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  -- Composite FK: a session can never be pointed at another tenant's collection, whatever a caller
  -- puts in the body (§6.2).
  constraint knowledge_upload_sessions_collection_fk
    foreign key (collection_id, organisation_id)
    references public.knowledge_collections (id, organisation_id) on delete restrict,
  constraint knowledge_upload_sessions_source_fk
    foreign key (source_id, organisation_id)
    references public.knowledge_sources (id, organisation_id) on delete set null,
  constraint knowledge_upload_sessions_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete set null,
  -- A completed session names the version it completed into; a closed session says why it closed.
  constraint knowledge_upload_sessions_completed_marker
    check (state <> 'completed' or source_version_id is not null),
  constraint knowledge_upload_sessions_closed_marker
    check (state not in ('quarantined', 'failed') or reason_code is not null),
  constraint knowledge_upload_sessions_open_marker
    check (state <> 'awaiting_upload' or reason_code is null),
  unique (id, organisation_id),
  unique (organisation_id, created_by, idempotency_key)
);
comment on table public.knowledge_upload_sessions is
  'A bounded, tenant- and uploader-bound grant to put one object at one server-issued key, and the record of what became of it (plan §7.2 step 1, §9.2.1).';
comment on column public.knowledge_upload_sessions.object_ref is
  'Issued by begin_upload_session_v1 from the transaction tenant plus a fresh uuid. No function here accepts an object key, so no caller can choose or guess one into use (F09).';
comment on column public.knowledge_upload_sessions.max_size_bytes is
  'Ceiling 20971520 bytes (plan §7.5). The measured size at completion is re-checked against it in SQL, independent of whatever the application did.';

/**
 * Session identity is fixed at issue time, and a closed capture stays closed. This trigger is what
 * makes that true for a privileged path too: the RPCs are SECURITY DEFINER and run as the owner, so
 * a policy could not stop them — the guard does (§4.3).
 */
create or replace function public.knowledge_upload_sessions_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.organisation_id is distinct from old.organisation_id
     or new.collection_id is distinct from old.collection_id
     or new.created_by is distinct from old.created_by
     or new.idempotency_key is distinct from old.idempotency_key
     or new.filename is distinct from old.filename
     or new.object_ref is distinct from old.object_ref
     or new.max_size_bytes is distinct from old.max_size_bytes
     or new.created_at is distinct from old.created_at
  then
    raise exception 'upload session % keeps its tenant, collection, uploader, key and byte bound (§7.2 step 1)', old.id
      using errcode = '23514';
  end if;
  if old.state = 'completed' and new.state is distinct from old.state then
    raise exception 'upload session % is completed: a capture is never reopened (§7.2)', old.id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger knowledge_upload_sessions_guard before update on public.knowledge_upload_sessions
  for each row execute function public.knowledge_upload_sessions_guard();
create trigger knowledge_upload_sessions_touch_updated before update on public.knowledge_upload_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- publish permission
/**
 * May the caller publish *into* this collection? Active membership of the transaction tenant, the
 * collection's project audience, and a role permission at `write` or `admin` on `knowledge.write`
 * (the area #39 will seed) or `knowledge.admin` (the area the seed already grants to a tenant admin).
 *
 * Deliberately not granted to `authenticated`: it is the shared predicate of the capture RPCs, not
 * an API surface. A caller who asks and gets false learns nothing it could not learn by trying.
 */
create or replace function public.user_may_publish_into(p_collection_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.knowledge_collections c
      join public.organisations o
        on o.id = c.organisation_id and o.status = 'active'
      join public.organisation_memberships m
        on m.organisation_id = c.organisation_id
       and m.user_id = auth.uid()
       and m.status = 'active'
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.area in ('knowledge.write', 'knowledge.admin')
       and rp.level in ('write', 'admin')
     where c.id = p_collection_id
       and c.organisation_id = public.current_organisation_id()
       and (c.project_id is null or public.is_project_member(c.project_id))
  );
$$;

comment on function public.user_may_publish_into(uuid) is
  'Publish predicate for capture: active membership + tenant scope + project audience + knowledge.write|knowledge.admin at write|admin. Read permission alone never grants it (issue #39).';

-- ---------------------------------------------------------------- scoped capture RPCs
/**
 * Issue an upload session: authorize the collection and the caller, then generate the object key.
 *
 * Every identity comes from the database session, and none of it from an argument: the only
 * parameters are the destination collection, a retry key, an advisory file name and an optional
 * declared size that may only *lower* the bound. That is the whole defence against a forged
 * tenant/uploader/key, and it holds even if the application layer is bypassed (§4.1, F09).
 */
create or replace function public.begin_upload_session_v1(
  p_collection_id uuid,
  p_idempotency_key text,
  p_filename text,
  p_declared_size_bytes bigint
) returns table (
  o_session_id uuid,
  o_object_ref text,
  o_max_size_bytes bigint,
  o_expires_at timestamptz,
  o_state text,
  o_reused boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid := public.current_organisation_id();
  v_user uuid := auth.uid();
  v_session public.knowledge_upload_sessions;
  v_collection public.knowledge_collections;
  v_max bigint;
  v_open int;
begin
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required for an upload session' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'idempotency key must be 8-64 url-safe characters' using errcode = '22023';
  end if;
  if p_filename is null or char_length(p_filename) > 200 or p_filename ~ '[[:cntrl:]/\\]' then
    raise exception 'filename must be a bare name without paths or control characters' using errcode = '22023';
  end if;

  -- Retry of the same logical request: hand back the same session and the same key.
  select * into v_session
    from public.knowledge_upload_sessions
   where organisation_id = v_organisation
     and created_by = v_user
     and idempotency_key = p_idempotency_key;
  if found then
    o_session_id := v_session.id;
    o_object_ref := v_session.object_ref;
    o_max_size_bytes := v_session.max_size_bytes;
    o_expires_at := v_session.expires_at;
    o_state := v_session.state;
    o_reused := true;
    return next;
    return;
  end if;

  -- A collection of another tenant and a collection that does not exist give the same refusal as a
  -- permission failure: no existence signal for someone who may not see the corpus (#13(2)).
  select * into v_collection
    from public.knowledge_collections
   where id = p_collection_id and organisation_id = v_organisation;
  if not found then
    raise exception 'collection not found in this organization' using errcode = '42501';
  end if;
  if not public.user_may_publish_into(p_collection_id) then
    raise exception 'not permitted to publish into this collection' using errcode = '42501';
  end if;

  -- Storage quota (plan §9.2.1): open grants per uploader, bounded, so one person cannot hold an
  -- unlimited number of private object keys open.
  select count(*) into v_open
    from public.knowledge_upload_sessions
   where organisation_id = v_organisation
     and created_by = v_user
     and state = 'awaiting_upload'
     and expires_at > now();
  if v_open >= 10 then
    raise exception 'too many open upload sessions' using errcode = '53100';
  end if;

  -- A declared size may only narrow the grant, never widen it past the plan's 20 MB meter.
  v_max := 20971520;
  if p_declared_size_bytes is not null
     and p_declared_size_bytes between 1 and 20971520
     and p_declared_size_bytes < v_max
  then
    v_max := p_declared_size_bytes;
  end if;

  insert into public.knowledge_upload_sessions (
    organisation_id, collection_id, created_by, idempotency_key, filename, object_ref,
    max_size_bytes, expires_at
  ) values (
    v_organisation, p_collection_id, v_user, p_idempotency_key, p_filename,
    -- The key: tenant prefix from the *transaction*, a uuid we just drew, and a fixed leaf name.
    -- Nothing the client typed is part of it.
    'knowledge/' || v_organisation::text || '/uploads/' || gen_random_uuid()::text || '/object',
    v_max, now() + interval '30 minutes'
  )
  returning * into v_session;

  o_session_id := v_session.id;
  o_object_ref := v_session.object_ref;
  o_max_size_bytes := v_session.max_size_bytes;
  o_expires_at := v_session.expires_at;
  o_state := v_session.state;
  o_reused := false;
  return next;
end;
$$;

/**
 * The capture itself — the only way a `knowledge_sources` and a `source_versions` row come into
 * existence from an employee request (#13(1), FAQ-0004).
 *
 * The caller supplies the session id, the digest the application computed over the bytes it read,
 * the measured size, and the detected media type. Everything that decides *who* and *where* —
 * tenant, uploader, collection, object key, data class, index generation — is read back from the
 * session row and the database session, never from an argument. There is no parameter for the
 * object key at all: an uploaded file cannot be captured under a key someone else picked, and a
 * session cannot be completed into a different collection than the one it was issued for.
 */
create or replace function public.register_source_version_v1(
  p_upload_session_id uuid,
  p_content_hash text,
  p_size_bytes bigint,
  p_media_type text
) returns table (
  o_source_id uuid,
  o_source_version_id uuid,
  o_state text,
  o_already_uploaded boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid := public.current_organisation_id();
  v_user uuid := auth.uid();
  v_session public.knowledge_upload_sessions;
  v_collection public.knowledge_collections;
  v_existing_version public.source_versions;
  v_source_id uuid;
  v_version_id uuid;
  v_index_generation int;
begin
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to register a source version' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'content hash must be 64 lowercase hex characters' using errcode = '22023';
  end if;
  if p_media_type is null or p_media_type !~ '^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$' then
    raise exception 'media type must be a bare type/subtype token' using errcode = '22023';
  end if;

  -- `for update` is what makes a double-posted completion serialize behind the first one instead of
  -- racing two versions into the same dedup key.
  select * into v_session
    from public.knowledge_upload_sessions
   where id = p_upload_session_id
     and organisation_id = v_organisation
     and created_by = v_user
   for update;
  if not found then
    -- Same refusal for unknown, foreign-tenant and somebody-else's session: probing for a session
    -- id learns nothing (§4.2, #13(2)).
    raise exception 'upload session not found in this scope' using errcode = '42501';
  end if;

  -- A completed session replays: the caller gets the same ids and the same state, and nothing is
  -- written. `attempt` is not part of any key here, so a retry cannot mint a second version.
  if v_session.state = 'completed' then
    o_source_id := v_session.source_id;
    o_source_version_id := v_session.source_version_id;
    o_state := (select state from public.source_versions where id = v_session.source_version_id);
    o_already_uploaded := true;
    return next;
    return;
  end if;
  if v_session.state <> 'awaiting_upload' then
    raise exception 'upload session is closed' using errcode = '42501';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'upload session has expired' using errcode = '42501';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > v_session.max_size_bytes then
    raise exception 'measured size is outside the bound of this upload session' using errcode = '22023';
  end if;

  -- Publish permission is re-checked at completion: a role or project membership can have been
  -- removed since the session was issued, and a stale grant must not capture a source (§4.2).
  if not public.user_may_publish_into(v_session.collection_id) then
    raise exception 'not permitted to publish into this collection' using errcode = '42501';
  end if;

  select * into v_collection
    from public.knowledge_collections
   where id = v_session.collection_id and organisation_id = v_organisation;
  if not found then
    raise exception 'collection not found in this organization' using errcode = '42501';
  end if;

  -- The stage row must name the tenant's pinned generation. Deriving it here is what keeps this
  -- packet out of the open pin decision (#6) and stops a job being written that no worker could run.
  select generation into v_index_generation
    from public.embedding_indexes
   where index_key = 'corpus' and status = 'active' and organisation_id = v_organisation;
  if v_index_generation is null then
    -- No write happens: the caller sees a refusal with a safe code and can retry after the pin.
    raise exception 'no active embedding index for this organization' using errcode = '55000';
  end if;

  -- Content dedup, scoped to the collection that holds it (#13(2), §6.2). The unique constraint
  -- below is the authority; this lookup only decides whether the hit may be *reported*.
  select * into v_existing_version
    from public.source_versions
   where collection_id = v_session.collection_id and content_hash = p_content_hash;
  if found then
    if not public.collection_is_readable(v_session.collection_id) then
      -- A copy this caller cannot read is refused exactly like any other violation: the response
      -- must not distinguish "already here" from "not allowed here".
      raise exception 'not permitted to publish into this collection' using errcode = '42501';
    end if;
    update public.knowledge_upload_sessions
       set state = 'completed', source_id = v_existing_version.source_id,
           source_version_id = v_existing_version.id
     where id = v_session.id and organisation_id = v_organisation;
    o_source_id := v_existing_version.source_id;
    o_source_version_id := v_existing_version.id;
    o_state := v_existing_version.state;
    o_already_uploaded := true;
    return next;
    return;
  end if;

  -- One source per accepted capture (kind is fixed by this RPC, not chosen by the caller), then the
  -- immutable version. Corrections are a new capture into the same collection, which the dedup key
  -- above resolves to the existing version; a *changed* document is a different source in M1, and
  -- the replacement flow is T-213's.
  insert into public.knowledge_sources (organisation_id, collection_id, kind, owner_user_id)
    values (v_organisation, v_session.collection_id, 'upload', v_user)
    returning id into v_source_id;

  insert into public.source_versions (
    organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
    content_hash, object_ref, state, parser_generation, payload
  ) values (
    v_organisation, v_source_id, v_session.collection_id, 1, v_user, v_collection.data_class,
    p_content_hash, v_session.object_ref, 'received', 'v1',
    jsonb_build_object(
      'upload_session_id', v_session.id,
      -- Capture metadata as data: the file name is the uploader's label, the media type is what the
      -- byte check detected. Neither is ever interpreted (AGENTS.md §4.8).
      'filename', v_session.filename,
      'media_type', p_media_type,
      'size_bytes', p_size_bytes
    )
  )
  -- A concurrent duplicate loses here (23505 on unique (collection_id, content_hash)); the
  -- exception block below turns that into the same answer the pre-check would have given, so the
  -- constraint, not the pre-check, is what guarantees one version per (collection, content).
  returning id into v_version_id;

  -- One stage row for the cloud extractor, idempotent on the stage key (§7.5). Outbox dispatch is
  -- at-least-once, so the enqueue has to tolerate a repeat delivery: `attempt` stays out of the key.
  insert into public.ingestion_jobs (
    organisation_id, source_version_id, stage, executor, status, data_class,
    parser_generation, index_generation
  ) values (
    v_organisation, v_version_id, 'extract', 'cloud_worker', 'queued', v_collection.data_class,
    'v1', v_index_generation
  )
  on conflict (organisation_id, source_version_id, stage, parser_generation, index_generation)
    do nothing;

  update public.knowledge_upload_sessions
     set state = 'completed', source_id = v_source_id, source_version_id = v_version_id
   where id = v_session.id and organisation_id = v_organisation;

  o_source_id := v_source_id;
  o_source_version_id := v_version_id;
  o_state := 'received';
  o_already_uploaded := false;
  return next;
exception
  when unique_violation then
    -- Lost a race on (collection_id, content_hash): report the winner if the caller can read that
    -- collection, and refuse with the generic permission code if not. Nothing is half-written: the
    -- failing statement rolled the whole capture back.
    select * into v_existing_version
      from public.source_versions
     where collection_id = v_session.collection_id and content_hash = p_content_hash;
    if not found or not public.collection_is_readable(v_session.collection_id) then
      raise exception 'not permitted to publish into this collection' using errcode = '42501';
    end if;
    update public.knowledge_upload_sessions
       set state = 'completed', source_id = v_existing_version.source_id,
           source_version_id = v_existing_version.id
     where id = v_session.id and organisation_id = v_organisation;
    o_source_id := v_existing_version.source_id;
    o_source_version_id := v_existing_version.id;
    o_state := v_existing_version.state;
    o_already_uploaded := true;
    return next;
end;
$$;

/**
 * Records a capture that the application refused: a wrong signature, an encrypted PDF, a stream that
 * blows the decompression budget, a hash mismatch, an oversized or empty object. The point is that a
 * refusal is *visible* — a session row with a state and a safe reason code — instead of a document
 * that quietly never arrives (plan §7.2: "a failed parse is visible, not an empty successful
 * source"). No source, version, job or outbox row exists in this path, which is what
 * `register_source_version_v1` guarantees by being the only writer.
 */
create or replace function public.record_upload_outcome_v1(
  p_upload_session_id uuid,
  p_state text,
  p_reason_code text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid := public.current_organisation_id();
  v_user uuid := auth.uid();
  v_session public.knowledge_upload_sessions;
begin
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required' using errcode = '28000';
  end if;
  if p_state is null or p_state not in ('quarantined', 'failed') then
    raise exception 'an outcome must be quarantined or failed' using errcode = '22023';
  end if;
  if p_reason_code is null or p_reason_code not in (
      'object_missing', 'empty_object', 'size_exceeded', 'hash_mismatch', 'signature_mismatch',
      'unsupported_type', 'malformed_pdf', 'encrypted_pdf', 'decompression_bomb', 'scan_truncated',
      'session_expired')
  then
    raise exception 'unknown upload outcome code' using errcode = '22023';
  end if;

  select * into v_session
    from public.knowledge_upload_sessions
   where id = p_upload_session_id
     and organisation_id = v_organisation
     and created_by = v_user
   for update;
  if not found then
    raise exception 'upload session not found in this scope' using errcode = '42501';
  end if;
  if v_session.state = 'completed' then
    raise exception 'a completed capture cannot be re-quarantined (§7.2)' using errcode = '23514';
  end if;
  if v_session.state in ('quarantined', 'failed') then
    -- First refusal wins: the reason an object was kept out of the corpus is audit information, not
    -- something a later retry overwrites.
    return;
  end if;

  update public.knowledge_upload_sessions
     set state = p_state, reason_code = p_reason_code
   where id = v_session.id and organisation_id = v_organisation;
end;
$$;

-- ---------------------------------------------------------------- RLS
alter table public.knowledge_upload_sessions enable row level security;

-- A member reads their own sessions in their own tenant scope, and nothing else: the object key and
-- the expiry are already in their client, but another employee's session rows are not information
-- they need (or get) (§6.2, §8.2).
create policy knowledge_upload_sessions_owner_read on public.knowledge_upload_sessions
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and created_by = auth.uid()
  );

-- No INSERT/UPDATE/DELETE policy for `authenticated` on this table at all, matching the knowledge
-- tables: an employee's membership says what they may read, never that they may open a storage
-- grant, close a session or rewrite a capture outcome. The three RPCs below are the write surface,
-- and the guard trigger above constrains them.

-- ---------------------------------------------------------------- grants (per object, never blanket)
-- Supabase auto-exposes new `public` tables to anon/authenticated, so revoke on this table by name.
-- `revoke all on all tables in schema public` would also strip the grants the merged tenancy and
-- knowledge migrations gave on purpose, so it is not used anywhere in this migration.
revoke all on public.knowledge_upload_sessions from anon, authenticated;
grant select on public.knowledge_upload_sessions to authenticated;

-- Functions in `public` start out executable by PUBLIC, so each new function is revoked by name and
-- then granted back only to the role that needs it. `user_may_publish_into` stays closed: it is an
-- internal predicate of the capture RPCs, not an endpoint.
revoke execute on function
  public.user_may_publish_into(uuid),
  public.begin_upload_session_v1(uuid, text, text, bigint),
  public.register_source_version_v1(uuid, text, bigint, text),
  public.record_upload_outcome_v1(uuid, text, text)
  from public, anon, authenticated;

grant execute on function
  public.begin_upload_session_v1(uuid, text, text, bigint),
  public.register_source_version_v1(uuid, text, bigint, text),
  public.record_upload_outcome_v1(uuid, text, text)
  to authenticated;

comment on function public.begin_upload_session_v1(uuid, text, text, bigint) is
  'Scoped RPC: authorizes tenant, membership, collection audience and publish permission, then issues the private object key. Tenant and uploader come from the database session, never from arguments (§7.2 step 1, F09).';
comment on function public.register_source_version_v1(uuid, text, bigint, text) is
  'The only capture write path for an employee request (#13(1), FAQ-0004): source + immutable version + extract stage row in one statement, uploaded_by = auth.uid(), object_ref and data class read back from the session and the collection, index generation derived from the tenant''s active corpus index. Duplicate completions replay; a content hit is reported only inside a readable collection (#13(2)).';
comment on function public.record_upload_outcome_v1(uuid, text, text) is
  'Records a refused capture (quarantined/failed + safe reason code) so a failure is visible instead of silent (§7.2). Writes nothing to the knowledge tables.';
comment on function public.knowledge_upload_sessions_guard() is
  'Session identity, issued key and byte bound are fixed at issue time, and a completed capture never reopens — enforced for privileged paths too (§4.3).';
