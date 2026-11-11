# T-211 Local-box OCR pull worker and job API (F32)

Lane: 2 · Week: 2 · Protected: yes (`workers/`, `localbox/`, `supabase/migrations/`, `src/app/api/jobs/`) · Depends on: T-111 (merged as #12), T-112 (merged as #32 + #54), T-115 (a–d on `main`, see its packet) · Status: ready — design in [ADR-0005](../decisions/0005-ocr-job-api-and-artifact-home.md) (proposed)
Plan refs: §7.2 (extraction executors), §13 (local box in the topology), §7.5, §16 (Forms/OCR row); F12, F32

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Dead letter and reclaim** ([#99](https://github.com/TerraOI/TerraOI/issues/99), ADR-0005 §12): `max_attempts = 5`; `lease_parse_job_v1` first reclaims expired leases for the tenant and stage (under the cap → `queued`, lease pair cleared, `lease_fence` bumped; at the cap → `failed`, `last_error = 'retries_exhausted'`), then excludes capped rows; the mutating compare keeps the `lease_expires_at > now()` arm too; abort uses a closed reason vocabulary; a service/admin-only reconciler view lists stuck jobs, recent failures and versions with no job; the outbox dispatcher relies on the stage key.
- **Job API shape** ([#134](https://github.com/TerraOI/TerraOI/issues/134)): role `toi_job_api` (`NOLOGIN`, over `JOB_DB`), `USAGE` on `job_api` and `EXECUTE` by name on the five functions, no table grants; every function takes the presented worker token's hash and joins `worker_credentials … and revoked_at is null` in the same compare as tenant, version, stage, lease token and fence. One credential per executor. Ships the reviewed owner script that issues a token and stores only its hash. ADR-0005 moves to **accepted** in this PR, §5 and §6 rewritten to match, with the threat-model paragraph.
- **Retarget is the cloud worker's** ([#134](https://github.com/TerraOI/TerraOI/issues/134)): `retarget_extract_job_v1` is allowed on the caller's own leased `extract` job with a valid fence, `cloud_worker → local_box` only; it moves the job to `queued`, clears the lease pair and bumps `lease_fence`. The box never retargets.
- **Cloud executor** ([#135](https://github.com/TerraOI/TerraOI/issues/135)): the lease guard is `j.executor = <the credential's executor>` (a box never leases a cloud job, nor the reverse); `complete_parse_job_v1` writes `extraction_artifacts` with `producer` = the credential's executor. This packet owns the cloud executor loop in `workers/`: lease, read bytes, call T-212's extractor and mapper, complete or retarget. Bytes are read through the `ObjectStore` port with a fake in tests until [#146](https://github.com/TerraOI/TerraOI/issues/146) is ruled; no credential, key or bucket is chosen in this PR.
- **Object bytes** ([#146](https://github.com/TerraOI/TerraOI/issues/146), ADR-0011 in this PR): a service-role key, held as a `wrangler secret` on the `workers/` deployment only, used for one call: `createSignedUrl(bucket, key, 60)` on the leased job's object. The key comes from a new `job_api.object_ref_for_lease_v1(token_hash, job_id, lease_token, fence)` (same compare as the other job-API functions, `toi_job_api` only), never from request input. The URL is returned once and never stored or logged; it is minted only for an executor the version's class clears (ADR-0005 §8). Tests: an import-boundary test fails if anything outside `workers/` references the signing module; pgTAP `045` shows another tenant's job, an expired lease, a stale fence and a revoked credential return no row. This supersedes the "fake until #146" line above.
- **Byte-path policy** ([#152](https://github.com/TerraOI/TerraOI/issues/152), ADR-0011 amendment): which executor may read object bytes and write artifacts is its own policy, not the §12.4 model matrix. Both `cloud_worker` and `local_box` clear `public`, `internal` and `client_confidential`; `restricted` is never ingested; no third-party OCR route exists in M1. `job_api.executor_clears_class` encodes it, and `045` asserts both executors clear `client_confidential`, neither clears `restricted`, and an unknown executor clears nothing.
- **Deployment** ([#152](https://github.com/TerraOI/TerraOI/issues/152)): `workers/` is a separate Worker deployment with its own wrangler config and the only home of the service-role key. The app Worker's `src/app/api/jobs/` routes (FAQ-0005) reach the signing code only through a Cloudflare service binding; the `workers/` Worker exposes no public signing route.
- **pgTAP `045` also adds** (#134, #135): `toi_job_api` selects no table and has no privilege in `public`; a revoked credential's renew and complete match zero rows; a box credential cannot lease another tenant's job or a `cloud_worker` job, nor a cloud credential a `local_box` job; retarget works only on the caller's own leased `extract` job; the abandoned holder's renew matches zero rows after reclaim. `001` test 33 extends to "no request role reaches `job_api`".
- **pgTAP `045` adds:** cap → `failed` and the next job leases; expired lease reclaimed and the old worker's completion matches zero rows; abandoned lease refused by the expiry arm; duplicate dispatch creates no job; the reconciler lists a stuck job and a job-less version; no request role reads it.

## Goal
A scanned PDF or image becomes text: the box runs **no inbound listener**, it polls a narrow job API
with a scoped worker credential, leases one job, pulls the object through a short-lived signed URL,
returns an artifact with page and table locators, and releases the lease — while the platform rechecks
tenant, version, stage and lease on every call and stops the job the moment its source is revoked.

## Owns (may edit)
- `workers/` (outbox dispatcher, job API handlers, lease wiring), `localbox/` (pull worker, runbook
  notes, no secrets)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_ocr_job_leases.sql` for the worker-facing RPCs,
  their grants, one monotonic lease-fence column, the `extraction_artifacts` table (#51) and
  `retarget_extract_job_v1` (#66). The lease columns themselves are already merged
  (`20261105070000_knowledge_core.sql:373-375,392-393`). Timestamp agreed in the daily sync;
  migrations are protected and merged migrations are never edited
- `supabase/tests/database/045_ingestion_jobs.test.sql` (`040` is merged as `040_knowledge_uploads`;
  `050` is T-213's), `workers/*.test.ts`, `localbox/*.test.ts`
- `src/app/api/jobs/` — Lane 2 owns these route folders ([FAQ-0005](../../docs/FAQ.md)), so the job API
  is implemented here directly: no re-export from Lane 1 and no `cross-lane` label

## Must not edit
`src/contracts/`, merged migrations, `src/platform/gateway/` (the box's inference endpoint is the
gateway's business, T-115), `src/platform/chat/`, `brand/`

## Contract
[`IngestionJobPayload`, `IngestionStage`, `JobExecutor`](../../src/contracts/ingestion-job.ts) —
`executor: local_box` is valid only for stage `extract`, and `restricted` is never enqueued
(`isIngestibleInM1`). New RPCs `lease_parse_job_v1`, `renew_parse_lease_v1`,
`complete_parse_job_v1`, `abort_parse_job_v1`, each re-reading the authoritative job row and never
trusting a caller-supplied tenant. They cannot use `set_tenant_scope(uuid)`: it requires an employee
session (`20261105060000_tenancy_core.sql:206-216`) and the box has none (plan §13). Their schema,
role and worker-identity mechanism are ADR-0005 §2, §6 and §10-7; the identity question is still
open, so settle it with the supervisor before the migration is written. Rules:
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md).

Rulings that bind this packet (2026-11-08):
- **[#51](https://github.com/TerraOI/TerraOI/issues/51):** `source_versions.body_text` stays immutable and is
  `null` for PDFs, scans and images. `complete_parse_job_v1` writes extracted text and page locators to
  `extraction_artifacts`, keyed by `(source_version_id, parser_generation)` as ADR-0005 §4 sketches,
  with its own `revoke … from anon, authenticated, service_role`. A re-parse writes a new artifact set,
  never a new version.
- **[#66](https://github.com/TerraOI/TerraOI/issues/66):** this packet adds `retarget_extract_job_v1`. It moves
  only stage `extract`, only `cloud_worker → local_box`, called by the cloud worker on **its own leased** job
  with a valid fence; it moves the job to `queued`, clears the lease pair and bumps `lease_fence`
  ([#134](https://github.com/TerraOI/TerraOI/issues/134)).
  T-212 supplies the routing decision and writes nothing to `ingestion_jobs`; capture keeps queueing
  `extract`/`cloud_worker` by default.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/045_ingestion_jobs.test.sql` — one job is leased at a time with
      `leaseToken` and expiry recorded, and `complete_parse_job_v1` stores the artifact and releases
      the lease exactly once
- [ ] positive: `workers/ocr-pull.test.ts` — the worker binds no port, authenticates outbound, and gets
      a **short-lived** object URL from the API rather than a key or token inside the payload
- [ ] negative: a job id belonging to another tenant returns no row (no existence signal), and the
      worker role can select no table other than its own job and artifact views
- [ ] negative: another worker's lease cannot be renewed or completed with a different `leaseToken`, and
      a completion naming the wrong stage or a superseded `indexGeneration` is refused
- [ ] failure: lease expiry makes the job claimable again and the old worker's late completion is
      discarded; the same completion delivered twice is a no-op (one artifact set, one outbox event)
- [ ] failure: the source is revoked mid-job → the next worker call aborts, the queued artifact is
      deleted and no chunk is written; box offline → the version waits in `extracting` as "queued for
      OCR" and is **never** re-routed to a third-party OCR service
- [ ] negative (#66, #134): `retarget_extract_job_v1` refuses another tenant's job, a job leased by another
      credential or with a stale fence, a non-`extract` stage and any target other than `local_box`

## Done evidence
`pnpm db:test`, `pnpm verify`; staging through the staging tunnel: upload a synthetic scanned PDF for
company1 and show the lease/complete sequence with artifact locators, then upload on the company2 host
and show its job is invisible to company1's worker credential. Credentials live in `wrangler secret`
and the password manager ([T-004](./T-004-infrastructure.md)), never in this repo.

## Out of scope
Connector sync workers, DOCX/XLSX cloud extraction (T-212), review and publish (T-213), dead-letter and
reconciler dashboards (T-405), ingestion budgets and quotas (T-313).
