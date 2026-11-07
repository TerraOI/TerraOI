# ADR-0005 OCR job API, lease fencing, and the artifact home (T-211 prerequisite)

Status: **proposed / blocked on [#51](https://github.com/TerraOI/TerraOI/issues/51), [#66](https://github.com/TerraOI/TerraOI/issues/66), [#75](https://github.com/TerraOI/TerraOI/issues/75), [#38](https://github.com/TerraOI/TerraOI/issues/38)** — not accepted, decides nothing on its own; also touches [#60](https://github.com/TerraOI/TerraOI/issues/60), [#68](https://github.com/TerraOI/TerraOI/issues/68) and #6 · Date: 2026-11-07 · Deciders: supervisor (job API, worker role, artifact home), Lane 2 (extractor inputs)
Plan refs: §7.2 (extraction executors, line 386; steps 2–3), §7.5 (line 406), §13 (lines 824, 826–831), §16 (ingestion row, line 945), §20.8 (human steps); F12, F32

This is the **T-211 design written as a proposal**, not a claim on T-211 (T-115 b/c/d are unmerged) and not an answer to any open question. Every SQL block below is a sketch inside this ADR: no file under `supabase/migrations/` is written, because the timestamp is the daily sync's to claim ([COORDINATION.md §3](../COORDINATION.md)) and one migration may not encode two undecided designs. [T-211](../tasks/T-211-ocr-worker.md) is the packet that would implement it.

## 1. Context: two facts the whole design rests on

**Fact 1 — the lease surface already exists and has no writer.** `ingestion_jobs` carries `attempt` 1..100 ([`20261105070000_knowledge_core.sql:373`](../../supabase/migrations/20261105070000_knowledge_core.sql)), `lease_token` (8..128 chars, `:374`), `lease_expires_at` (`:375`), the constraint binding them as a pair `ingestion_jobs_lease_pair` (`:392-393`), `ingestion_jobs_local_box_runs_only_extract` (`:390-391`), the data-class CHECKs (`:385-388`) and the stage idempotency key `unique (organisation_id, source_version_id, stage, parser_generation, index_generation)` (`:398`). `git grep -n -I "update public.ingestion_jobs" -- supabase` at `467f169` returns **nothing**, and the grants are `revoke all` then `grant select` (`:884-894`), so today no role can lease, renew, complete or abort anything. T-211's "one migration … for lease/claim columns" (`docs/tasks/T-211-ocr-worker.md:15-17`) is therefore **not** about columns — they are there; the migration is about the write surface, one new fence column, and the artifact home.

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

- **The default in `public` is open, and #60 proves it bites.** `knowledge_core.sql` creates 15 functions in `public` and grants execute on 7 (`:903-911`); PostgreSQL's default `EXECUTE` to `PUBLIC` leaves the other 8 callable by `anon` through `/rpc`. The intake migration revokes **per function** ([`20261105080000_pilot_inquiries.sql:70-73,89`](../../supabase/migrations/20261105080000_pilot_inquiries.sql)), T-112 does the same by name ([`20261106100000_knowledge_uploads.sql:601-612`](../../supabase/migrations/20261106100000_knowledge_uploads.sql)), and [`20261105210000_intake_service_role.sql:10-11`](../../supabase/migrations/20261105210000_intake_service_role.sql) writes the obligation down: *"each later migration revokes its own new functions"*. A job RPC in `public` would be the first function in that schema whose arguments are **job ids and lease tokens**.
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
     and j.data_class <> 'restricted'                        -- :385-388, mirrored from §12.4
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
```

A re-lease incremented `lease_fence`, so the dead worker's statement matches **zero rows** regardless of what its clock says. `attempt` is deliberately **not** the fence: it is capped at 100 (`:373`) and the contract keeps it outside the idempotency key on purpose ([`src/contracts/ingestion-job.ts:35-39`](../../src/contracts/ingestion-job.ts)), so it must stay bookkeeping.

`renew_parse_lease_v1(p_job_id, p_lease_token, p_fence, p_lease_seconds)` uses the same compare and touches only `lease_expires_at`; a zero-row match is a named refusal (`42501`), never a silent no-op — a worker that believes it still holds a lease must find out immediately.

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
```

- **Class:** `data_class` is the highest among the artifact's inputs (AGENTS.md §4.4, [`maxDataClass`](../../src/contracts/data-class.ts)), enforced by a guard shaped exactly like `knowledge_chunks_guard()` (`knowledge_core.sql:661-696`): below the parent version's class → `23514`; a raise is allowed, a lowering never. The `…_ingestible_in_m1` CHECK makes a `restricted` artifact unwritable, matching the contract cut ([`src/contracts/provider-route.ts:172-175`](../../src/contracts/provider-route.ts)).
- **RLS:** a policy in the shape of `knowledge_chunks_scoped_read` (`:833-838`) — `is_active_member(organisation_id) and organisation_id = public.current_organisation_id() and public.source_version_is_readable(source_version_id)`. AGENTS.md §4.2's three negatives are all provable here: another tenant (composite FK → `23503`, the mechanism at `:263-265`); another project (`collection_is_readable`'s project arm, `:442`); a deactivated member (`is_active_member` filters `status = 'active'`, `tenancy_core.sql:184`).
- **The collision this dissolves.** Content dedup is `unique (collection_id, content_hash)` (`:220`). Under #51's option 3 (an extraction creates a new version), re-running a parser over the same bytes for the same collection is a unique violation, and re-parsing with a new `parser_generation` is impossible anyway because that column is frozen (`:575`). With artifacts keyed by `(version, stage, parser_generation, index_generation, artifact_index)`, a re-parse writes a **second artifact set against the same immutable version**: no new version row, so `:220` is never touched, and the plan's line that a correction — not an extraction run — creates a new version (§7.2) keeps its meaning.
- `knowledge_chunks` stays T-113's table, fed *from* artifacts. This ADR writes no chunk and no `body_text`.

