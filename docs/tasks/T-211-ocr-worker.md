# T-211 Local-box OCR pull worker and job API (F32)

Lane: 2 · Week: 2 · Protected: yes (`workers/`, `localbox/`, `supabase/migrations/`, `src/app/api/jobs/`) · Depends on: T-111, T-112, T-115 · Status: ready
Plan refs: §7.2 (extraction executors), §13 (local box in the topology), §7.5, §16 (Forms/OCR row); F12, F32

## Goal
A scanned PDF or image becomes text: the box runs **no inbound listener**, it polls a narrow job API
with a scoped worker credential, leases one job, pulls the object through a short-lived signed URL,
returns an artifact with page and table locators, and releases the lease — while the platform rechecks
tenant, version, stage and lease on every call and stops the job the moment its source is revoked.

## Owns (may edit)
- `workers/` (outbox dispatcher, job API handlers, lease wiring), `localbox/` (pull worker, runbook
  notes, no secrets)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_ocr_job_leases.sql` for lease/claim columns and
  the worker-facing RPCs — timestamp agreed in the daily sync; migrations are protected and merged
  migrations are never edited
- `supabase/tests/database/040_ingestion_jobs.test.sql`, `workers/*.test.ts`, `localbox/*.test.ts`
- `src/app/api/jobs/` — Lane 2 owns these route folders ([FAQ-0005](../../docs/FAQ.md)), so the job API
  is implemented here directly: no re-export from Lane 1 and no `cross-lane` label

## Must not edit
`src/contracts/`, merged migrations, `src/platform/gateway/` (the box's inference endpoint is the
gateway's business, T-115), `src/platform/chat/`, `brand/`

## Contract
[`IngestionJobPayload`, `IngestionStage`, `JobExecutor`](../../src/contracts/ingestion-job.ts) —
`executor: local_box` is valid only for stage `extract`, and `restricted` is never enqueued
(`isIngestibleInM1`). New security-invoker RPCs `lease_parse_job_v1`, `renew_parse_lease_v1`,
`complete_parse_job_v1`, `abort_parse_job_v1`, each re-reading the authoritative job row and applying
`set_tenant_scope(uuid)` from the merged tenancy migration
`supabase/migrations/20261105060000_tenancy_core.sql` (lands with T-003). Rules:
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md).

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/040_ingestion_jobs.test.sql` — one job is leased at a time with
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

## Done evidence
`pnpm db:test`, `pnpm verify`; staging through the staging tunnel: upload a synthetic scanned PDF for
company1 and show the lease/complete sequence with artifact locators, then upload on the company2 host
and show its job is invisible to company1's worker credential. Credentials live in `wrangler secret`
and the password manager ([T-004](./T-004-infrastructure.md)), never in this repo.

## Out of scope
Connector sync workers, DOCX/XLSX cloud extraction (T-212), review and publish (T-213), dead-letter and
reconciler dashboards (T-405), ingestion budgets and quotas (T-313).
