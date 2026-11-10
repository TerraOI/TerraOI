# ADR-0005 OCR job API, lease fencing, and the artifact home (T-211 prerequisite)

Status: **accepted** — this PR is the implementation: the one migration
[`20261109230000_ocr_job_leases.sql`](../../supabase/migrations/20261109230000_ocr_job_leases.sql),
pgTAP [`045_ingestion_jobs.test.sql`](../../supabase/tests/database/045_ingestion_jobs.test.sql),
[ADR-0011](0011-object-bytes-for-the-extraction-workers.md) and
[`scripts/worker-credential.mjs`](../../scripts/worker-credential.mjs). The sketches below stay in
place as the review trail: where the implemented shape differs, §10c and the section banners say so. The four questions it was blocked on ([#51](https://github.com/TerraOI/TerraOI/issues/51), [#66](https://github.com/TerraOI/TerraOI/issues/66), [#75](https://github.com/TerraOI/TerraOI/issues/75), [#38](https://github.com/TerraOI/TerraOI/issues/38)) were answered on 2026-11-08 (see the issues; §10 keeps the options as they stood), and the #91 review's blocking items B1–B3 are fixed in §1, §2, §4 and §7. Moving to *accepted* is the supervisor's next step. Also touches [#93](https://github.com/TerraOI/TerraOI/issues/93), [#99](https://github.com/TerraOI/TerraOI/issues/99), [#40](https://github.com/TerraOI/TerraOI/issues/40), [#60](https://github.com/TerraOI/TerraOI/issues/60), [#68](https://github.com/TerraOI/TerraOI/issues/68) and #6 · Date: 2026-11-07 · Deciders: supervisor (job API, worker role, artifact home), Lane 2 (extractor inputs)
Plan refs: §7.2 (extraction executors, line 386; steps 2–3), §7.5 (line 406), §13 (lines 824, 826–831), §16 (ingestion row, line 945), §20.8 (human steps); F12, F32

This is the **T-211 design written as a proposal**, not a claim on T-211 (T-115 b/c/d are unmerged) and not an answer to any open question. Every SQL block below is a sketch inside this ADR: no file under `supabase/migrations/` is written, because the timestamp is the daily sync's to claim ([COORDINATION.md §3](../COORDINATION.md)) and one migration may not encode two undecided designs. [T-211](../tasks/T-211-ocr-worker.md) is the packet that would implement it.

## 1. Context: two facts the whole design rests on

**Fact 1 — the lease surface already exists and has no writer.** `ingestion_jobs` carries `attempt` 1..100 ([`20261105070000_knowledge_core.sql:373`](../../supabase/migrations/20261105070000_knowledge_core.sql)), `lease_token` (8..128 chars, `:374`), `lease_expires_at` (`:375`), the constraint binding them as a pair `ingestion_jobs_lease_pair` (`:392-393`), `ingestion_jobs_local_box_runs_only_extract` (`:390-391`), the data-class CHECKs (`:385-388`) and the stage idempotency key `unique (organisation_id, source_version_id, stage, parser_generation, index_generation)` (`:398`). `git grep -n -I "update public.ingestion_jobs" -- supabase` at `467f169` returns **nothing**, and the grants are `revoke all … from anon, authenticated` then `grant select` (`:884-894`), so today no **request role** (`anon`, `authenticated`) can lease, renew, complete or abort anything. That revoke does not name `service_role`: `supabase/config.toml:19-23` leaves new `public` tables reachable by `service_role` by default, and `service_role` bypasses RLS (§6), so a server path holding the service key could write the lease columns today. The only merged migration that revokes from `service_role` is the intake one ([`20261105210000_intake_service_role.sql:6-8`](../../supabase/migrations/20261105210000_intake_service_role.sql)); the job-API migration must make the same revoke on `ingestion_jobs` and on every table it adds (§4). T-211's "one migration … for lease/claim columns" (`docs/tasks/T-211-ocr-worker.md:15-17`) is therefore **not** about columns — they are there; the migration is about the write surface, one new fence column, and the artifact home.

**Fact 2 — every write target for extracted text is frozen or unreadable-by-write.** `source_versions_immutable()` raises `23514` on any change to `parser_generation` (`:575`), `payload` (`:576`) **and** `body_text` (`:577`); the trigger is at `:593-594`. The only insert path, `register_source_version_v1` ([`20261106100000_knowledge_uploads.sql:448-466`](../../supabase/migrations/20261106100000_knowledge_uploads.sql)), writes a capture-metadata payload and leaves `body_text` null. `knowledge_chunks` — the other candidate — has no insert path either: members hold `select` only (`knowledge_core.sql:884-894`) and chunking is T-113's ([`docs/tasks/T-113-chunk-embed-publish.md:11-13`](../tasks/T-113-chunk-embed-publish.md)). And the extractor that would produce the text returns it **in memory only**: `extractPdfTextLayer` yields `outcome: 'extracted' | 'no_text_layer' | 'parse_failed'` ([`src/platform/knowledge/pdf-text-extract.ts:56`](../../src/platform/knowledge/pdf-text-extract.ts)), and the object port is read-bounded with no write and no URL minting ([`src/platform/knowledge/object-store.ts:19-21`](../../src/platform/knowledge/object-store.ts)).

Consequence, stated before any option: with today's schema, `complete_parse_job_v1` has **nothing legal to write**. That is #51, and it is why this ADR cannot be "accepted" by a lane.

## 2. Decision 1 — where the worker-facing RPCs live

Four RPCs named by the packet — `lease_parse_job_v1`, `renew_parse_lease_v1`, `complete_parse_job_v1`, `abort_parse_job_v1` (`docs/tasks/T-211-ocr-worker.md:29-30`), plus a fifth this ADR proposes (§5).

The sketch puts them in a dedicated schema, and this is a **shape description, not a ruling**:

```sql
-- SKETCH ONLY. Not a migration; no timestamp claimed.
create schema if not exists job_api;
revoke all on schema job_api from public, anon, authenticated, service_role;
```

Why the sketch is drawn that way, with the two facts the supervisor should weigh against it:

- **The default in `public` is open, and #60 proves it bites.** `knowledge_core.sql` creates 15 functions in `public` and grants execute on 7 (`:903-911`); PostgreSQL's default `EXECUTE` to `PUBLIC` leaves all 15 with `PUBLIC` execute. The four `*_is_readable` predicates are the `/rpc`-reachable ones (they return `false` for `anon`); the other eight are trigger functions (`returns trigger`), which error when called directly. That is hardening rather than an open leak, as [`docs/status/2026-W45.md:25`](../status/2026-W45.md) records. The intake migration revokes **per function** ([`20261105080000_pilot_inquiries.sql:70-73,89`](../../supabase/migrations/20261105080000_pilot_inquiries.sql)), T-112 does the same by name ([`20261106100000_knowledge_uploads.sql:601-612`](../../supabase/migrations/20261106100000_knowledge_uploads.sql)), and [`20261105210000_intake_service_role.sql:10-11`](../../supabase/migrations/20261105210000_intake_service_role.sql) writes the obligation down: *"each later migration revokes its own new functions"*. A job RPC in `public` would be the first function in that schema whose arguments are **job ids and lease tokens**.
- **A non-exposed schema is unreachable without a direct connection — and #75 has not decided that connection exists.** `supabase/config.toml:13` exposes only `schemas = ["public", "graphql_public"]`, and `:15` puts `public, extensions` on the request `search_path`. So the five functions in §3–§5 are only callable from a direct Postgres connection (Hyperdrive precedent, §6), and **the packet's staging evidence is unproducible until #75 answers** (see §8).

Either way, every one of the five functions carries its own `revoke … from public, anon, authenticated, service_role` at creation. That part is not optional under any option.

## 3. Decision 2 — lease and renew, and a monotonic fence

**The packet's identity mechanism cannot work as written, and the supervisor owns the replacement.** T-211 says the RPCs are *security invoker* and apply `set_tenant_scope(uuid)` (`docs/tasks/T-211-ocr-worker.md:29-32`). But `set_tenant_scope` raises `28000` when `auth.uid()` is null ([`20261105060000_tenancy_core.sql:206-210`](../../supabase/migrations/20261105060000_tenancy_core.sql)) and again unless the caller is an **active member** (`:214-216`). A box has no employee session by plan: "no database credentials or service-role keys live on the box" (§13 line 829) and "Workers hold no database credentials and no employee session" ([`docs/contracts/knowledge-and-jobs.md:46-47`](../contracts/knowledge-and-jobs.md)).

- **Option 1 (packet as written):** mint machine `profiles` + `organisation_memberships` rows so `auth.uid()` resolves. Cost: that principal then holds the whole `authenticated` surface — SELECT on eight knowledge tables (`knowledge_core.sql:890-894`) and execute on the four `*_is_readable` predicates (`:903-911`) — and it appears in provenance columns as if it were a person.
- **Option 2 (the shape sketched here):** `security definer` RPCs that take the tenant **from the job row**, never from an argument, and authenticate the caller by a worker id supplied as a transaction-local GUC and checked against a worker→tenant grant. No table grant exists for the worker role, so RLS is not the mechanism — the absence of privileges is.
- The sketch in §4 is drawn against Option 2. Under Option 1 only the scope source changes (`current_worker_id()` → `current_organisation_id()`) and the grant table in §4 is replaced by membership rows; the five signatures, the fence rule, the artifact table and every pgTAP group in §7 are unchanged. This ADR does not choose.

Transaction-local, for the reason the merged code already gives (`is_local => true`, `tenancy_core.sql:200-201` — a value that cannot outlive the transaction, which is what makes a pooled connection safe):

```sql
-- SKETCH ONLY.
create table job_api.worker_credentials (
  id uuid primary key default gen_random_uuid(),
  label text not null unique check (label ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  -- the presented token is never stored, only its digest: the ip_hash discipline of ADR-0002 §4
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  organisations uuid[] not null check (cardinality(organisations) between 1 and 8),
  created_at timestamptz not null default now(),
  revoked_at timestampt
);

create function job_api.current_worker_id() returns uuid
language sql stable set search_path = job_api, public, pg_temp as $$
  select nullif(current_setting('app.worker_id', true), '')::uuid
$$;

alter table public.ingestion_jobs
  add column lease_fence bigint not null default 0 check (lease_fence >= 0);  -- the ONE column
```

**The hole this ADR must state rather than paper over: a uuid is a capability, not authentication.** `current_worker_id()` reads a GUC, and the grant checks in §3/§5 compare that uuid against `worker_credentials.organisations` — but nothing sketched above ever converts a **presented credential** into that uuid. `token_hash` is stored and never consulted by any function in this document. Under §6 option 1's single shared role, a box that can set a session GUC can claim another box's identity. The merged analogue the design borrows from works only because `set_tenant_scope` is anchored on `auth.uid()` (`20261105060000_tenancy_core.sql:203-216`), which does not exist for a box. Three possible homes for that rule, none of them this lane's to pick: (i) a per-box login/role or per-box Hyperdrive credential, so the connection itself identifies the box and the API layer sets `app.worker_id` from a verified lookup; (ii) a job-API verify step that hashes the presented token and looks the row up before any RPC runs; (iii) tunnel/mTLS identity mapped to a worker id. **Until one is chosen, `revoked_at` on a credential bounds only new leases:** the mutating compares do not consult `worker_credentials`, so a revoked credential that already holds a token and a fence keeps renewing and completing until `lease_expires_at` (≤ `p_lease_seconds`, capped at 1800 s here). The alternative is to join `worker_credentials … and revoked_at is null` into every mutating compare, which this ADR now names as the cheaper of the two and still does not choose. **Chosen, on #134, and implemented:** every job-API function takes the presented token's **hash** as its first argument and joins `worker_credentials … and revoked_at is null` — together with the executor and the tenant array — inside the same statement as the lease token, the fence and the expiry. There is no `app.worker_id` GUC anywhere in the merged shape, so the "a uuid is a capability, not authentication" hole is closed at the only place it could be closed: the compare. §10c states the residual, which is that the stored digest is itself a capability.

```sql
-- SKETCH ONLY. lease: one job at a time, expired-or-unleased only, tenant from the row.
create function job_api.lease_parse_job_v1(p_stage text, p_lease_seconds integer)
returns table (o_found boolean, o_job_id uuid, o_organisation_id uuid, o_source_version_id uuid,
               o_stage text, o_parser_generation text, o_index_generation integer,
               o_data_class text, o_lease_token text, o_fence bigint, o_attempt integer)
language plpgsql security definer set search_path = job_api, public, pg_temp as $$
declare v_worker uuid := job_api.current_worker_id(); v_job public.ingestion_jobs;
begin
  if v_worker is null then raise exception 'worker identity is required' using errcode = '28000'; end if;
  if p_stage is null or p_stage <> 'extract' then
    raise exception 'the local box only runs extraction (§13)' using errcode = '22023'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'lease seconds out of range' using errcode = '22023'; end if;

  select * into v_job from public.ingestion_jobs j
   where j.stage = 'extract' and j.executor = 'local_box'
     and j.data_class <> 'restricted'                        -- belt-and-braces only: a restricted job row cannot exist, because
      --   ingestion_jobs_data_class_ingestible_in_m1 (:387-388 via :70-74) already refuses it,
      --   pinned at 020_knowledge.test.sql:736-737. Kept visible, not presented as the gate
     and j.status in ('queued','leased','running')
     and (j.lease_expires_at is null or j.lease_expires_at < now())
     and j.organisation_id = any (select w.organisations from job_api.worker_credentials w
                                  where w.id = v_worker and w.revoked_at is null)
   order by j.created_at
     for update skip locked
     limit 1;
  if not found then o_found := false; return next; return; end if;   -- foreign id == unknown id

  update public.ingestion_jobs
     set status = 'leased',
         lease_token = encode(gen_random_bytes(24), 'base64'),   -- 32 chars: inside :374 and the Zod bound
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         lease_fence = lease_fence + 1,
         attempt = attempt + 1                                   -- bookkeeping only, never the key
   where id = v_job.id
   returning lease_token, lease_fence, attempt into o_lease_token, o_fence, o_attempt;
  o_found := true; o_job_id := v_job.id; /* …the rest is copied from v_job… */
end; $$;
```

**Why a fence and not a clock.** A worker whose lease has expired still holds a valid `lease_token` until somebody re-leases, so testing `lease_expires_at < now()` on the caller's side accepts a late completion from a box that was partitioned and kept working; and `updated_at` is maintained by a trigger (`:799`) so it cannot distinguish a re-lease from any other update. Two machines' clocks also disagree, and the box is the one that cannot be trusted to agree. So every mutating call carries the fence it was issued, and the mutation is a guarded compare:

```sql
   where id = p_job_id and lease_token = p_lease_token and lease_fence = p_fence
     and status in ('leased','running')
     and lease_expires_at > now()       -- the arm this ADR first omitted; see below
```

A re-lease incremented `lease_fence`, so the dead worker's statement matches **zero rows**. **Correction to this ADR's first draft, which got that wrong in a way a reviewer should see rather than discover:** the fence alone does not cover the case the paragraph above sets up. If the lease expires and **nobody re-leases** — and with one box per tenant that is the normal outcome, since `retarget` refuses a non-`queued` row and the box is the only consumer — the token still matches, the fence is unchanged and the status is still `leased`, so a late completion from the partitioned box matches **one** row and writes artifacts. That is why the compare carries the expiry arm as well: the fence defeats a *re-leased* worker, the server-side `lease_expires_at > now()` defeats an *abandoned* one. A reclaim sweep that bumps `lease_fence` on expiry is the equivalent fix; either way, one of the two arms must exist. `attempt` is deliberately **not** the fence: it is capped at 100 (`:373`) and the contract keeps it outside the idempotency key on purpose ([`src/contracts/ingestion-job.ts:35-39`](../../src/contracts/ingestion-job.ts)), so it must stay bookkeeping.

`renew_parse_lease_v1(p_job_id, p_lease_token, p_fence, p_lease_seconds)` uses the same compare — expiry arm included — and the same tenant/version/stage re-checks, and touches only `lease_expires_at`; a zero-row match is a named refusal (`42501`), never a silent no-op — a worker that believes it still holds a lease must find out immediately.

## 4. Decision 3 — the artifact home, and the re-parse collision it dissolves

```sql
-- SKETCH ONLY. Blocked on #51. No timestamp claimed.
create table public.extraction_artifacts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  source_version_id uuid not null,
  job_id uuid,
  stage text not null check (stage in ('validate','extract','index','publish')),
  parser_generation text not null check (parser_generation ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  index_generation integer not null check (index_generation > 0),
  artifact_index integer not null check (artifact_index >= 0),
  -- identical shape check to knowledge_chunks.locator (:242-248), so sheet/row/column locators
  -- (T-212) can be added without ever editing a merged constraint
  locator jsonb not null default '{}'::jsonb
    check (jsonb_typeof(locator) = 'object'
      and (locator -> 'page' is null or jsonb_typeof(locator -> 'page') = 'number')
      and (locator -> 'section' is null or jsonb_typeof(locator -> 'section') = 'string')
      and (locator -> 'table' is null or jsonb_typeof(locator -> 'table') = 'string')),
  body_text text not null check (char_length(body_text) between 1 and 100000),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  notes jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  producer text not null check (producer in ('cloud_worker','local_box')),
  data_class text not null,
  fence bigint not null check (fence >= 0),
  created_at timestamptz not null default now(),
  constraint extraction_artifacts_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint extraction_artifacts_source_version_fk
    foreign key (source_version_id, organisation_id)
    references public.source_versions (id, organisation_id) on delete cascade,
  constraint extraction_artifacts_data_class_is_valid check (public.data_class_is_valid(data_class)),
  constraint extraction_artifacts_data_class_ingestible_in_m1
    check (public.data_class_is_ingestible_in_m1(data_class)),
  unique (id, organisation_id),
  unique (organisation_id, source_version_id, stage, parser_generation, index_generation, artifact_index)
);

-- New public tables are privileged for anon, authenticated and service_role by default
-- (supabase/config.toml:19-23). Close all three, then grant only the member read the RLS
-- policy below scopes (precedent: knowledge_core.sql:884-894). Writes go through job_api only.
revoke all on public.extraction_artifacts from anon, authenticated, service_role;
grant select on public.extraction_artifacts to authenticated;
```

- **Class:** `data_class` is the highest among the artifact's inputs (AGENTS.md §4.4, [`maxDataClass`](../../src/contracts/data-class.ts)), enforced by a guard **function *and* its trigger** — and this ADR's first draft named the guard while its sketch contained no `create function` and no `create trigger`, so as drawn the table enforced nothing at all about the parent's class. The merged precedent is a SECURITY DEFINER trigger function attached at `knowledge_core.sql:698-699`; the table itself carries only the `data_class_is_valid` / `…_ingestible_in_m1` CHECKs (`:266-269`). It also has **two** halves, and this table wants both: content immutability (`:666-677`, "a correction creates a new source version") and class non-lowering (`:678-681`), the latter only ever firing on UPDATE — which is meaningful only if the guard decides what may be updated at all. The sketch is below the bullet list. The `…_ingestible_in_m1` CHECK makes a `restricted` artifact unwritable, matching the contract cut ([`src/contracts/provider-route.ts:172-175`](../../src/contracts/provider-route.ts)).
- **RLS:** a policy in the shape of `knowledge_chunks_scoped_read` (`:833-838`) — `is_active_member(organisation_id) and organisation_id = public.current_organisation_id() and public.source_version_is_readable(source_version_id)`. AGENTS.md §4.2's three negatives are all provable here: another tenant (composite FK → `23503`, the mechanism at `:263-265`); another project (`collection_is_readable`'s project arm, `:442`); a deactivated member (`is_active_member` filters `status = 'active'`, `tenancy_core.sql:184`).
- **The collision this dissolves.** Content dedup is `unique (collection_id, content_hash)` (`:220`). Under #51's option 3 (an extraction creates a new version), re-running a parser over the same bytes for the same collection is a unique violation, and re-parsing with a new `parser_generation` is impossible anyway because that column is frozen (`:575`). With artifacts keyed by `(version, stage, parser_generation, index_generation, artifact_index)`, a re-parse writes a **second artifact set against the same immutable version**: no new version row, so `:220` is never touched, and the plan's line that a correction — not an extraction run — creates a new version (§7.2) keeps its meaning.
- `knowledge_chunks` stays T-113's table, fed *from* artifacts. This ADR writes no chunk and no `body_text`.

**Where does a stale artifact go when the parent's class rises?** Nowhere, and the ADR should say so instead of implying the guard covers it. The merged guard consults the parent only on child insert/update (`:685-693`); `source_versions_immutable` refuses a *lowering* but accepts a raise (`:583-588`), and `020_knowledge.test.sql:680-681` pins that a reviewer's raise is accepted. So an artifact written before a raise keeps its lower `data_class` forever, and any later consumer that trusts that column (T-113 chunking, exports) inherits a too-permissive value. Exposure is bounded because the read policy is parent-gated (`source_version_is_readable`), but the stored column lies. Three homes, unchosen: re-check on read, re-check in a parent-side trigger, or state the gap with the read-side mitigation named.

```sql
-- SKETCH ONLY. The half of §4 that the first draft left as prose.
create or replace function public.extraction_artifacts_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_class text;
begin
  if tg_op = 'INSERT' then
    select data_class into v_class from public.source_versions where id = new.source_version_id;
    if v_class is null then raise exception 'unknown source version' using errcode = '23514'; end if;
    if public.data_class_rank(new.data_class) < public.data_class_rank(v_class) then
      raise exception 'artifact class % is below its version class %', new.data_class, v_class
        using errcode = '23514';
    end if;
    return new;
  end if;
  -- §7.2 again: a correction is a new generation of artifacts, never an edit in place.
  raise exception 'extraction artifacts are insert-only' using errcode = '23514';
end; $$;

create trigger extraction_artifacts_guard before insert or update on public.extraction_artifacts
  for each row execute function public.extraction_artifacts_guard();
```

`complete_parse_job_v1(p_job_id, p_lease_token, p_fence, p_artifacts jsonb, p_notes jsonb, p_ocr_confidence numeric)` in one transaction: re-read the job row `for update`, check it belongs to a tenant this credential serves, and re-check **version and stage** as well — plan §7.2 line 386 says the job API "checks the lease, tenant, version and expected stage on **every** call" (and `docs/contracts/knowledge-and-jobs.md:35` restates it), which the first draft of this ADR enforced only in `lease` (identical `42501` for foreign and unknown, the capture-path idiom at `20261106100000_knowledge_uploads.sql:368-372`); re-read the parent version's `state` and refuse `revoked / deleting / deleted` (the same filter as `source_version_is_readable`, `knowledge_core.sql:471`); flip `status='succeeded'` **only** under the fence compare; insert the artifact rows **with `source_version_id`, `stage`, `parser_generation` and `index_generation` copied from the job row, never taken from `p_artifacts`** — §4's unique key contains those generations, so caller-supplied values would not collide, they would silently claim a generation that never ran; append exactly one `outbox_events` row (`event_type`/`aggregate_type` shapes per `:409-411`). If the compare matches zero rows and the status is already `succeeded`, return `already_completed` **after writing nothing** — that is what makes a duplicate delivery a no-op instead of a second artifact set. `abort_parse_job_v1(p_job_id, p_lease_token, p_fence, p_reason_code)` sets `status='cancelled'`, clears the lease pair together (`:392-393`), writes a safe code into `last_error` (1..500 chars, `:376`), and deletes that job's unfenced artifacts — **an exception to a merged convention, argued rather than slipped past**: `knowledge_core.sql:900-901` states that no request role gets DELETE and "hard deletion is a retention job, and the state machines carry the user-visible meaning (§7.5)". The justification here is that an unfenced artifact set is uncommitted output of a job that has failed, not a user-visible record. One case this leaves undefined and now names: a job that already `succeeded` has no *unfenced* output to clean, so abort-after-success must be a refusal, not a deletion — and its artifacts stay, because a later correction is a new generation (§4), not an overwrite.

## 5. Decision 4 — `retarget_extract_job_v1` is a one-way door (#66)

Capture cannot make this decision: `sniffSignature` types bytes by signature alone ([`src/platform/knowledge/object-validator.ts:65-87`](../../src/platform/knowledge/object-validator.ts)), while the plan's predicate is "digital PDFs **with a usable text layer**" (§7.2 line 386) — "usable" is only knowable after a parse, and the parse budget (`DEFAULT_EXTRACTION_LIMITS.maxDecompressedBytes`, `pdf-text-extract.ts:41-45`) is not the capture budget (`object-validator.ts:30-32`).

And the merged schema forbids the easy fix: `:398` does not include `executor`, and capture enqueues with `on conflict (…stage key…) do nothing` (`20261106100000_knowledge_uploads.sql:470-478`) — inserting a second row for the box is **silently discarded**, producing a scanned PDF with a cloud row and no visible failure. Re-targeting is necessarily an UPDATE of the existing row.

```sql
-- SUPERSEDED by §10c and by the migration as written: #134 narrowed the caller to the cloud worker
-- that holds the lease, so the guard is the lease token + fence, not `status = 'queued'`, and the
-- identity is the presented digest, not a self-asserted `current_worker_id()`. Kept as the trail.
-- Note: executor can only ever move cloud_worker -> local_box.
create function job_api.retarget_extract_job_v1(p_token_hash text, p_job_id uuid, p_lease_token text,
                                                 p_fence bigint, p_reason_code text)
returns table (o_outcome text, o_executor text, o_status text, o_fence bigint)
language plpgsql security definer set search_path = job_api, public, pg_temp as $$
begin
  if p_reason_code is null or p_reason_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'reason must be a safe code' using errcode = '22023';
  end if;
  update public.ingestion_jobs
     set executor = 'local_box', status = 'queued', lease_token = null, lease_expires_at = null,
         lease_fence = lease_fence + 1, last_error = p_reason_code   -- §10c: pair cleared together,
                                                                     -- fence bumped (the #99 invariant)
   where id = p_job_id
     and stage = 'extract'                                   -- :390-391, belt-and-braces
     and executor = 'cloud_worker'                           -- the one-way door
     and lease_token = p_lease_token and lease_fence = p_fence       -- §10c: a live lease, proved by pair
     and status in ('leased','running') and lease_expires_at > now()
     and data_class <> 'restricted'                          -- :385-388
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = 'cloud_worker'            -- §10c: one credential, one executor (#135)
                    and j.organisation_id = any (c.organisations))
   returning executor, status into o_executor, o_status;
  if not found then
    o_outcome := 'refused'; return next; return;             -- row may or may not exist: same answer
  end if;
  o_outcome := 'retargeted'; return next;
end; $$;
```

The caller chain is T-212's pure routing decision (§7.2 line 386; the quality result is `extractPdfTextLayer`'s `outcome`) → the job API → this RPC. T-212 writes nothing to `ingestion_jobs` — that is exactly the blocker recorded on #66. The race is stated rather than hidden: if the cloud worker already leased the row, the guard refuses and the box waits for the next attempt; correspondingly, a cloud completion for a row whose `executor` is `local_box` must be refused by the executor match. **A dependency worth making explicit, because it is load-bearing and cheap to break later:** `retarget` does not bump `lease_fence`, and its safety rests entirely on the `status = 'queued'` arm of both this guard and the mutating compare. If the status set in that compare is ever widened, retarget's race reopens silently — so widening it requires a fence bump here. Related honesty note: "leases one job at a time" (plan §7.2 line 386) is a property of *one call*, not of a worker — no column records which worker holds a lease, so a caller can accumulate several live leases, and nothing can release an abandoned box's leases when its credential is rotated. Capability-based leasing is a legitimate choice; it should be named as one.

