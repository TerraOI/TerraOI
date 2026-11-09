# T-211 Local-box OCR pull worker and job API (F32)

Lane: 2 · Week: 2 · Protected: yes (`workers/`, `localbox/`, `supabase/migrations/`, `src/app/api/jobs/`) · Depends on: T-111 (merged as #12), T-112 (merged as #32 + #54), T-115 (a–d on `main`, see its packet) · Status: ready — design in [ADR-0005](../decisions/0005-ocr-job-api-and-artifact-home.md) (proposed)
Plan refs: §7.2 (extraction executors), §13 (local box in the topology), §7.5, §16 (Forms/OCR row); F12, F32

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Dead letter and reclaim** ([#99](https://github.com/TerraOI/TerraOI/issues/99), ADR-0005 §12): `max_attempts = 5`; `lease_parse_job_v1` first reclaims expired leases for the tenant and stage (under the cap → `queued`, lease pair cleared, `lease_fence` bumped; at the cap → `failed`, `last_error = 'retries_exhausted'`), then excludes capped rows; the mutating compare keeps the `lease_expires_at > now()` arm too; abort uses a closed reason vocabulary; a service/admin-only reconciler view lists stuck jobs, recent failures and versions with no job; the outbox dispatcher relies on the stage key.
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
  only stage `extract`, only `cloud_worker → local_box`, only while `queued` (never once leased).
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
- [ ] negative (#66): `retarget_extract_job_v1` refuses another tenant's job, an already-leased job, a
      non-`extract` stage and any target other than `local_box`

## Done evidence
`pnpm db:test`, `pnpm verify`; staging through the staging tunnel: upload a synthetic scanned PDF for
company1 and show the lease/complete sequence with artifact locators, then upload on the company2 host
and show its job is invisible to company1's worker credential. Credentials live in `wrangler secret`
and the password manager ([T-004](./T-004-infrastructure.md)), never in this repo.

## Out of scope
Connector sync workers, DOCX/XLSX cloud extraction (T-212), review and publish (T-213), dead-letter and
reconciler dashboards (T-405), ingestion budgets and quotas (T-313).
