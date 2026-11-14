-- T-104 — chat persistence: the three tables plan §9.1 names (`conversations`, `messages`,
-- `agent_runs`) plus the answer↔evidence dependency rows (`agent_run_evidence`), and the seven
-- tenant-scoped RPCs that are the only way anything writes or reads them.
--
-- Lane 1 owns this path (docs/REPO-STRUCTURE.md, .github/CODEOWNERS); the tables are read by
-- Lane 2's packets (T-213 staleness, T-214 withdrawal, T-215 run facts) through **their own**
-- migrations, never by widening anything here (FAQ-0004). Acceptance tests:
-- `supabase/tests/database/035_chat_persistence.test.sql` (slot 035), written first and pushed as
-- the red run.
--
-- What the four tables are for (§9.1, §13.1, §6.2):
--   * `conversations`  — a named chat between one employee and one expert, optionally bound to a
--                        project. Private to its creator by default: plan §9.1:234 says the tenant
--                        origin shows the employee their **own** chat history, and the admin audit
--                        trail (§13.1) is not built here (§13.1 needs its own packet, and a policy
--                        that reads other people's chats is a decision, not a column).
--   * `messages`       — the visible history, `role` limited to the two roles the server itself
--                        writes. The browser's transcript is never history (F17), so nothing else
--                        is representable here either.
--   * `agent_runs`     — one row per run, created when the run starts and completed exactly once.
--                        Carries the answer json, the highest data class among the run's
--                        dependencies, the expert versions and corpus generations it was produced
--                        under, and the `policy_revision` it was authorized under (§9.4:263).
--   * `agent_run_evidence` — the dependency rows: which claim cited which source version and chunk.
--                        This is the table T-213 invalidates answers by (generation) and T-214
--                        withholds answers by (source), so the source-version id is a real composite
--                        FK and each row keeps the class of **the source it cites**, read from
--                        `source_versions` rather than supplied by the caller (§6.2).
--
-- Tenancy and the write path (#163, FAQ-0011, plan §4.3:245-249): every RPC takes
-- `p_organisation_id uuid` **first** and its first statement is
-- `perform public.set_tenant_scope(p_organisation_id);`, in the same transaction as its work. The
-- argument confers nothing — `set_tenant_scope` refuses unless `auth.uid()` is an active member of
-- that organisation (tenancy_core.sql:203-220) — and there is no user, role or actor parameter on any
-- of them to forge (§4.1, F09). Because a SECURITY DEFINER body bypasses RLS (these tables are
-- `enable`d, not `force`d — tenancy_core.sql:251-256), the `organisation_id = v_organisation` and
-- owner predicates inside the bodies are load-bearing, not cosmetic; that is the same reasoning
-- #156 records for the knowledge write RPCs, and the reason every merged write-path RPC here is a
-- definer.
--
-- Why the tables also have SELECT policies and a table-level `grant select` to `authenticated`,
-- when every read this packet dials is an RPC: plan §9.1:236 states the merged rule that "the
-- conversation-history query is a normal RLS-scoped read, so the employee's own conversations come
-- from their tenant origin and nowhere else". The policies are what make that true for the history
-- surface T-311 builds, and they are what 035 tests (32-34, 59-63): an owner can read their own rows
-- and a foreign tenant, a co-worker, or a suspended membership reads nothing. No request role gets a
-- write privilege (035 test 7), so "writes go through scoped RPCs" is still the only door.
--
-- #10 and plan §4.4: **no column here is an object key, a signed URL or any other grant.** Citation
-- access is a separate re-authorized call (T-203, F24), so `agent_run_evidence` stores the source
-- version id and the quoted text and nothing that could be replayed. 035 test 69 enumerates the
-- columns, and `chat_answer_json_guard` refuses an `answer_json` carrying a key named like a grant or
-- a provider/model detail at any depth, so the persisted answer stays what `src/contracts/answer.ts`
-- says an answer is (§9.3: provider identity is tenant-admin detail; §8.2: no signed grants).
--
-- Failure vocabulary, one code per refusal class, with no existence signal across tenants (#13(2)):
--   28000 no session identity, or no active membership in the tenant named (comes from set_tenant_scope)
--   42501 not permitted: another tenant's row, another user's conversation, a project the caller is
--         not a member of, a citation the caller may not read, or a missing `chat.ask` permission
--   22023 a malformed argument, checked before anything is written
--   23514 a guard trigger refused the row (immutability, class or grant-shaped key)
-- "Not found" and "not allowed" are the same answer on purpose: a conversation id belonging to
-- another tenant must not be distinguishable from one that does not exist (035 tests 57-58, 61-62).
--
-- #60 / FAQ-0010: every function created here is revoked from `public, anon, authenticated` by full
-- signature in this same migration, and only the seven RPCs are granted back to `authenticated`.
-- Those seven signatures are added to `001_function_privileges.test.sql`'s rule-32 allow-list in the
-- same PR; 035 test 13 pins the same set, and test 12 pins the pinned `search_path` that
-- 000_guardrails.test.sql requires of every definer.
--
-- Deliberately NOT here:
--   * No expert registry or permission-to-use-an-expert table. `expert_versions`, `allowed_services`
--     and `allowed_projects` are T-113's, and the grant table plan §10.1:284 assigns to **T-102c**
--     (`expert_grants`). The `expert_key` column here records what a conversation was held with; it
--     authorizes nothing, and the route that decides "may this employee use this expert" is in
--     `src/platform/chat/` with a fail-closed port until T-102c lands (see the PR note).
--   * No `chat.ask` seeding — the two rows seed.sql already carries are the gate this file reads.
--   * No admin/audit view of other employees' chats (§13.1), no `answer_run_outcomes` (T-214 adds it),
--     no feedback columns (T-302), no action/draft columns (T-313), and no column for a signed URL,
--     ever (#10).

-- ---------------------------------------------------------------- constraint helpers
/**
 * True when every element of `p_values` is strictly positive.
 *
 * It exists as a function because PostgreSQL forbids a subquery inside a CHECK constraint
 * (`cannot use subquery in check constraint`, SQLSTATE 0A000): the obvious spelling —
 * `not exists (select 1 from unnest(corpus_generations) g where g <= 0)` — is rejected at
 * `create table`, not at write time. It is `plpgsql` rather than `sql` for the same reason: a
 * `language sql` body is inlined into the constraint expression, so a `select` inside it would hit
 * the identical ban. `data_class_is_valid` (knowledge_core.sql:47) is the precedent for a function in
 * a column CHECK; the difference is only that this rule needs a loop over an array.
 *
 * Guard-supporting, so it is revoked from every request role below and stays off 001's allow-list: it
 * must never become a PostgREST endpoint (#60, FAQ-0010). It is also why `chat_%_v1` is the pattern
 * 035 tests 9-13 use — a helper that is not an RPC is not swept into those assertions.
 */
create or replace function public.chat_int_array_is_positive(p_values integer[])
returns boolean language plpgsql immutable strict set search_path = public, pg_temp as $$
declare
  v_value integer;
begin
  foreach v_value in array p_values loop
    if v_value is null or v_value <= 0 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
comment on function public.chat_int_array_is_positive(integer[]) is
  'Constraint helper: every element positive. Used by agent_runs.corpus_generations, where a non-positive generation id would be a generation that never existed (§9.4). Guard-only: not executable by any request role.';

-- ---------------------------------------------------------------- tables
create table public.conversations (
  id uuid primary key,
  organisation_id uuid not null,
  -- The employee the conversation belongs to. Server-assigned from auth.uid(), never an argument.
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Optional narrower information boundary (plan §1.1). Composite FK: it can never name another
  -- tenant's project. `on delete restrict` because a project that has conversations cannot be
  -- hard-deleted under them; deletion is a retention decision (plan §7.5).
  project_id uuid,
  expert_key text not null check (expert_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- What the history panel sorts by. Kept as its own column rather than re-derived from
  -- `max(messages.created_at)` on every list read.
  last_activity_at timestamptz not null default now(),
  constraint conversations_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint conversations_project_fk
    foreign key (project_id, organisation_id)
    references public.projects (id, organisation_id) on delete restrict,
  unique (id, organisation_id)
);
comment on table public.conversations is
  'One employee''s conversation with one expert, optionally bound to one project. Private to its creator by default (plan §9.1); written only by chat_ensure_conversation_v1 (FAQ-0004). expert_key records, never authorizes.';
comment on column public.conversations.project_id is
  'Information-scope filter recorded on the conversation, checked against project_memberships by the RPC — a project id from a request is never trusted (issue #16 N5).';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  conversation_id uuid not null,
  -- Append-only ordering within a conversation. Identity rather than created_at, because two rows
  -- can share a timestamp and the history has to render in one deterministic order.
  seq bigint generated always as identity,
  -- Only the two roles this server writes. A forged assistant/system/tool turn cannot be
  -- represented here even by a privileged writer (035 test 75, F17).
  role text not null check (role in ('user', 'assistant')),
  body_text text not null check (char_length(body_text) between 1 and 32000),
  -- A message carries the highest class among what it was built from: the question itself for a
  -- user row, the answer''s class for an assistant row (§6.2).
  data_class text not null check (public.data_class_is_valid(data_class)),
  -- The client''s own id for the send, so a retry or a reconnect reuses the row instead of adding
  -- one (plan §9.2). Not a secret and not a grant; opaque (contracts/keys.ts OpaqueId).
  client_message_id text check (client_message_id is null
                                 or (char_length(client_message_id) between 1 and 128
                                     and client_message_id ~ '^[A-Za-z0-9_-]{1,128}$')),
  -- An assistant row names the run that produced it; a user row names none.
  run_id uuid,
  created_at timestamptz not null default now(),
  constraint messages_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint messages_conversation_fk
    foreign key (conversation_id, organisation_id)
    references public.conversations (id, organisation_id) on delete cascade,
  unique (id, organisation_id),
  unique (conversation_id, seq)
);
create unique index messages_conversation_client_message_key
  on public.messages (conversation_id, client_message_id)
  where client_message_id is not null;
comment on table public.messages is
  'The visible chat history, ordered by seq. Roles are the two the server writes; the browser transcript is never history (F17). Written by chat_append_user_message_v1 and chat_complete_run_v1 only.';

create table public.agent_runs (
  -- The run id is the uuid the progress events and the Answer both carry (contracts/chat.ts
  -- ProgressBase.runId is z.uuid()), so one identity serves the stream, the audit row and resume.
  id uuid primary key,
  organisation_id uuid not null,
  conversation_id uuid not null,
  requested_by uuid not null references public.profiles (id) on delete restrict,
  -- The run a question belongs to, so the chain message → run → answer → evidence is queryable in
  -- both directions without re-deriving it from timestamps.
  user_message_id uuid,
  -- The client''s logical submit key (contracts/chat.ts idempotencyKey). Tenant-scoped uniqueness is
  -- what makes a duplicate submit return the same run instead of a second expensive one (§9.2, §14.1).
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128
                                       and idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  expert_key text not null check (expert_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status text not null default 'running'
    check (status in ('running', 'answered', 'partial', 'refused', 'unavailable')),
  -- Highest class among this run''s dependencies, computed at completion from the cited sources —
  -- never taken on trust from the caller (§6.2, 035 test 27).
  data_class text not null check (public.data_class_is_valid(data_class)),
  -- §9.4:263 — "the run record stores the policy_revision it was authorized under", so a later
  -- revocation can be re-checked against the state that admitted the run.
  policy_revision bigint not null check (policy_revision > 0),
  -- What the answer was produced under, so T-213''s staleness probe is one column read (§9.4).
  expert_versions text[] check (expert_versions is null or array_length(expert_versions, 1) between 1 and 32),
  -- A generation id is a real generation of the index, so it is positive; the loop lives in
  -- chat_int_array_is_positive because a CHECK may not contain a subquery (see the helper).
  corpus_generations integer[]
    constraint agent_runs_corpus_generations_positive
    check (corpus_generations is null
           or (array_length(corpus_generations, 1) between 1 and 32
               and public.chat_int_array_is_positive(corpus_generations))),
  as_of timestamptz,
  -- The delivered answer, in the shape src/contracts/answer.ts defines. Stored, not recomputed at
  -- read time (FAQ-0004): retention and export decisions read this column''s class, not a new call.
  answer_json jsonb check (answer_json is null or jsonb_typeof(answer_json) = 'object'),
  answer_status text check (answer_status is null
                            or answer_status in ('answered', 'partial', 'refused', 'unavailable')),
  -- Reserved for the F36 run-refusal codes (`no_evidence`, `permission_denied`,
  -- `budget_exhausted`, `gate_dropped`): a closed set, and no free-text reason column, because
  -- free text here is how an internal error reaches an employee-visible surface (§8.2, §9.3).
  -- Nothing writes it yet; the refusal an employee sees is the expert''s template inside the answer.
  refusal_reason text check (refusal_reason is null
                             or refusal_reason in ('no_evidence', 'permission_denied',
                                                   'budget_exhausted', 'gate_dropped',
                                                   'provider_unavailable')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_runs_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint agent_runs_conversation_fk
    foreign key (conversation_id, organisation_id)
    references public.conversations (id, organisation_id) on delete cascade,
  constraint agent_runs_user_message_fk
    foreign key (user_message_id, organisation_id)
    references public.messages (id, organisation_id) on delete set null,
  -- A run leaves `running` exactly once, and the completion marker arrives with that write: a row
  -- half-completed (status set, no marker, or the reverse) cannot exist.
  constraint agent_runs_completed_once_marker
    check ((status = 'running') = (completed_at is null)),
  unique (id, organisation_id),
  unique (organisation_id, idempotency_key)
);
create index agent_runs_conversation_started_idx
  on public.agent_runs (conversation_id, started_at);
comment on table public.agent_runs is
  'One row per agent run: created when the run starts, completed once with the persisted answer, its data class, its expert versions, corpus generations and the policy_revision it was authorized under (plan §9.4). The answer is persisted with audit BEFORE delivery (F22).';

-- Circular by design, in both directions: a run names the message that caused it and the answer
-- message names the run that produced it. The second edge is added here because `agent_runs` does not
-- exist until the statement above has run — the same order-of-creation move knowledge_core makes for
-- `knowledge_sources.current_version_id` (:229-233). Composite key, so neither edge can cross tenants.
alter table public.messages
  add constraint messages_run_fk
  foreign key (run_id, organisation_id)
  references public.agent_runs (id, organisation_id) on delete cascade;

create table public.agent_run_evidence (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  run_id uuid not null,
  -- Which claim of the answer this dependency belongs to (contracts/answer.ts Claim.id, an opaque id).
  claim_id text not null check (char_length(claim_id) between 1 and 128
                                and claim_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  evidence_kind text not null check (evidence_kind in ('chunk', 'record', 'form_field')),
  -- The anchor T-214 needs: the source version the answer was built from. Composite FK with
  -- organisation_id, so it can never name another tenant''s version (035 tests 42, 48, 76).
  source_version_id uuid,
  -- Opaque as the contract spells it (ChunkEvidence.chunkId is an OpaqueId, not a brand), so it is
  -- stored as text. The FK that matters for withdrawal is the source version above (ADR-0008).
  chunk_id text check (chunk_id is null or (char_length(chunk_id) between 1 and 128
                                            and chunk_id ~ '^[A-Za-z0-9_-]{1,128}$')),
  -- Verbatim quote and its platform-derived span (ADR-0008: UTF-16 code units from the start of that
  -- chunk version''s body_text; SQL never computes one, so this stores what the Worker derived).
  quoted_text text check (quoted_text is null or char_length(quoted_text) between 1 and 4000),
  span_start_char integer check (span_start_char is null or span_start_char >= 0),
  span_end_char integer check (span_end_char is null or span_end_char >= 0),
  -- Record and form-field evidence, typed as the contract does. Neither source table exists yet
  -- (T-215 writes records, T-111c owns submissions), so these are carried without a FK; no signed
  -- grant is representable here either (#10, 035 test 69).
  tool_call_id text check (tool_call_id is null or (char_length(tool_call_id) between 1 and 128
                                                    and tool_call_id ~ '^[A-Za-z0-9_-]{1,128}$')),
  record_type text check (record_type is null or record_type ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  record_id text check (record_id is null or (char_length(record_id) between 1 and 128
                                              and record_id ~ '^[A-Za-z0-9_-]{1,128}$')),
  record_version bigint check (record_version is null or record_version > 0),
  observed_at timestamptz,
  submission_id uuid,
  field_path text check (field_path is null or char_length(field_path) between 1 and 256),
  template_version text check (template_version is null or template_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- The class of **this** dependency, taken from the source row it cites rather than from the caller.
  data_class text not null check (public.data_class_is_valid(data_class)),
  created_at timestamptz not null default now(),
  constraint agent_run_evidence_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint agent_run_evidence_run_fk
    foreign key (run_id, organisation_id)
    references public.agent_runs (id, organisation_id) on delete cascade,
  constraint agent_run_evidence_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete restrict,
  -- A chunk citation is a real citation: version and chunk both, and the span is ordered.
  constraint agent_run_evidence_chunk_shape
    check (evidence_kind <> 'chunk'
           or (source_version_id is not null and chunk_id is not null
               and quoted_text is not null
               and (span_start_char is null or span_end_char is null
                    or span_end_char >= span_start_char))),
  constraint agent_run_evidence_record_shape
    check (evidence_kind <> 'record'
           or (tool_call_id is not null and record_type is not null
               and record_id is not null and record_version is not null
               and observed_at is not null)),
  constraint agent_run_evidence_form_field_shape
    check (evidence_kind <> 'form_field'
           or (submission_id is not null and field_path is not null
               and template_version is not null)),
  unique (id, organisation_id)
);
create index agent_run_evidence_run_idx on public.agent_run_evidence (run_id);
create index agent_run_evidence_source_version_idx on public.agent_run_evidence (source_version_id);
comment on table public.agent_run_evidence is
  'Answer↔evidence dependency rows: which claim cited which source version and chunk, with the class of the cited source. T-213 invalidates and T-214 withholds through these rows (§6.2, §9.4). Append-only — a new outcome is a new row elsewhere, not an edit here.';

create trigger conversations_touch_updated before update on public.conversations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- guard triggers
/**
 * Is any key of this JSON value shaped like a grant, a storage reference or a provider/model detail?
 * Keys only — the text of a claim may of course mention a model in prose. Recursion is depth-bounded
 * because `answer_json` is caller-shaped input, and the bound fails closed: an answer deeper than
 * this is refused rather than walked indefinitely.
 */
create or replace function public.chat_json_has_forbidden_key(p_value jsonb, p_depth integer default 0)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_key text;
  v_child jsonb;
begin
  if p_value is null then
    return false;
  end if;
  if p_depth > 12 then
    raise exception 'answer json is nested too deeply to inspect' using errcode = '22023';
  end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select entry.key, entry.value from jsonb_each(p_value) as entry(key, value) loop
      -- The pattern is parenthesized because `~*` and `||` sit at the same precedence level and
      -- associate left-to-right: unwrapped, `v_key ~* 'frag1' || 'frag2'` evaluates the regex on
      -- **frag1 alone**, which here is an unterminated group - `ERROR: invalid regular expression`
      -- (SQLSTATE 2201B), raised the first time the trigger saw a non-null answer. CI found it as
      -- `complete_run` refusing a valid answer with error:2201B.
      if v_key ~* ('^(url|uri|href|object_ref|object_key|storage_key|storage_bucket|download_token|'
                   || 'signed_url|signature|signed|token|secret|credential|api_key|apikey|provider|'
                   || 'provider_key|model|model_id)$') then
        return true;
      end if;
      if public.chat_json_has_forbidden_key(v_child, p_depth + 1) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select entry.value from jsonb_array_elements(p_value) as entry(value) loop
      if public.chat_json_has_forbidden_key(v_child, p_depth + 1) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

comment on function public.chat_json_has_forbidden_key(jsonb, integer) is
  'Guard used by chat_answer_json_guard: no key of a persisted answer may be a storage reference, a signed grant or a provider/model name, at any depth (plan §4.4, §8.2, §9.3, #10). Keys only, never prose. Trigger-supporting, so it is revoked from every request role (#60).';

create or replace function public.chat_answer_json_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.answer_json is not null and public.chat_json_has_forbidden_key(new.answer_json, 0) then
    raise exception 'a persisted answer may not carry a grant or provider-detail key'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.chat_answer_json_guard() is
  'Before insert/update on agent_runs: refuses an answer_json holding a url/token/storage/model key even when the writer is privileged (plan §4.4, #10; contracts/answer.ts makes one unrepresentable, this keeps a hand-built row honest). 035 test 72.';

create trigger agent_runs_answer_json_guard before insert or update on public.agent_runs
  for each row execute function public.chat_answer_json_guard();

/**
 * A run row is written at start and completed once. Identity columns never move, and a completed run
 * stops being writable — the answer, its class and its audit stop agreeing by accident. The RPC
 * checks the same thing and answers 42501 (035 test 31); this is the backstop behind it, and it is
 * why a hand-written UPDATE cannot re-deliver a different answer under the same run id (§9.4).
 */
create or replace function public.chat_run_immutable()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.organisation_id is distinct from old.organisation_id
     or new.conversation_id is distinct from old.conversation_id
     or new.requested_by is distinct from old.requested_by
     or new.idempotency_key is distinct from old.idempotency_key
     or new.expert_key is distinct from old.expert_key
     or new.started_at is distinct from old.started_at
  then
    raise exception 'run % identity is fixed once the run has started (§9.4)', old.id
      using errcode = '23514';
  end if;
  if old.completed_at is not null then
    raise exception 'run % is already completed: its answer is history (§9.4)', old.id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.chat_run_immutable() is
  'Before update on agent_runs: identity is fixed and a completed run is never rewritten (plan §9.4). The delivery gate lives in chat_complete_run_v1; this is the backstop.';

create trigger agent_runs_immutable before update on public.agent_runs
  for each row execute function public.chat_run_immutable();

/**
 * The audit trail behind a delivered answer is append-only. Removing chat audit rows is a retention
 * job with its own documented privileged path (plan §7.5), not something an RPC or an accident does.
 * Same shape as `source_versions_immutable` / `source_versions_no_resurrection` in knowledge_core.
 */
create or replace function public.chat_run_evidence_immutable()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'answer evidence rows are append-only: a new outcome is a new row (§9.4, T-214)'
    using errcode = '23514';
end;
$$;

create trigger agent_run_evidence_immutable before update or delete on public.agent_run_evidence
  for each row execute function public.chat_run_evidence_immutable();

-- ---------------------------------------------------------------- shared internals
/**
 * The chat permission gate: an **area at a level**, never a role key (#32, FAQ-0006, plan §5.2).
 * seed.sql grants `chat.ask` at `read` to a company1 and a company2 member and grants nothing to the
 * seeded tenant admin role, so 035 tests 17 and 68 prove which of the two this function reads.
 */
create or replace function public.chat_actor_may_ask(p_organisation_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.organisation_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'chat.ask'
       and rp.level in ('read', 'write', 'admin')
     where m.organisation_id = p_organisation_id
       and m.user_id = auth.uid()
       and m.status = 'active'
  );
$$;

comment on function public.chat_actor_may_ask(uuid) is
  'chat.ask at read or above for the calling user in the scoped tenant. An area, not a role key (#32, FAQ-0006); revoked from request roles because it is RPC-internal, not an endpoint (#60).';

/** The conversation must exist in this tenant and belong to this caller. 42501 either way (#13(2)). */
create or replace function public.chat_conversation_owned(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.conversations c
     where c.id = p_conversation_id
       and c.organisation_id = public.current_organisation_id()
       and c.user_id = auth.uid()
  );
$$;

comment on function public.chat_conversation_owned(uuid) is
  'Scoped, owner-scoped existence test shared by the four conversation-addressing RPCs: one definition of "yours", and the same answer for another tenant''s row and for a row that does not exist (plan §8.2, #13(2)).';

-- ---------------------------------------------------------------- the seven scoped RPCs
create or replace function public.chat_ensure_conversation_v1(
  p_organisation_id uuid,
  p_conversation_id uuid,
  p_expert_key text,
  p_project_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to open a conversation' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.chat_actor_may_ask(v_organisation) then
    raise exception 'not permitted to start a conversation in this organization' using errcode = '42501';
  end if;
  if p_expert_key is null or p_expert_key !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    raise exception 'expert key must be a lowercase key' using errcode = '22023';
  end if;

  -- The project is checked, never trusted: it has to be in this tenant, and the caller has to see it
  -- — either a tenant-wide project or one they hold a project_membership for. The answer for a
  -- project they cannot see is 42501 like every other refusal, so the attempt learns nothing about
  -- whether such a project exists (issue #16 N5, plan §1.1, §8.2).
  if p_project_id is not null then
    if not exists (
      select 1 from public.projects pr
       where pr.id = p_project_id
         and pr.organisation_id = v_organisation
         and (pr.visibility = 'organisation' or public.is_project_member(p_project_id))
    ) then
      raise exception 'no such project for this caller' using errcode = '42501';
    end if;
  end if;

  insert into public.conversations (id, organisation_id, user_id, expert_key, project_id)
  values (coalesce(p_conversation_id, gen_random_uuid()), v_organisation, v_user,
          p_expert_key, p_project_id)
  on conflict (id) do nothing
  returning id into v_id;

  if v_id is null then
    -- Same id, same caller: a reload or a retry, not a second conversation. Anything else — a id
    -- another user or tenant already holds — answers exactly as "not permitted" would.
    select id into v_id
      from public.conversations
     where id = p_conversation_id
       and organisation_id = v_organisation
       and user_id = v_user;
    if not found then
      raise exception 'conversation does not belong to this caller' using errcode = '42501';
    end if;
  end if;

  return v_id;
end;
$$;

comment on function public.chat_ensure_conversation_v1(uuid, uuid, text, uuid) is
  'Open (or re-open) a conversation for the calling employee in the scoped tenant. p_organisation_id first, scope established as the first statement (#163, FAQ-0011); owner from auth.uid(); a project filter is checked against project_memberships and answered 42501 when it is not visible; chat.ask at read or above required. Returns the id and nothing else.';

create or replace function public.chat_append_user_message_v1(
  p_organisation_id uuid,
  p_conversation_id uuid,
  p_client_message_id text,
  p_body_text text,
  p_data_class text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.chat_actor_may_ask(v_organisation) then
    raise exception 'not permitted to post in this organization' using errcode = '42501';
  end if;

  -- Shape checks before the owner check and before anything is written, so a malformed send never
  -- reaches the table and never leaks a constraint name; the same ids are validated at the edge by the
  -- OpaqueId schema in envelope.ts (src/platform/chat/envelope.test.ts), and this is the second gate because
  -- the RPC is reachable on its own. There is no role parameter here at all, so a forged assistant
  -- turn is unrepresentable from the request path (035 test 20, and the column CHECK in 75).
  if p_client_message_id is null
     or p_client_message_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'clientMessageId must be 1-128 opaque characters' using errcode = '22023';
  end if;
  if p_body_text is null or char_length(btrim(p_body_text)) < 1 or char_length(p_body_text) > 32000 then
    raise exception 'message text must be 1-32000 characters' using errcode = '22023';
  end if;
  if not public.data_class_is_valid(p_data_class) then
    raise exception 'message data class is not one of the four' using errcode = '22023';
  end if;
  if not public.chat_conversation_owned(p_conversation_id) then
    raise exception 'no such conversation for this caller' using errcode = '42501';
  end if;

  insert into public.messages (organisation_id, conversation_id, role, body_text,
                               data_class, client_message_id)
  values (v_organisation, p_conversation_id, 'user', btrim(p_body_text), p_data_class,
          p_client_message_id)
  on conflict (conversation_id, client_message_id)
    where client_message_id is not null
    do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id
      from public.messages
     where conversation_id = p_conversation_id
       and organisation_id = v_organisation
       and client_message_id = p_client_message_id;
    if not found then
      raise exception 'message could not be recorded' using errcode = '42501';
    end if;
    return v_id;
  end if;

  update public.conversations
     set last_activity_at = now()
   where id = p_conversation_id
     and organisation_id = v_organisation;

  return v_id;
end;
$$;

comment on function public.chat_append_user_message_v1(uuid, uuid, text, text, text) is
  'Append the employee''s message to their own conversation. Role is fixed to ''user'' by the body and the CHECK, so a forged assistant/system/tool turn cannot enter the history (F17); (conversation_id, client_message_id) is unique, so a retry reuses the row instead of doubling the history (plan §9.2).';

create or replace function public.chat_start_run_v1(
  p_organisation_id uuid,
  p_run_id uuid,
  p_conversation_id uuid,
  p_idempotency_key text,
  p_expert_key text,
  p_user_message_id uuid,
  p_data_class text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_revision bigint;
  v_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.chat_actor_may_ask(v_organisation) then
    raise exception 'not permitted to run an expert in this organization' using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'run id is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'idempotencyKey must be 1-128 opaque characters' using errcode = '22023';
  end if;
  if p_expert_key is null or p_expert_key !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    raise exception 'expert key must be a lowercase key' using errcode = '22023';
  end if;
  if not public.data_class_is_valid(p_data_class) then
    raise exception 'run data class is not one of the four' using errcode = '22023';
  end if;
  if not public.chat_conversation_owned(p_conversation_id) then
    raise exception 'no such conversation for this caller' using errcode = '42501';
  end if;
  if p_user_message_id is null or not exists (
    select 1 from public.messages msg
     where msg.id = p_user_message_id
       and msg.organisation_id = v_organisation
       and msg.conversation_id = p_conversation_id
  ) then
    raise exception 'run must name a message of this conversation' using errcode = '42501';
  end if;

  -- The revision is read here, at authorization time, not at completion: §9.4 asks the run record to
  -- name the policy state that admitted the run, and a tenancy change mid-run must not rewrite it.
  select o.policy_revision into v_revision
    from public.organisations o
   where o.id = v_organisation;
  if v_revision is null or v_revision <= 0 then
    raise exception 'tenant policy revision unavailable' using errcode = '28000';
  end if;

  if exists (select 1 from public.agent_runs where id = p_run_id) then
    if not exists (
      select 1 from public.agent_runs r
       where r.id = p_run_id
         and r.organisation_id = v_organisation
         and r.conversation_id = p_conversation_id
         and r.requested_by = v_user
    ) then
      raise exception 'run does not belong to this caller' using errcode = '42501';
    end if;
    return p_run_id;
  end if;

  insert into public.agent_runs (id, organisation_id, conversation_id, requested_by,
                                 user_message_id, idempotency_key, expert_key, status,
                                 data_class, policy_revision)
  values (p_run_id, v_organisation, p_conversation_id, v_user, p_user_message_id,
          p_idempotency_key, p_expert_key, 'running', p_data_class, v_revision)
  on conflict (organisation_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- The key already names a run for this caller: hand back that run rather than starting a second
    -- expensive one. This is what makes a duplicate submit, a retry and a reload resume instead of
    -- re-run (plan §9.2, §14.1; 035 tests 22-23).
    select id into v_id
      from public.agent_runs
     where organisation_id = v_organisation
       and idempotency_key = p_idempotency_key
       and conversation_id = p_conversation_id
       and requested_by = v_user;
    if not found then
      raise exception 'idempotency key belongs to another run' using errcode = '42501';
    end if;
  end if;

  return v_id;
end;
$$;

comment on function public.chat_start_run_v1(uuid, uuid, uuid, text, text, uuid, text) is
  'Record the start of a run under the caller''s own conversation. Tenant-scoped unique idempotency_key: a repeat submit answers with the run that exists instead of paying twice. Stores the policy_revision read at authorization time (§9.4) and links the message that caused the run.';

/**
 * The delivery gate: one call writes the answer row, its dependency rows and the assistant history
 * row, in one transaction, or writes nothing at all (F22: the answer is persisted with audit before
 * it is delivered; §4.3: no half-written authorization).
 *
 * The two properties the rest of the repository depends on are computed here rather than accepted:
 *   * every cited source version must belong to this tenant **and** be readable by this caller
 *     right now (`source_version_is_readable`, the merged predicate) — that is F24's "an answer is
 *     withheld if an evidence source is no longer readable" and §9.4's final authorization check,
 *     enforced where the row is written;
 *   * `data_class` is the highest rank among the run's dependencies: the cited sources' own classes,
 *     read from `source_versions`, the class the answer declared, and the class the run started with
 *     (the question). A caller cannot under-declare its way out of retention or clearance (§6.2).
 */
create or replace function public.chat_complete_run_v1(
  p_organisation_id uuid,
  p_run_id uuid,
  p_answer jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_status text;
  v_declared text;
  v_class text;
  v_rank integer;
  v_cited uuid[];
  v_expert_versions text[];
  v_corpus_generations integer[];
  v_run record;
  v_message_id uuid;
  v_as_of timestamptz;
  v_completed timestamptz := now();
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.chat_actor_may_ask(v_organisation) then
    raise exception 'not permitted to complete a run in this organization' using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'run id is required' using errcode = '22023';
  end if;

  -- Shape first: nothing is written until the answer is at least structurally the contract, so a
  -- malformed payload cannot leave a run half-completed (AGENTS.md §2: Zod at the boundary, and the
  -- same rule applied once more where the row is written).
  if p_answer is null or jsonb_typeof(p_answer) <> 'object' then
    raise exception 'answer must be a json object' using errcode = '22023';
  end if;
  v_status := p_answer->>'status';
  if v_status is null or v_status not in ('answered', 'partial', 'refused', 'unavailable') then
    raise exception 'answer status must be answered, partial, refused or unavailable'
      using errcode = '22023';
  end if;
  v_declared := p_answer->>'dataClass';
  if not public.data_class_is_valid(v_declared) then
    raise exception 'answer dataClass is not one of the four' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_answer->'claims', 'null'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_answer->'unknowns', 'null'::jsonb)) <> 'array' then
    raise exception 'answer claims and unknowns must both be arrays' using errcode = '22023';
  end if;
  -- `answered` has to be grounded in something the platform can prove, which is the same rule
  -- contracts/answer.ts enforces in TypeScript; stating it here too is deliberate, because this is
  -- the write that makes an answer durable (§12.1, issue #16 N2).
  if v_status = 'answered' and not exists (
    select 1
      from jsonb_array_elements(p_answer->'claims') as cl(value)
     where coalesce(cl.value->>'type', '') <> 'inference'
       and jsonb_typeof(coalesce(cl.value->'evidence', '[]'::jsonb)) = 'array'
       and jsonb_array_length(cl.value->'evidence') > 0
  ) then
    raise exception 'an answered status needs a non-inference claim with evidence'
      using errcode = '22023';
  end if;
  -- Evidence entries are checked before any of them is read as a uuid, so a malformed citation
  -- answers 22023 rather than 22P02 with a cast in the message.
  if exists (
    select 1
      from jsonb_array_elements(p_answer->'claims') as cl(value)
      cross join lateral jsonb_array_elements(coalesce(cl.value->'evidence', '[]'::jsonb)) as ev(value)
     where coalesce(cl.value->>'id', '') !~ '^[A-Za-z0-9_-]{1,128}$'
        or coalesce(ev.value->>'kind', '') not in ('chunk', 'record', 'form_field')
        or (ev.value->>'kind') = 'chunk'
           and (coalesce(ev.value->>'sourceVersionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or coalesce(ev.value->>'chunkId', '') !~ '^[A-Za-z0-9_-]{1,128}$'
                or coalesce(ev.value->>'quotedText', '') = '')
  ) then
    raise exception 'an evidence reference is malformed' using errcode = '22023';
  end if;

  select r.id, r.conversation_id, r.status, r.data_class
    into v_run
    from public.agent_runs r
   where r.id = p_run_id
     and r.organisation_id = v_organisation
     and r.requested_by = v_user;
  if not found then
    raise exception 'no such run for this caller' using errcode = '42501';
  end if;
  if v_run.status <> 'running' then
    raise exception 'run is already completed' using errcode = '42501';
  end if;
  if not public.chat_conversation_owned(v_run.conversation_id) then
    raise exception 'no such conversation for this caller' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct (ev.value->>'sourceVersionId')::uuid), '{}'::uuid[])
    into v_cited
    from jsonb_array_elements(p_answer->'claims') as cl(value)
    cross join lateral jsonb_array_elements(coalesce(cl.value->'evidence', '[]'::jsonb)) as ev(value)
   where ev.value->>'kind' = 'chunk';

  -- Every cited version has to be a version of this tenant **and** readable by this caller right
  -- now. `source_version_is_readable` is the merged predicate (knowledge_core.sql:464-474): it walks
  -- the collection''s audience and project membership, so a co-worker cannot complete an answer
  -- built from a project corpus they are not in, and the composite FK below is the backstop that
  -- stops a citation naming a version that does not exist (F24, §9.4, §12.4).
  if exists (
    select 1
      from unnest(v_cited) as cited(id)
     where not exists (
       select 1 from public.source_versions sv
        where sv.id = cited.id
          and sv.organisation_id = v_organisation
          and public.source_version_is_readable(cited.id)
     )
  ) then
    raise exception 'answer withheld: a cited source version is not readable by this caller'
      using errcode = '42501';
  end if;

  -- The class of the run, from the dependencies rather than from the caller: greatest of the cited
  -- sources'' classes, what the answer declared, and what the run started with.
  select greatest(
    coalesce((select max(public.data_class_rank(sv.data_class))
                from public.source_versions sv
               where sv.id = any (v_cited)
                 and sv.organisation_id = v_organisation), -1),
    coalesce(public.data_class_rank(v_declared), -1),
    coalesce(public.data_class_rank(v_run.data_class), -1)
  ) into v_rank;
  v_class := case v_rank
    when 0 then 'public'
    when 1 then 'internal'
    when 2 then 'client_confidential'
    when 3 then 'restricted'
    else null
  end;
  if v_class is null then
    raise exception 'could not compute the answer data class' using errcode = '22023';
  end if;

  -- The staleness inputs T-213 reads are validated before they are cast, so a bad array answers
  -- 22023 like every other malformed argument rather than 22P02 with a cast in the message.
  if jsonb_typeof(coalesce(p_answer->'expertVersions', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_answer->'corpusGenerations', '[]'::jsonb)) <> 'array' then
    raise exception 'expertVersions and corpusGenerations must both be arrays' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_answer->'expertVersions', '[]'::jsonb)) as g(element)
     where char_length(g.element) < 1 or char_length(g.element) > 160
  ) or exists (
    select 1 from jsonb_array_elements_text(coalesce(p_answer->'corpusGenerations', '[]'::jsonb)) as g(element)
     where g.element !~ '^[1-9][0-9]*$'
  ) then
    raise exception 'expert versions must be 1-160 characters and corpus generations positive integers'
      using errcode = '22023';
  end if;
  select array_agg(distinct g.element) into v_expert_versions
    from jsonb_array_elements_text(coalesce(p_answer->'expertVersions', '[]'::jsonb)) as g(element);
  select array_agg(distinct g.element::integer) into v_corpus_generations
    from jsonb_array_elements_text(coalesce(p_answer->'corpusGenerations', '[]'::jsonb)) as g(element);

  -- `asOf` is an ISO timestamp in the contract; an unreadable one falls back to now() rather than
  -- aborting a run whose answer is otherwise deliverable, and the guard below never trusts it.
  begin
    v_as_of := (p_answer->>'asOf')::timestamptz;
  exception when others then
    v_as_of := null;
  end;

  update public.agent_runs
     set status = v_status,
         answer_status = v_status,
         answer_json = p_answer,
         data_class = v_class,
         expert_versions = v_expert_versions,
         corpus_generations = v_corpus_generations,
         as_of = coalesce(v_as_of, now()),
         completed_at = v_completed
   where id = p_run_id
     and organisation_id = v_organisation
     and requested_by = v_user
     and status = 'running';
  if not found then
    raise exception 'run could not be completed' using errcode = '42501';
  end if;

  -- The dependency rows, with each class read from the source it cites. The run row already carries
  -- the computed maximum, so a later edit of a source class cannot make this table''s rows agree by
  -- accident with an answer that was delivered under a different class (§6.2).
  insert into public.agent_run_evidence (
    organisation_id, run_id, claim_id, evidence_kind, source_version_id, chunk_id,
    quoted_text, span_start_char, span_end_char, tool_call_id, record_type, record_id,
    record_version, observed_at, submission_id, field_path, template_version, data_class
  )
  select v_organisation, p_run_id, cl.value->>'id', ev.value->>'kind',
         nullif(coalesce(ev.value->>'sourceVersionId', ''), '')::uuid,
         ev.value->>'chunkId',
         ev.value->>'quotedText',
         nullif(coalesce(ev.value->'span'->>'startChar', ''), '')::integer,
         nullif(coalesce(ev.value->'span'->>'endChar', ''), '')::integer,
         ev.value->>'toolCallId', ev.value->>'recordType', ev.value->>'recordId',
         nullif(coalesce(ev.value->>'recordVersion', ''), '')::bigint,
         nullif(coalesce(ev.value->>'observedAt', ''), '')::timestamptz,
         nullif(coalesce(ev.value->>'submissionId', ''), '')::uuid,
         ev.value->>'fieldPath', ev.value->>'templateVersion',
         coalesce(
           (select sv.data_class from public.source_versions sv
             where sv.id = nullif(coalesce(ev.value->>'sourceVersionId', ''), '')::uuid
               and sv.organisation_id = v_organisation),
           v_class
         )
    from jsonb_array_elements(p_answer->'claims') as cl(value)
    cross join lateral jsonb_array_elements(coalesce(cl.value->'evidence', '[]'::jsonb)) as ev(value);

  -- The assistant half of the history, written by the same call as the answer row: reload needs the
  -- server''s own copy, never the browser''s transcript (F17, F22). The claims and citations of the
  -- answer are read from `answer_json` on the run row by whoever renders the history.
  insert into public.messages (organisation_id, conversation_id, role, body_text, data_class, run_id)
  values (v_organisation, v_run.conversation_id, 'assistant',
          coalesce(nullif(btrim(p_answer->>'summary'), ''), 'No answer.'), v_class, p_run_id)
  returning id into v_message_id;

  update public.conversations
     set last_activity_at = v_completed
   where id = v_run.conversation_id
     and organisation_id = v_organisation;

  return jsonb_build_object(
    'runId', p_run_id,
    'conversationId', v_run.conversation_id,
    'messageId', v_message_id,
    'status', v_status,
    'dataClass', v_class,
    'completedAt', v_completed
  );
end;
$$;

comment on function public.chat_complete_run_v1(uuid, uuid, jsonb) is
  'The delivery gate, in one transaction: re-authorizes every cited source version against the caller''s current rights (42501 and nothing written when one is not readable — F24, §9.4), computes data_class as the highest rank among the cited sources, the declared class and the question (§6.2), then writes the run row, the dependency rows and the assistant history row. A run completes once.';

create or replace function public.chat_load_conversation_v1(
  p_organisation_id uuid,
  p_conversation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_conversation jsonb;
  v_history jsonb;
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  if v_organisation is null then
    raise exception 'tenant scope is required' using errcode = '28000';
  end if;
  -- Owner check first, and one answer for "not yours" and "does not exist" (#13(2)).
  if not public.chat_conversation_owned(p_conversation_id) then
    raise exception 'no such conversation for this caller' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'id', c.id,
           'expertKey', c.expert_key,
           'projectId', c.project_id,
           'status', c.status,
           'createdAt', c.created_at,
           'lastActivityAt', c.last_activity_at
         )
    into v_conversation
    from public.conversations c
   where c.id = p_conversation_id
     and c.organisation_id = v_organisation;

  -- The run is attached to the assistant message that came from it, so one call gives the history
  -- panel everything it renders: the text, the answer, the citations inside it and the class of each.
  -- `bodyText` is the answer summary for an assistant row; the claims live on the run.
  select jsonb_agg(jsonb_build_object(
           'id', m.id,
           'seq', m.seq,
           'role', m.role,
           'bodyText', m.body_text,
           'dataClass', m.data_class,
           'createdAt', m.created_at,
           'runId', m.run_id,
           'run', case
                    when m.run_id is null then null
                    else (
                      select jsonb_build_object(
                               'id', r.id,
                               'status', r.status,
                               'answerStatus', r.answer_status,
                               'dataClass', r.data_class,
                               'policyRevision', r.policy_revision,
                               'expertVersions', r.expert_versions,
                               'corpusGenerations', r.corpus_generations,
                               'asOf', r.as_of,
                               'answer', r.answer_json
                             )
                        from public.agent_runs r
                       where r.id = m.run_id
                         and r.organisation_id = m.organisation_id
                    )
                  end
         ) order by m.seq)
    into v_history
    from public.messages m
   where m.conversation_id = p_conversation_id
     and m.organisation_id = v_organisation;

  return jsonb_build_object(
    'conversation', v_conversation,
    'messages', coalesce(v_history, '[]'::jsonb)
  );
end;
$$;

comment on function public.chat_load_conversation_v1(uuid, uuid) is
  'The conversation and its full history for its owner, in the camelCase shape contracts/chat.ts and contracts/answer.ts describe. This is what the route rebuilds context from, so the browser transcript never decides what was said (F17, plan §9.1).';

create or replace function public.chat_list_conversations_v1(
  p_organisation_id uuid,
  p_limit integer
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_rows jsonb;
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  if v_organisation is null then
    raise exception 'tenant scope is required' using errcode = '28000';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100' using errcode = '22023';
  end if;

  -- No `chat.ask` gate here: reading one''s own history is not asking a new question, and the plan
  -- §9.1 history surface has to stay readable to someone whose ask permission was withdrawn.
  select jsonb_agg(row_object) into v_rows
    from (
      select jsonb_build_object(
               'id', c.id,
               'expertKey', c.expert_key,
               'projectId', c.project_id,
               'status', c.status,
               'createdAt', c.created_at,
               'lastActivityAt', c.last_activity_at
             ) as row_object
        from public.conversations c
       where c.organisation_id = v_organisation
         and c.user_id = auth.uid()
       order by c.last_activity_at desc
       limit p_limit
    ) s;

  return jsonb_build_object('conversations', coalesce(v_rows, '[]'::jsonb));
end;
$$;

comment on function public.chat_list_conversations_v1(uuid, integer) is
  'This caller''s own conversations, newest first, capped at 100. Plan §9.1: the tenant origin shows the employee their own history; other employees'' conversations are not in this answer and no admin view of them exists yet (§13.1 is its own packet).';

create or replace function public.chat_get_run_v1(
  p_organisation_id uuid,
  p_run_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_run jsonb;
begin
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  if v_organisation is null then
    raise exception 'tenant scope is required' using errcode = '28000';
  end if;
  if p_run_id is null then
    raise exception 'run id is required' using errcode = '22023';
  end if;

  -- The resume read: a client that disconnected reloads, asks for the run id it already has, and
  -- either gets the persisted answer or learns the run is still in flight. It is owner-scoped, so a
  -- run id belonging to another employee or tenant answers as "no such run" (035 tests 36, 58, 62).
  select jsonb_build_object(
           'id', r.id,
           'conversationId', r.conversation_id,
           'status', r.status,
           'answerStatus', r.answer_status,
           'dataClass', r.data_class,
           'policyRevision', r.policy_revision,
           'expertKey', r.expert_key,
           'expertVersions', r.expert_versions,
           'corpusGenerations', r.corpus_generations,
           'asOf', r.as_of,
           'answer', r.answer_json,
           'startedAt', r.started_at,
           'completedAt', r.completed_at
         )
    into v_run
    from public.agent_runs r
   where r.id = p_run_id
     and r.organisation_id = v_organisation
     and r.requested_by = auth.uid();
  if v_run is null then
    raise exception 'no such run for this caller' using errcode = '42501';
  end if;

  return v_run;
end;
$$;

comment on function public.chat_get_run_v1(uuid, uuid) is
  'Read one run back to the employee who requested it, including the persisted answer: "disconnect, then reload" resumes from stored state instead of re-running the question (plan §9.2, §9.3).';

-- ---------------------------------------------------------------- RLS
-- Enabled, not FORCEd (tenancy_core.sql:251-256): the definer RPCs and guard triggers above are
-- owned by the migration role and must reach these tables, while every request role is filtered by
-- the policies below.
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_run_evidence enable row level security;

-- Owner-scoped, not tenant-scoped: plan §9.1 says the employee sees their **own** chat history, so a
-- co-worker in the same tenant is refused (035 tests 61-63). `is_active_member` is SECURITY DEFINER
-- so a policy here never recurses through the policy on another table, and the scope predicate is
-- what makes a company2 session see no company1 row whatever the id it asks for (035 tests 59-60).
create policy conversations_owner_scoped_read on public.conversations
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and user_id = auth.uid()
  );

-- A message is readable through the conversation it belongs to, which is what makes the conversation
-- the unit of privacy for the whole history.
create policy messages_owner_scoped_read on public.messages
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and c.organisation_id = messages.organisation_id
         and c.user_id = auth.uid()
    )
  );

create policy agent_runs_requester_scoped_read on public.agent_runs
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and requested_by = auth.uid()
  );

-- The evidence rows inherit the run''s owner. Reading them is what an evidence panel does, and the
-- re-authorized citation preview (T-203, F24) is a separate call: what is readable here is the
-- dependency record of an answer that was already delivered to this person.
create policy agent_run_evidence_owner_scoped_read on public.agent_run_evidence
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and exists (
      select 1 from public.agent_runs r
       where r.id = agent_run_evidence.run_id
         and r.organisation_id = agent_run_evidence.organisation_id
         and r.requested_by = auth.uid()
    )
  );

-- ---------------------------------------------------------------- grants
-- Supabase hands anon/authenticated privileges on new public tables (auto_expose_new_tables), so the
-- revoke comes first and the grant back is SELECT only. No request role writes these tables: the
-- seven RPCs below are the only write path (FAQ-0004, plan §4.3), and 035 test 7 pins it.
revoke all on
  public.conversations, public.messages, public.agent_runs, public.agent_run_evidence
  from anon, authenticated;

grant select on
  public.conversations, public.messages, public.agent_runs, public.agent_run_evidence
  to authenticated;

-- #60 / FAQ-0010: PostgreSQL hands EXECUTE on a new function to PUBLIC and a migration cannot close
-- that default, so every function created here is revoked **by full signature** in this file and
-- only the seven RPCs are granted back — to `authenticated`, never to `anon`, because chat is behind
-- sign-in (plan §4.1). 001_function_privileges.test.sql's rule-32 allow-list carries the same seven,
-- and 035 test 13 pins the set from the catalog.
revoke execute on function
  public.chat_int_array_is_positive(integer[]),
  public.chat_json_has_forbidden_key(jsonb, integer),
  public.chat_answer_json_guard(),
  public.chat_run_immutable(),
  public.chat_run_evidence_immutable(),
  public.chat_actor_may_ask(uuid),
  public.chat_conversation_owned(uuid),
  public.chat_ensure_conversation_v1(uuid, uuid, text, uuid),
  public.chat_append_user_message_v1(uuid, uuid, text, text, text),
  public.chat_start_run_v1(uuid, uuid, uuid, text, text, uuid, text),
  public.chat_complete_run_v1(uuid, uuid, jsonb),
  public.chat_load_conversation_v1(uuid, uuid),
  public.chat_list_conversations_v1(uuid, integer),
  public.chat_get_run_v1(uuid, uuid)
  from public, anon, authenticated;

grant execute on function
  public.chat_ensure_conversation_v1(uuid, uuid, text, uuid),
  public.chat_append_user_message_v1(uuid, uuid, text, text, text),
  public.chat_start_run_v1(uuid, uuid, uuid, text, text, uuid, text),
  public.chat_complete_run_v1(uuid, uuid, jsonb),
  public.chat_load_conversation_v1(uuid, uuid),
  public.chat_list_conversations_v1(uuid, integer),
  public.chat_get_run_v1(uuid, uuid)
  to authenticated;