**"Queued for OCR" (plan §7.2 line 386) is not a status value.** The CHECK at `:362-363` offers only `queued/leased/running/succeeded/failed/cancelled`. **Option A:** derive the visible state from `executor = 'local_box' and status in ('queued','leased')` — no schema change, and the state stays a projection. **Option B:** a new migration replaces that CHECK with an added value — one more constraint change on a merged table, and the merged assertion that pins `'extract/cloud_worker/queued'` at capture ([`supabase/tests/database/040_knowledge_uploads.test.sql:406-409`](../../supabase/tests/database/040_knowledge_uploads.test.sql)) must be updated **in the same PR** if routing ever moves to capture time. The sketch is neutral: it changes only the projection, and pgTAP group 8 asserts whichever pair is chosen.

## 5b. The attempt cap starves the queue without a dead-letter home (plan §7.5 line 406)

Plan §7.5 line 406 asks for "bounded retries, **a dead-letter path and a reconciler** for stuck/missing jobs". The repo contains neither, anywhere: `git grep -in "dead_letter|reconciler"` over `supabase/`, `src/` and `docs/contracts/` at `467f169` returns nothing. That is not a missing nicety — combined with this design it is a queue killer. `attempt` is capped by a CHECK (`knowledge_core.sql:373`: `between 1 and 100`); the lease bumps it (§3); and the lease select takes `order by j.created_at … limit 1` over rows still in `('queued','leased','running')` whose lease is null or expired. When a job reaches the cap, the lease's own UPDATE raises `23514` **inside the same transaction**, and because nothing moves that row out of the eligible set, every later lease call trips on the same first-in-line row: **one poisoned extract job stops that tenant's box permanently.** No function in this ADR ever writes `status = 'failed'`, though the state exists at `:362-363`.