`complete_parse_job_v1(p_job_id, p_lease_token, p_fence, p_artifacts jsonb, p_notes jsonb, p_ocr_confidence numeric)` in one transaction: re-read the job row `for update` and check it belongs to a tenant this credential serves (identical `42501` for foreign and unknown, the capture-path idiom at `20261106100000_knowledge_uploads.sql:368-372`); re-read the parent version's `state` and refuse `revoked / deleting / deleted` (the same filter as `source_version_is_readable`, `knowledge_core.sql:471`); flip `status='succeeded'` **only** under the fence compare; insert the artifact rows; append exactly one `outbox_events` row (`event_type`/`aggregate_type` shapes per `:409-411`). If the compare matches zero rows and the status is already `succeeded`, return `already_completed` **after writing nothing** — that is what makes a duplicate delivery a no-op instead of a second artifact set. `abort_parse_job_v1(p_job_id, p_lease_token, p_fence, p_reason_code)` sets `status='cancelled'`, clears the lease pair together (`:392-393`), writes a safe code into `last_error` (1..500 chars, `:376`), and deletes that job's unfenced artifacts.

## 5. Decision 4 — `retarget_extract_job_v1` is a one-way door (#66)

Capture cannot make this decision: `sniffSignature` types bytes by signature alone ([`src/platform/knowledge/object-validator.ts:65-87`](../../src/platform/knowledge/object-validator.ts)), while the plan's predicate is "digital PDFs **with a usable text layer**" (§7.2 line 386) — "usable" is only knowable after a parse, and the parse budget (`DEFAULT_EXTRACTION_LIMITS.maxDecompressedBytes`, `pdf-text-extract.ts:41-45`) is not the capture budget (`object-validator.ts:30-32`).

And the merged schema forbids the easy fix: `:398` does not include `executor`, and capture enqueues with `on conflict (…stage key…) do nothing` (`20261106100000_knowledge_uploads.sql:470-478`) — inserting a second row for the box is **silently discarded**, producing a scanned PDF with a cloud row and no visible failure. Re-targeting is necessarily an UPDATE of the existing row.

