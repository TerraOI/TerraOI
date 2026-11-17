-- T-112c — the capture RPCs establish their own tenant scope (#163 / FAQ-0011), and the two #96 holes
-- close: the `completed` replay stops disclosing, and the session guard closes the state machine.
--
-- This is a **new** migration, as AGENTS.md §6 requires: `20261106100000_knowledge_uploads.sql` is on
-- `main`, so it is never edited. Everything here replaces merged objects by name (`create or replace
-- function`, `drop function`) in a file that sorts after it, which is how #96's own ruling asks for the
-- fix ("one follow-up migration fixes them, as slice T-112c").
--
-- Ruling 1 — #163 / FAQ-0011, the same shape already landed for the collection admin RPCs in #157:
--   `begin_upload_session_v1`, `register_source_version_v1` and `record_upload_outcome_v1` take
--   `p_organisation_id uuid` as their **first** parameter and their **first statement** is
--   `perform public.set_tenant_scope(p_organisation_id);`, in the same transaction as the write
--   (plan §4.3:245-247). That makes them `volatile` (#163 rule 4), which
--   `041_knowledge_uploads_guard.test.sql` pins from `pg_proc.provolatile` by full signature rather
--   than trusting this text, and pins the ordering in `prosrc` (assertions 7-9) so a later edit cannot
--   move the scope call below the first read. The argument confers nothing: `set_tenant_scope` refuses
--   unless `auth.uid()` is an active member of that organisation (`tenancy_core.sql:203-220`) —
--   a null caller `28000`, a null tenant `22023`, a tenant the caller does not actively belong to
--   `28000`. The caller can only ever choose among tenants they already belong to; RLS and the
--   `organisation_id = v_organisation` predicates below keep working exactly as before, because these
--   functions are SECURITY DEFINER and a definer body bypasses RLS (`tenancy_core.sql:251-256`).
--   `auth.uid()` is unaffected by the definer clause — it reads the request's claims, not the
--   executing role (#163 rule 5) — which is why `uploaded_by` is still the human who signed in and
--   never a parameter (#8, F09).
--
--   **Why the old signatures are dropped here and nowhere else was asked for.** #163: "the old
--   signatures are dropped, which is safe because no adapter calls them (`upload-adapters.ts:19-21`)".
--   That premise holds for the TypeScript — the adapter still returns its typed "unavailable" refusal
--   and no route runs a capture in staging (§6a) — but it does not hold for the merged pgTAP suite:
--   `040_knowledge_uploads.test.sql` calls these three RPCs at 22 sites under `plan(63)`. That gap in
--   the ruling is filed as [#169](https://github.com/TerraOI/TerraOI/issues/169), which asks for the
--   scoped edit of `040` (add the leading argument; change no assertion). Until it is answered this PR
--   is labeled `provisional` with `Provisional on: #169`, so the gate blocks the merge. Keeping the old
--   shapes as wrappers was rejected on the issue: it would leave six capture endpoints executable by
--   `authenticated`, three of them with a tenant that nothing verifies.
--
-- Ruling 2 — #96 clause 1, the replay disclosure. `register_source_version_v1`'s `completed` branch used
--   to hand back `source_id` / `source_version_id` / state on the strength of the session row alone.
--   "You captured it, so you may always see it" was not the intent: a member who loses the project
--   membership — the ordinary case of a field engineer leaving a site — must get a refusal, not the ids.
--   The branch now (a) looks the version up with `organisation_id` in the predicate, and (b) requires
--   `source_is_readable` before a single column is placed on the result, raising the **same** message and
--   the same `42501` as the dedup branch (`:422-427`) and the unique-violation race branch
--   (`:497-499`). `041` asserts the two refusals are byte-identical (SQLSTATE *and* text), so the replay
--   cannot be used as an existence oracle and no id leaks through the column list (36-38).
--   The composite FK `knowledge_upload_sessions_source_version_fk (source_version_id, organisation_id)`
--   already makes a cross-tenant version id unrepresentable; the tenant predicate is the belt behind
--   those braces and `041` pins it in the body (40), because no member-reachable fixture can reach it.
--
-- Ruling 3 — #96 clause 2, the guard. `knowledge_upload_sessions_guard()` gains two clauses:
--   `expires_at` is immutable (re-opening a stuck upload means issuing a **new** session with a new
--   object key, never extending a grant a client already holds), and only `awaiting_upload` may change
--   state — `completed`, `quarantined`, `failed` and `expired` are final, refused with `23514` for every
--   writer, including the privileged path these definer RPCs run on (§4.3). `awaiting_upload → expired`
--   stays legal, which is all the future expiry sweep needs. "First refusal wins" (`:561-563`) is now a
--   property of the table rather than one function's early return.
--
-- Privileges (#60, FAQ-0010): each new function is revoked from `public, anon, authenticated` **by full
--   signature** in this migration and granted back to `authenticated` only — the same per-function
--   pattern the merged file uses, because a migration cannot close PostgreSQL's PUBLIC default and a
--   blanket schema revoke would strip grants other packets gave on purpose. `001_function_privileges
--   .test.sql`'s rule-32 allow-list is updated with the three new signatures in this PR: AGENTS.md §4.2
--   and FAQ-0010 make that edit a standing instruction, since the list enumerates the functions that
--   actually exist. `user_may_publish_into(uuid)` stays ungranted: an internal predicate is not an
--   endpoint to probe (#39).

-- ---------------------------------------------------------------- 1. drop the pre-#163 shapes (#163)
-- Explicit and by full signature, so a reviewer can see exactly what stopped existing. Nothing on
-- `main` calls these three shapes in TypeScript (`src/platform/knowledge/upload-adapters.ts:19-21`
-- returns the typed unavailable refusal and no route claims a capture path); the only other caller is
-- `040_knowledge_uploads.test.sql`, which is what #169 exists to authorize.
drop function if exists public.begin_upload_session_v1(uuid, text, text, bigint);
drop function if exists public.register_source_version_v1(uuid, text, bigint, text);
drop function if exists public.record_upload_outcome_v1(uuid, text, text);

-- ---------------------------------------------------------------- 2. issue an upload session
create or replace function public.begin_upload_session_v1(
  p_organisation_id uuid,
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
  v_organisation uuid;
  v_user uuid;
  v_session public.knowledge_upload_sessions;
  v_collection public.knowledge_collections;
  v_max bigint;
  v_open int;
begin
  -- #163 rule 2, first statement: verify membership in the named tenant, then establish the scope for
  -- the rest of this transaction. Nothing above this line reads a tenant table.
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required for an upload session' using errcode = '28000';
  end if;
  -- Restates what set_tenant_scope already checked, in the body that depends on it (§4.2): same
  -- predicate, same 28000, so a change to that helper cannot quietly widen this write path.
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'idempotency key must be 8-64 url-safe characters' using errcode = '22023';
  end if;
  if p_filename is null or char_length(p_filename) > 200 or p_filename ~ '[[:cntrl:]/\\]' then
    raise exception 'filename must be a bare name without paths or control characters' using errcode = '22023';
  end if;

  -- Retry of the same logical request: hand back the same session and the same key. Still keyed on the
  -- tenant *and* the uploader, so a retry cannot reach across either boundary (#4.2).
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
    -- The key: tenant prefix from the verified scope, a uuid drawn here, a fixed leaf name. Nothing the
    -- client typed is part of it, and now nothing an argument typed is part of it either (F09).
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

comment on function public.begin_upload_session_v1(uuid, uuid, text, text, bigint) is
  'Scoped RPC: p_organisation_id first and the scope established by set_tenant_scope as the first statement (FAQ-0011, #163); membership in that tenant is verified before any read. Then authorizes collection audience and publish permission, and issues the private object key from the verified tenant. No object key, uploader, class or audience parameter exists to forge (#7.2 step 1, F09).';

-- ---------------------------------------------------------------- 3. the capture itself
create or replace function public.register_source_version_v1(
  p_organisation_id uuid,
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
  v_organisation uuid;
  v_user uuid;
  v_session public.knowledge_upload_sessions;
  v_collection public.knowledge_collections;
  v_existing_version public.source_versions;
  v_replay_version public.source_versions;
  v_source_id uuid;
  v_version_id uuid;
  v_index_generation int;
begin
  -- #163 rule 2, first statement — before the session lookup that decides whose capture this is.
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
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
  --
  -- #96 clause 1: the replay is not a right of the person who captured. The version is looked up with
  -- the tenant in the predicate, and `source_is_readable` (scope + active membership + the
  -- collection's project audience) has to answer true before a single column goes on the result. When
  -- it does not, the refusal is the dedup branch's refusal — same message, same 42501 — so "already
  -- here and you may see it" and "not allowed here" are the same answer (#13(2)).
  if v_session.state = 'completed' then
    select * into v_replay_version
      from public.source_versions sv
     where sv.id = v_session.source_version_id
       and sv.organisation_id = v_organisation;
    if not found or not public.source_is_readable(v_replay_version.source_id) then
      raise exception 'not permitted to publish into this collection' using errcode = '42501';
    end if;
    o_source_id := v_replay_version.source_id;
    o_source_version_id := v_replay_version.id;
    o_state := v_replay_version.state;
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

comment on function public.register_source_version_v1(uuid, uuid, text, bigint, text) is
  'The only capture write path for an employee request (#13(1), FAQ-0004). p_organisation_id first, scope established by set_tenant_scope as the first statement (FAQ-0011, #163). uploaded_by = auth.uid(); object_ref, data class and index generation are read back, never argued. A completed session replays only to a caller who can still read the version — tenant-filtered lookup plus source_is_readable — and the refusal is identical to the dedup and race refusals (#96 clause 1, #13(2)).';

-- ---------------------------------------------------------------- 4. record a refused capture
create or replace function public.record_upload_outcome_v1(
  p_organisation_id uuid,
  p_upload_session_id uuid,
  p_state text,
  p_reason_code text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_session public.knowledge_upload_sessions;
begin
  -- #163 rule 2, first statement.
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
    -- something a later retry overwrites. #96 clause 2 makes the guard enforce that for every writer
    -- too; this early return is what keeps a retry a no-op instead of an error for the caller.
    return;
  end if;

  update public.knowledge_upload_sessions
     set state = p_state, reason_code = p_reason_code
   where id = v_session.id and organisation_id = v_organisation;
end;
$$;

comment on function public.record_upload_outcome_v1(uuid, uuid, text, text) is
  'Records a refused capture (quarantined/failed + safe reason code) so a failure is visible instead of silent (§7.2). p_organisation_id first, scope established by set_tenant_scope as the first statement (FAQ-0011, #163). Writes nothing to the knowledge tables.';

-- ---------------------------------------------------------------- 5. the session guard (#96 clause 2)
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

  -- #96 clause 2, first half: the grant''s lifetime is fixed when the grant is issued. A stuck upload
  -- is answered by issuing a new session — new id, new object key, new expiry — never by stretching a
  -- key a client may already have written to.
  if new.expires_at is distinct from old.expires_at then
    raise exception 'upload session % keeps its expiry: re-opening an upload issues a new session (§7.2 step 1)', old.id
      using errcode = '23514';
  end if;

  -- #96 clause 2, second half: completed, quarantined, failed and expired are final. The only legal
  -- transition is awaiting_upload -> one of them, which is also exactly what a future expiry sweep
  -- does. Enforced here rather than in one function''s early return, because the definer RPCs, the
  -- pipeline and any later privileged writer all land on the same constraint (§4.3).
  if old.state <> 'awaiting_upload' and new.state is distinct from old.state then
    raise exception 'upload session % is %: only awaiting_upload may change state (§7.2)', old.id, old.state
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.knowledge_upload_sessions_guard() is
  'Session identity, issued key, byte bound and expiry are fixed at issue time, and completed/quarantined/failed/expired are final: only awaiting_upload may change state. Enforced for privileged paths too, which is the point of a trigger rather than a policy (§4.3, #96 clause 2).';

-- ---------------------------------------------------------------- 6. privileges (#60, FAQ-0010)
-- New signatures, so the PUBLIC default has to be closed again by full signature, then granted back
-- to the one request role. `anon` and `service_role` get nothing here: as in the merged migration,
-- capture is a signed-in member action and the pipeline reaches these rows as the owner.
revoke execute on function
  public.begin_upload_session_v1(uuid, uuid, text, text, bigint),
  public.register_source_version_v1(uuid, uuid, text, bigint, text),
  public.record_upload_outcome_v1(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function
  public.begin_upload_session_v1(uuid, uuid, text, text, bigint),
  public.register_source_version_v1(uuid, uuid, text, bigint, text),
  public.record_upload_outcome_v1(uuid, uuid, text, text)
  to authenticated;