So the design owes one of two things, and the choice is the supervisor's because it changes a state machine rather than plumbing:

- **House it.** The lease select excludes rows at the cap; the completing/aborting RPC moves them to `status = 'failed'` with a reason code in `last_error`; and a reclaim sweep bumps `lease_fence` on an expired lease so an abandoned job becomes re-leasable (which is also the alternative fix for §3's expiry arm).
- **Declare it a non-goal here.** Name the packet that owns dead-letter and reconciliation — none does today (the closest is T-405's dashboards, which are explicitly out of scope for this packet) — and record plainly that a single stuck `extract` job blocks the tenant's box until a human intervenes.

Either way pgTAP gains the cap case: the 101st lease must not be an error, and a capped row must stop being first-in-line.

## 6. Decision 5 — the worker's credential and the Postgres path

The box authenticates **outbound to the job API**, never to Postgres (§7.2 line 386; §13 line 829). The job API is a Worker under `src/app/api/jobs/` — a Lane 2 route folder that does not exist yet, protected in CODEOWNERS ([FAQ-0005](../FAQ.md)). The role question is therefore "who does the job API connect as", and it is the same fork #75 is open on for sessions:

1. **Hyperdrive + a dedicated NOLOGIN role**, the ADR-0002 precedent ([`docs/decisions/0002-pilot-inquiry-intake.md:22-25`](0002-pilot-inquiry-intake.md)): a login user `IN ROLE inquiry_writer`, the `INQUIRY_DB` binding, and the containment statement "a leaked Hyperdrive credential can insert inquiries, within the CHECK limits, and do nothing else". Analogue here, **ruled on #134 and implemented in this PR**: role `toi_job_api` (`NOLOGIN`), `usage` on `job_api`, `execute` on the six job-API functions **by name**, **no table grant at all**, reached over a **`JOB_DB`** Hyperdrive binding that only the owner creates (T-004 §20.8, `docs/tasks/T-004-infrastructure.md:11`). `wrangler.jsonc` today records one Hyperdrive binding, added to `env.staging` by the owner as a human step ([`wrangler.jsonc:12-14`](../../wrangler.jsonc)).
2. **The Data API with a token** — unavailable: there is no employee token here, and only `public`/`graphql_public` are exposed (`supabase/config.toml:13`).
3. **`service_role`** — permitted only in a documented server path with an ADR (AGENTS.md §4.2), and it bypasses RLS on every tenant table. Not sketched here.

This ADR did not choose; **this PR implements option 1** (#134). §2–§5 held to their promise — the choice changed only the connection target, not a signature or a guard — with one exception §10c records: the identity mechanism became the presented credential's **digest**, carried as the first argument of every function, because a GUC a caller sets for itself is not authentication.

## 7. Decision 6 — pgTAP slot `045_ingestion_jobs.test.sql`, and `plan(93)`

- The packet names `040_ingestion_jobs.test.sql` (`docs/tasks/T-211-ocr-worker.md:18,36`), but **040 is merged**: [`supabase/tests/database/040_knowledge_uploads.test.sql`](../../supabase/tests/database/040_knowledge_uploads.test.sql) is 652 lines with `select plan(63)` (`:18`), and merged test files are never renamed (COORDINATION §3).
- `050` is **already promised** to T-213 ([`docs/tasks/T-213-review-publish-revoke.md:19`](../tasks/T-213-review-publish-revoke.md)), and the session train has taken `014`. So `045` is the only slot that is both adjacent to the knowledge/job suites and unclaimed.
- Order is safe: `supabase test db` is the last database gate in CI ([`.github/workflows/ci.yml:56`](../../.github/workflows/ci.yml)) and runs the directory in file-name order, while every file is its own `begin; … rollback;` transaction (`040…sql:15`, [`000_guardrails.test.sql:3,31`](../../supabase/tests/database/000_guardrails.test.sql)). A `045` between `040` and `050` cannot change what another file sees.
- `select plan(93)` was the tally of this ADR's first draft. **As implemented, `045` runs `select plan(131)`** — 131 numbered assertions, 1..131, one statement each, checked against the file before pushing. The tally grew because #99, #134, #135 and #146 each added assertions (reclaim and the dead letter, the credential arm, the executor arm, the object-locator refusals, the reconciler), and because group 1 as written here could not have held what it describes: five functions × three roles is already fifteen privilege assertions, so 14 was a placeholder, not a count. The original sum of (the first draft said 80; the three added fencing assertions, the attempt-cap case, the two artifact-guard assertions, the new credential group and the two table-privilege negatives are what moved it): schema/privilege shape **14** (schema not exposed; five functions exist; `has_function_privilege` false for `anon`/`authenticated`/`service_role` and true only for `terraoi_job_writer`; new table RLS enabled; composite `(id, organisation_id)` present; `has_table_privilege('anon', 'public.extraction_artifacts', 'select') = false` and `has_table_privilege('service_role', 'public.extraction_artifacts', 'insert') = false`), lease **6**, lease isolation **8**, renew **6**, complete and its writes **9**, fencing **10** (adds the three cases the first draft had no group for: an expired lease that was never re-leased cannot complete; renew after expiry refuses; a credential revoked mid-lease is bounded exactly as §3 says), idempotency and ordering **8** (adds the attempt-cap case from §5b), retarget guards **8**, artifacts **10** (the three RLS negatives + the **trigger** refusing an artifact below its parent's class + immutability of artifact content + `restricted` refusal + cross-tenant FK `23503`), abort/revocation/offline **8**, worker credential and identity **6** (the table's shape CHECKs, the absence of any grant to request roles, and — once §3's identity mechanism exists — an assertion that a forged worker id cannot lease; today that group can only assert the *absence* of a mechanism, which is itself the honest finding).
- `plan(N)` must equal the number of assertions actually executed or pgTAP fails the run, so the number and the group list move together in one commit. Assertions are never dropped to make a run green (AGENTS.md §6).
- Two corrections this ADR makes rather than repeating: at `467f169` there is **no** `999_violation_probe.test.sql` in the suite, and "the next free pgTAP file is 050" is wrong for the reason above.

## 8. Threat model

- **A leaked worker credential can** lease one extract job at a time within the tenants named in its `worker_credentials.organisations` array, renew its own lease, complete it with an artifact set, and abort it. That is the whole point of the design and it is bounded: no table grant exists, so a direct `select` on `source_versions`, `knowledge_chunks`, `profiles` or anything else is a privilege error; the five functions are unreachable from HTTP (§2); the credential digest, not the token, is stored.
- **A leaked worker credential cannot** read another tenant's queue, change a job's tenant, stage or data class, move `local_box` back to `cloud_worker` (§5's door), write a chunk or a vector, alter a `source_version`, or learn that any job exists outside its tenants. `revoked_at` on the credential row stops all **new** work in one statement; an in-flight lease lives until `lease_expires_at` unless the mutating compare is extended to consult the credential row (§3's note), and rotation is a §20.8 human step.
- **Another tenant's job id gives no existence signal.** Lease returns `o_found = false` — the identical answer to "no work" — and complete/renew/abort raise one indistinguishable `42501` for foreign, unknown and already-gone rows, the same discipline the merged capture RPC states at `20261106100000_knowledge_uploads.sql:368-372` and #13(2) required.
- **A stale lease cannot write — with two arms, not one.** The fence is monotonic per job and carried by the caller, and the mutation is `where lease_token = $1 and lease_fence = $2 and status in ('leased','running') and lease_expires_at > now()`. After a re-lease the fence has moved, so the old worker's write matches zero rows; after an *abandonment* the fence has **not** moved, and it is the server-side expiry arm that refuses. Clock-side tests alone accept a late completion whenever nobody re-leased; `updated_at` (`:799`) cannot tell a re-lease from an unrelated update. §7 group "fencing" is where both interleavings get pinned.
- **Third-party OCR is unreachable three independent ways.** (1) No function sets `executor` to `cloud_worker` for stage `extract` — §5 is one-way. (2) Any "send the scan to a cloud OCR provider" call would be a model route, and route selection drops providers the data class does not clear (`RouteSkipReason "not_cleared"`, [`src/platform/gateway/route.ts:74,146,160`](../../src/platform/gateway/route.ts)), with `client_confidential` cleared by default only to `local_box, claude` ([`src/contracts/provider-route.ts:81`](../../src/contracts/provider-route.ts)) and `restricted` un-ingestible (`:172-175`). (3) There is no OCR adapter, and no `model_providers`/`provider_routes` tables exist yet (#45; T-115 b/c/d unmerged) — that one *is* pgTAP-assertable (`hasnt_table`) and §7 now claims it. **And a gap this ADR does not close, because the plan leaves it open:** §7.2 line 386 says these jobs are not re-routed to a third-party OCR service "unless the collection's data class permits a **named alternative**". Nothing anywhere above — no column, config row or predicate — could express a named alternative, and bullets 1-3 describe only the refusal path. If #66's answer ever permits one, this is the first hole to fill.
- **Untrusted content stays content.** The extractor is an observer, never an interpreter (`pdf-text-extract.ts:14-30`, `pdf-format.ts:1-11`); artifact `notes` and `locator` values are stored as data with shape CHECKs, and nothing in this design evaluates text found inside a document (AGENTS.md §4.8).

## 9. Human steps (plan §20.8) — all blocked on #75

None of these may be done by an agent or a builder, and none is a repository secret. **Until #75 decides the mechanism, none of §3–§5 is reachable at all**, so T-211's staging evidence — "upload a synthetic scanned PDF for company1 and show the lease/complete sequence, then upload on the company2 host and show its job is invisible to company1's worker credential" (`docs/tasks/T-211-ocr-worker.md:52-54`) — is unproducible, and CI's pgTAP is the only authority (§7).

1. Create the NOLOGIN role `toi_job_api` and a login user `IN ROLE` it, with a generated password held only in the password manager. The migration creates the **role** idempotently (the `inquiry_writer` precedent); the login user, its password and the `JOB_DB` binding are the owner's, and no agent may create them (#134, `docs/tasks/T-004-infrastructure.md:11`).
2. Create the Hyperdrive configuration against the staging database and bind it in `wrangler.jsonc` under `env.staging` — the same human step that is still open for `INQUIRY_DB` (`wrangler.jsonc:12-14`, and #75 records that the intake login/Hyperdrive pair is unprovisioned too).
3. Issue the box's worker credential (a value whose digest lands in `job_api.worker_credentials`), and bind the clear-text half as a secret on the box only — never in the repo, never in an agent chat (AGENTS.md §4.6).
4. Set the tunnel/access policy so the box stays outbound-only (§13 lines 826–831), and record the staging-vs-production separation.
5. Confirm in the dashboard that `job_api` is not an exposed API schema — `supabase/config.toml:13` is only the local truth, exactly as ADR-0002 §Consequences warns for `intake`.

## 10. Decisions owed — this ADR answers none of them

1. **#51 — where extracted text lives.** Option 1 (`body_text` write-once at capture for text-like payloads; PDFs stay null and text lives in chunks): §4's table still stands as the extraction output of record, but T-113 must read artifacts and the version's `body_text` stays null for every upload, and `supabase/seed.sql`'s `.pdf` fixture must be corrected. Option 2 (allow one `null → text` transition): a *new* migration narrows `:577`; then §4 remains the audit-grade store and the fill becomes a derived convenience written by the same fenced RPC — pgTAP gains "a second fill is refused" and "a rewrite is refused". Option 3 (extraction creates a new version): rejected on plan §7.2 grounds **and** blocked in practice by `unique (collection_id, content_hash)` (`:220`) plus the frozen `parser_generation` (`:575`); under it §4 collapses into "the version row is the artifact" and this ADR is superseded.
2. **#66 — who re-targets an extract job.** Option 1 (capture-time classification): §5 disappears and the merged pin at `040_knowledge_uploads.test.sql:406-409` changes in the same PR — but the predicate "usable text layer" cannot be evaluated there (§5's first paragraph), so this option needs the supervisor to say what approximation is acceptable. Option 2 (a re-target RPC, which §5 sketches): nothing else moves. Option 3 (queue for the box whenever the type is ambiguous): §5 is deleted, `executor` stops meaning what plan §7.2 says it means, and the §7.5 five-minute p95 target becomes a function of box uptime.
3. **#38 — how the box obtains the bytes.** The contract already promises a short-lived signed URL ([`docs/contracts/knowledge-and-jobs.md:33-34`](../contracts/knowledge-and-jobs.md)), and #38's own comment records that the user-minted, path-bound upload token could not be confirmed against current documentation. Under the proxy-the-bytes option, no RPC in this ADR changes and the job API gains one handler; under a signed-URL option, the handler returns a redirect and `job_api` still returns no URL/key/token (the payload contract forbids them, `ingestion-job.ts:13-17,24-42`); under a TUS/policy option, capture-time verification moves after the object exists, which changes T-112's quarantine model, not T-211's.
4. **#60 — function `EXECUTE` in `public`.** Option A (a hardening migration plus a generic pgTAP rule): §2's sketch is unaffected; the generic assertion should then also cover `job_api`. Option B (fold the revokes into a feature PR): explicitly not this ADR — a privilege change hidden inside a worker feature. Option C (carry it): §2 still self-revokes by name, and the hazard stays live for the identity RPC (#37) and `create_collection_v1` (#41).
5. **#68 — the `ingestion_stage_runs` sentence** in [`src/contracts/ingestion-job.ts:38`](../../src/contracts/ingestion-job.ts) and [`docs/contracts/knowledge-and-jobs.md:41-42`](../contracts/knowledge-and-jobs.md), which names a constraint the schema never had (the live one is `knowledge_core.sql:398`). Option 1 (fix the prose): §7's assertions stay as written. Option 2 (make the table real): §3–§5 need a `unique (job_id, attempt)` history **plus** a constraint keeping two lease homes consistent — the two-sources-of-truth trigger of AGENTS.md §7 — and that table, not the lease columns, becomes the fence's source. Neither option is chosen here, and `src/contracts/` is protected, so the fix is a request, not an edit (COORDINATION §2).
6. **Upstream, not this ADR's to resolve:** **T-115 b/c/d** unmerged (no provider tables, no adapters — #45); **#6** the pinned embedding index, because `index_generation` is part of both the stage key (`:398`) and §4's key, and the merged capture path derives it and refuses with `55000` when no active `corpus` row exists (`20261106100000_knowledge_uploads.sql:409-414`) — nothing here may hard-code a generation.

7. **Worker identity: how does a presented credential become `app.worker_id`?** (§3's note.) Unresolved and load-bearing. A shared role plus a self-asserted GUC means any box can claim another's identity; the options are a per-box connection identity, a verify step inside the job API, or tunnel/mTLS mapping. Nothing in this ADR picks one, and until one is picked the honest statement is that `revoked_at` bounds new leases only.
8. **Who owns dead-letter and reconciliation** (§5b)? Plan §7.5 line 406 requires both; no packet names them, and the `attempt` cap turns their absence into queue starvation. Either a state-machine change lands here, or the starvation is accepted and recorded with the packet that will fix it later.

## 10b. Amendment (2026-11-09): retry bound, inline reclaim and the dead letter ([#99](https://github.com/TerraOI/TerraOI/issues/99))

Supervisor ruling, recorded here so §3 and §5b have one answer:
- **`max_attempts = 5`**, a named constant in the job-API migration. With leases capped at 1800 s, a poisoned document holds the box for at most about 2.5 hours. The `between 1 and 100` CHECK stays as a backstop that should never fire.
- **Reclaim runs inline** in `lease_parse_job_v1`, before it selects, in the same transaction, for the tenant and stage: an expired lease under the cap returns to `queued` with the lease pair cleared and **`lease_fence` bumped**; at the cap it moves to **`failed`** with `last_error = 'retries_exhausted'`. The select then excludes capped rows.
- **Both arms stay** in every mutating compare: the fence defeats a re-leased worker, and `lease_expires_at > now()` defeats an abandoned one.
- **The dead letter is a state, never a deletion.** `failed` is final for that row; the abort RPC uses a closed reason vocabulary; replay under a new parser generation is T-405, not M1.
- **Reconciler:** a service/admin-only view in the same migration lists non-final jobs older than twice the maximum lease, `failed` jobs from the last 7 days, and versions in a non-final pipeline state with no job row.
- pgTAP in `045` covers each of these (see T-211's rulings).

## 10c. Amendment (2026-11-09b): what this PR actually built (#134, #135, #146)

This section is the rewrite §5 and §6 promised. Where a sketch above and the migration disagree, **this
section and the migration win**; the sketches stay for the review trail.

**Job API, as merged** — one migration, `20261109230000_ocr_job_leases.sql`:

- One column: `ingestion_jobs.lease_fence bigint not null default 0` with its own non-negative CHECK.
- One public table: `public.extraction_artifacts`, plus `public.extraction_artifacts_guard()` and its
  trigger (revoked by full signature, never granted back — a trigger does not need its invoker to
  hold EXECUTE, the precedent being the eight in `20261109160000_function_privileges.sql:24-40`).
- `job_api` schema (not exposed: `supabase/config.toml:13`), `job_api.worker_credentials`, and **six**
  functions instead of five: `lease_parse_job_v1`, `renew_parse_lease_v1`, `complete_parse_job_v1`,
  `abort_parse_job_v1`, `retarget_extract_job_v1`, and `object_ref_for_lease_v1` (added by #146,
  [ADR-0011](0011-object-bytes-for-the-extraction-workers.md)). No `current_worker_id()`, and no
  `app.worker_id` GUC: the digest is an argument.
- Four bounds in one place each: `job_api.max_attempts()` = 5, `job_api.max_lease_seconds()` = 1800,
  `job_api.abort_reasons()`, `job_api.retarget_reasons()`. #99 asked for a "named constant"; Postgres
  has none, and a literal `5` in two function bodies is two sources of truth.
- The reconciler of plan §7.5 is a **view**, `job_api.reconciler_findings`, with three named findings:
  `stuck_job` (non-final, older than twice `max_lease_seconds()`), `recent_failure` (`failed` or
  `cancelled` in 7 days), `missing_job` (a version in a live pipeline state with no job row). Granted
  to nobody — not to a request role, not to `service_role`, not to `toi_job_api`.
- Role `toi_job_api` (`NOLOGIN`, created idempotently the way `inquiry_writer` is at
  `20261105080000_pilot_inquiries.sql:9-15`), `usage` on `job_api`, `execute` on the six functions by
  name, **no table grant**. `scripts/worker-credential.mjs` issues a token and stores only its
  SHA-256 digest.
- `service_role` is revoked on `ingestion_jobs` and on every table the migration adds, because #146
  puts a service-role key on the `workers/` deployment and that key must not be able to write the
  pipeline through the Data API.

**The compare, in every mutating function** (#134's ruling, not a separate gate):

```sql
   where j.id = p_job_id
     and j.lease_token = p_lease_token and j.lease_fence = p_fence
     and j.status in ('leased','running') and j.lease_expires_at > now()
     and exists (select 1 from job_api.worker_credentials c
                  where c.token_hash = p_token_hash and c.revoked_at is null
                    and c.executor = j.executor
                    and j.organisation_id = any (c.organisations))
```

- `attempt` arithmetic, so "#99: `max_attempts = 5`" means five leases and not four: a row may be
  leased while `attempt <= max_attempts`, and the sweep dead-letters it when its lease expires with
  `attempt > max_attempts`. The reclaim/cap group in pgTAP `045` pins both arms and the exclusion.
- `lease_parse_job_v1` runs the reclaim **first**, in the same transaction, scoped to the credential's
  tenants **and the credential's executor**, then selects. `for update skip locked` follows `limit 1` —
  Postgres rejects the other order, which the sketch in §3 had backwards.
- `complete_parse_job_v1` re-checks `p_source_version_id`, `p_stage` and `p_index_generation` against
  the job row and refuses a mismatch with the same `42501` a foreign row gets, so a replayed message
  cannot write a generation that never ran; it copies the generations, the class and the producer from
  the **job row and the credential**, never from the caller.
- `retarget_extract_job_v1` belongs to the **cloud worker on its own leased job** (#134), one-way to
  `local_box`, back to `queued`, lease pair cleared together, `lease_fence` bumped. A `local_box`
  credential is refused by the executor arm, so the box never retargets. §5's `status = 'queued'` arm
  is gone; what makes it safe is the same thing §5 warned about — the fence bump — which #99 established
  for the sweep and this repeats for retarget.
- `job_api.executor_clears_class(executor, class)` holds the one **stated interim**: `local_box` clears
  every class M1 ingests; `cloud_worker` does **not** clear `client_confidential`, because §12.4's
  default matrix as merged lists `local_box, claude` for that class
  ([`src/contracts/provider-route.ts:81`](../../src/contracts/provider-route.ts)) and
  [ADR-0007:14](0007-e1-embedding-clearance.md) widened that matrix for embeddings only. Nothing in
  this ADR or this migration widens it for extraction; if the supervisor rules that extraction inside
  our own bounded worker clears it, that one arm and the clearance assertions in pgTAP `045` change together, in a new
  migration.

**Threat-model paragraph the §8 list still needs.** Three things are true at once, and the review should
see all three rather than one:

1. A leaked `JOB_DB` credential can call six functions and nothing else — no table grant, no view, no
   sequence, and the privilege and search-path assertions in `045` prove it, and the member-path assertion in `045` shows the reconciler is unreachable over SQL, while `001` test 33 now names `job_api` so a future
   grant is a review decision.
2. The stored **digest is a capability**: whoever presents a matching value *is* that worker, for the
   tenants and the single executor that row names. `worker_credentials` is therefore owner-only — not
   readable by `toi_job_api` either — and rotation is a human step. A digest cannot be reversed into a
   token, so a read of that table is a credential leak rather than a credential forgery; both are
   covered by the same absence of privileges.
3. The **service-role key** ADR-0011 introduces is the widest credential in the system after the
   dashboard. The migration removes its SQL reach; the import-boundary test (T-211 PR-2) keeps its
   minting inside `workers/`; and what is *not* closed by either — that the key could sign a URL for an
   object whose key an attacker already knows — is named in ADR-0011 Consequences as a Storage-side
   follow-up, not papered over here.

## 11. Alternatives considered

- **Machine membership instead of worker grants** (§3): rejected in the sketch, not by ruling — it widens a leaked credential to the full `authenticated` read surface and puts a non-person in provenance columns.
- **Lease state in a new table instead of on the job row:** two sources of truth alongside `:374-375,392-393`; this ADR keeps one home and adds only the fence.
- **`attempt` as the fencing token:** capped at 100 (`:373`) and outside the idempotency key by contract, so it cannot be both bookkeeping and a monotonic guard.
- **Clock-based lease expiry as the authority:** accepts a partitioned worker's late write whenever nobody has re-leased yet — the exact failure the packet asks to test.
- **`INSERT` a second job row for the box instead of updating:** silently discarded by the capture path's `on conflict … do nothing` against a key that excludes `executor` (`:398`, `20261106100000_knowledge_uploads.sql:470-478`) — the failure mode is a scanned PDF that quietly never reaches a box.
- **Artifacts inside `source_versions.payload`:** the column is frozen (`:576`) and has no per-locator granularity.
- **Writing `knowledge_chunks` from the extractor:** no write path exists for any request role (`:884-894`), and it would decide chunk boundaries that T-113 owns.

## Consequences

- Landing this design adds, in **one** migration (`20261109230000_ocr_job_leases.sql`, as built — see §10c): one column (`ingestion_jobs.lease_fence`), one public table (`public.extraction_artifacts`) with its guard function and trigger, one schema (`job_api`), one small credential table (`job_api.worker_credentials`), six functions (`lease`/`renew`/`complete`/`abort`/`retarget_extract_job_v1`/`object_ref_for_lease_v1`) plus four bound helpers (`max_attempts`, `max_lease_seconds`, `abort_reasons`, `retarget_reasons`) and one clearance helper, one reconciler **view** (`job_api.reconciler_findings`, granted to nobody), and one role (`toi_job_api`, `NOLOGIN`, `usage` + `execute` by name, **no table grants**). The packet's "its own job and artifact views" is satisfied by the RPC result shapes rather than by granted views: `045`'s privilege group proves the worker role selects no table at all, which is a narrower reading than literal views and the one this PR ships — if the supervisor wants the literal views, that is a new migration and a new pair of grants, not a change to any signature.
- Migration mechanics are fixed by the repo, not by taste: the newest merged file is `20261106100000_knowledge_uploads.sql`, and a new migration's timestamp must be later than the newest on main, merged files are never edited, and a PR may add exactly one migration ([`scripts/migrations.mjs:22-24,33-37`](../../scripts/migrations.mjs)). The in-flight session migration (#77) will raise that floor before this PR is reviewable, so the filename is fixed at claim time in the daily sync (COORDINATION §3).
- **Recommended landing order: answer #51 and #66 first.** One migration cannot carry two undecided designs: #51 decides whether §4's table exists at all, and #66 decides whether §5 exists. Then implement in this order, test-first: artifact table + guard + RLS; fence + lease/renew; complete; retarget; abort/revocation.
- If the supervisor chooses #68 option 2, §3–§5 keep their signatures and gain a history table; if #66 option 1 wins, §5 is deleted and a merged pgTAP assertion changes in the same PR; if #51 option 2 wins, §4 remains and the fill is added on top. No other combination rewrites this ADR.
- Until #75 is answered, the entire worker surface is unreachable from any running environment, and the honest interim state — as with `upload-adapters.ts:19-21` on the storage side — is a typed unavailable refusal, not a key.