```sql
-- SKETCH ONLY. Blocked on #66. Note: executor can only ever move cloud_worker -> local_box.
create function job_api.retarget_extract_job_v1(p_job_id uuid, p_reason_code text)
returns table (o_outcome text, o_executor text, o_status text)
language plpgsql security definer set search_path = job_api, public, pg_temp as $$
begin
  if p_reason_code is null or p_reason_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'reason must be a safe code' using errcode = '22023';
  end if;
  update public.ingestion_jobs
     set executor = 'local_box', status = 'queued', last_error = p_reason_code
   where id = p_job_id
     and stage = 'extract'                                   -- :390-391, belt-and-braces
     and executor = 'cloud_worker'                           -- the one-way door
     and status = 'queued'                                   -- never leased/running/succeeded/failed
     and data_class <> 'restricted'                          -- :385-388
     and organisation_id = any (select w.organisations from job_api.worker_credentials w
                                where w.id = job_api.current_worker_id() and w.revoked_at is null)
   returning executor, status into o_executor, o_status;
  if not found then
    o_outcome := 'refused'; return next; return;             -- row may or may not exist: same answer
  end if;
  o_outcome := 'retargeted'; return next;
end; $$;
```

The caller chain is T-212's pure routing decision (§7.2 line 386; the quality result is `extractPdfTextLayer`'s `outcome`) → the job API → this RPC. T-212 writes nothing to `ingestion_jobs` — that is exactly the blocker recorded on #66. The race is stated rather than hidden: if the cloud worker already leased the row, the guard refuses and the box waits for the next attempt; correspondingly, a cloud completion for a row whose `executor` is `local_box` must be refused by the executor match.

**"Queued for OCR" (plan §7.2 line 386) is not a status value.** The CHECK at `:362-363` offers only `queued/leased/running/succeeded/failed/cancelled`. **Option A:** derive the visible state from `executor = 'local_box' and status in ('queued','leased')` — no schema change, and the state stays a projection. **Option B:** a new migration replaces that CHECK with an added value — one more constraint change on a merged table, and the merged assertion that pins `'extract/cloud_worker/queued'` at capture ([`supabase/tests/database/040_knowledge_uploads.test.sql:406-409`](../../supabase/tests/database/040_knowledge_uploads.test.sql)) must be updated **in the same PR** if routing ever moves to capture time. The sketch is neutral: it changes only the projection, and pgTAP group 8 asserts whichever pair is chosen.

## 6. Decision 5 — the worker's credential and the Postgres path

The box authenticates **outbound to the job API**, never to Postgres (§7.2 line 386; §13 line 829). The job API is a Worker under `src/app/api/jobs/` — a Lane 2 route folder that does not exist yet, protected in CODEOWNERS ([FAQ-0005](../FAQ.md)). The role question is therefore "who does the job API connect as", and it is the same fork #75 is open on for sessions:

1. **Hyperdrive + a dedicated NOLOGIN role**, the ADR-0002 precedent ([`docs/decisions/0002-pilot-inquiry-intake.md:22-25`](0002-pilot-inquiry-intake.md)): a login user `IN ROLE inquiry_writer`, the `INQUIRY_DB` binding, and the containment statement "a leaked Hyperdrive credential can insert inquiries, within the CHECK limits, and do nothing else". Analogue here: role `terraoi_job_writer` (NOLOGIN), `usage` on `job_api`, `execute` on the five functions **by name**, **no table grant at all**. `wrangler.jsonc` today records one Hyperdrive binding, added to `env.staging` by the owner as a human step ([`wrangler.jsonc:12-14`](../../wrangler.jsonc)).
2. **The Data API with a token** — unavailable: there is no employee token here, and only `public`/`graphql_public` are exposed (`supabase/config.toml:13`).
3. **`service_role`** — permitted only in a documented server path with an ADR (AGENTS.md §4.2), and it bypasses RLS on every tenant table. Not sketched here.

This ADR does not choose; §2–§5 are written so that the answer changes only the **connection target**, never a signature or a guard.

## 7. Decision 6 — pgTAP slot `045_ingestion_jobs.test.sql`, and `plan(80)`

- The packet names `040_ingestion_jobs.test.sql` (`docs/tasks/T-211-ocr-worker.md:18,36`), but **040 is merged**: [`supabase/tests/database/040_knowledge_uploads.test.sql`](../../supabase/tests/database/040_knowledge_uploads.test.sql) is 652 lines with `select plan(63)` (`:18`), and merged test files are never renamed (COORDINATION §3).
- `050` is **already promised** to T-213 ([`docs/tasks/T-213-review-publish-revoke.md:19`](../tasks/T-213-review-publish-revoke.md)), and the session train has taken `014`. So `045` is the only slot that is both adjacent to the knowledge/job suites and unclaimed.
- Order is safe: `supabase test db` is the last database gate in CI ([`.github/workflows/ci.yml:56`](../../.github/workflows/ci.yml)) and runs the directory in file-name order, while every file is its own `begin; … rollback;` transaction (`040…sql:15`, [`000_guardrails.test.sql:3,31`](../../supabase/tests/database/000_guardrails.test.sql)). A `045` between `040` and `050` cannot change what another file sees.
- `select plan(80)` is the sum of: schema/privilege shape **12** (schema not exposed; five functions exist; `has_function_privilege` false for `anon`/`authenticated`/`service_role` and true only for `terraoi_job_writer`; new table RLS enabled; composite `(id, organisation_id)` present), lease **6**, lease isolation **8**, renew **6**, complete and its writes **9**, fencing **7**, idempotency and ordering **7**, retarget guards **8**, artifacts **9** (the three RLS negatives + class guard + `restricted` refusal + cross-tenant FK `23503`), abort/revocation/offline **8**.
- `plan(N)` must equal the number of assertions actually executed or pgTAP fails the run, so the number and the group list move together in one commit. Assertions are never dropped to make a run green (AGENTS.md §6).
- Two corrections this ADR makes rather than repeating: at `467f169` there is **no** `999_violation_probe.test.sql` in the suite, and "the next free pgTAP file is 050" is wrong for the reason above.

## 8. Threat model

- **A leaked worker credential can** lease one extract job at a time within the tenants named in its `worker_credentials.organisations` array, renew its own lease, complete it with an artifact set, and abort it. That is the whole point of the design and it is bounded: no table grant exists, so a direct `select` on `source_versions`, `knowledge_chunks`, `profiles` or anything else is a privilege error; the five functions are unreachable from HTTP (§2); the credential digest, not the token, is stored.
- **A leaked worker credential cannot** read another tenant's queue, change a job's tenant, stage or data class, move `local_box` back to `cloud_worker` (§5's door), write a chunk or a vector, alter a `source_version`, or learn that any job exists outside its tenants. `revoked_at` on the credential row stops all of it in one statement, and rotation is a §20.8 human step.
- **Another tenant's job id gives no existence signal.** Lease returns `o_found = false` — the identical answer to "no work" — and complete/renew/abort raise one indistinguishable `42501` for foreign, unknown and already-gone rows, the same discipline the merged capture RPC states at `20261106100000_knowledge_uploads.sql:368-372` and #13(2) required.
- **A stale lease cannot write.** The fence is monotonic per job and is carried by the caller; the mutation is `where lease_token = $1 and lease_fence = $2 and status in ('leased','running')`. After a re-lease the fence has moved, so the old worker's write matches zero rows and the RPC refuses instead of inserting artifacts. Timestamps cannot do this: the expired worker is the only one whose token still matches until somebody re-leases, and `updated_at` (`:799`) cannot tell a re-lease from an unrelated update.
- **Third-party OCR is unreachable three independent ways.** (1) No function sets `executor` to `cloud_worker` for stage `extract` — §5 is one-way. (2) Any "send the scan to a cloud OCR provider" call would be a model route, and route selection drops providers the data class does not clear (`RouteSkipReason "not_cleared"`, [`src/platform/gateway/route.ts:74,146,160`](../../src/platform/gateway/route.ts)), with `client_confidential` cleared by default only to `local_box, claude` ([`src/contracts/provider-route.ts:81`](../../src/contracts/provider-route.ts)) and `restricted` un-ingestible (`:172-175`). (3) There is no OCR adapter, and no `model_providers`/`provider_routes` tables exist yet (#45; T-115 b/c/d unmerged).
- **Untrusted content stays content.** The extractor is an observer, never an interpreter (`pdf-text-extract.ts:14-30`, `pdf-format.ts:1-11`); artifact `notes` and `locator` values are stored as data with shape CHECKs, and nothing in this design evaluates text found inside a document (AGENTS.md §4.8).

## 9. Human steps (plan §20.8) — all blocked on #75

None of these may be done by an agent or a builder, and none is a repository secret. **Until #75 decides the mechanism, none of §3–§5 is reachable at all**, so T-211's staging evidence — "upload a synthetic scanned PDF for company1 and show the lease/complete sequence, then upload on the company2 host and show its job is invisible to company1's worker credential" (`docs/tasks/T-211-ocr-worker.md:52-54`) — is unproducible, and CI's pgTAP is the only authority (§7).

1. Create the NOLOGIN role (`terraoi_job_writer` in the §6-1 sketch) and a login user `IN ROLE` it, with a generated password held only in the password manager.
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

## 11. Alternatives considered

- **Machine membership instead of worker grants** (§3): rejected in the sketch, not by ruling — it widens a leaked credential to the full `authenticated` read surface and puts a non-person in provenance columns.
- **Lease state in a new table instead of on the job row:** two sources of truth alongside `:374-375,392-393`; this ADR keeps one home and adds only the fence.
- **`attempt` as the fencing token:** capped at 100 (`:373`) and outside the idempotency key by contract, so it cannot be both bookkeeping and a monotonic guard.
- **Clock-based lease expiry as the authority:** accepts a partitioned worker's late write whenever nobody has re-leased yet — the exact failure the packet asks to test.
- **`INSERT` a second job row for the box instead of updating:** silently discarded by the capture path's `on conflict … do nothing` against a key that excludes `executor` (`:398`, `20261106100000_knowledge_uploads.sql:470-478`) — the failure mode is a scanned PDF that quietly never reaches a box.
- **Artifacts inside `source_versions.payload`:** the column is frozen (`:576`) and has no per-locator granularity.
- **Writing `knowledge_chunks` from the extractor:** no write path exists for any request role (`:884-894`), and it would decide chunk boundaries that T-113 owns.

## Consequences

- Landing this design adds, in **one** migration: one column (`ingestion_jobs.lease_fence`), one table (`public.extraction_artifacts`), five functions (`lease`/`renew`/`complete`/`abort` in `job_api`, plus `retarget_extract_job_v1`), one role (`terraoi_job_writer`, NOLOGIN, no table grants), one small credential table (`job_api.worker_credentials`) and **two optional views** (`job_api.worker_job_view`, `job_api.worker_artifact_view`) if the packet's "its own job and artifact views" is to be granted literally rather than as RPC-only access.
- Migration mechanics are fixed by the repo, not by taste: the newest merged file is `20261106100000_knowledge_uploads.sql`, and a new migration's timestamp must be later than the newest on main, merged files are never edited, and a PR may add exactly one migration ([`scripts/migrations.mjs:22-24,33-37`](../../scripts/migrations.mjs)). The in-flight session migration (#77) will raise that floor before this PR is reviewable, so the filename is fixed at claim time in the daily sync (COORDINATION §3).
- **Recommended landing order: answer #51 and #66 first.** One migration cannot carry two undecided designs: #51 decides whether §4's table exists at all, and #66 decides whether §5 exists. Then implement in this order, test-first: artifact table + guard + RLS; fence + lease/renew; complete; retarget; abort/revocation.
- If the supervisor chooses #68 option 2, §3–§5 keep their signatures and gain a history table; if #66 option 1 wins, §5 is deleted and a merged pgTAP assertion changes in the same PR; if #51 option 2 wins, §4 remains and the fill is added on top. No other combination rewrites this ADR.
- Until #75 is answered, the entire worker surface is unreachable from any running environment, and the honest interim state — as with `upload-adapters.ts:19-21` on the storage side — is a typed unavailable refusal, not a key.
