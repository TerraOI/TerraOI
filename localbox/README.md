# Local-box OCR pull worker

The tenant box runs **no inbound listener** (plan §13, F32). It polls the platform job API over the staging tunnel with a scoped worker credential, leases one `extract` job, pulls object bytes through a short-lived signed URL, and completes or aborts the lease.

## What lives here

| Path | Role |
|---|---|
| `ocr-pull.ts` | Outbound HTTP client for `/api/jobs/{lease,renew,object-url,complete,abort}` |
| `ocr-pull.test.ts` | Contract tests against the JSON shapes the app Worker returns |

No secrets, connection strings, or service-role keys belong in this folder (AGENTS.md §4.6, ADR-0011).

## Owner setup (T-004 §20.8 — not committed)

1. Issue a `local_box` worker credential with `scripts/worker-credential.mjs`; store only the hash in `job_api.worker_credentials`.
2. Put the raw token in the box's password manager / env — never in this repo.
3. Point the client at the tenant staging host (e.g. `https://company1-staging.terraoi.app`) over the staging tunnel.
4. Confirm `/api/jobs/lease` answers `found: false` when the queue is empty (401 without a Bearer; 503 when `JOB_DB` is unbound).

## Run (once the token and host are in the local environment)

```bash
# From the repo root — illustration only; wire env outside git.
pnpm exec tsx localbox/ocr-pull.ts   # when a CLI entry is added; today the module is library-shaped
```

Until a CLI entry ships, drive the client from a small local harness that calls `createHttpBoxJobApi` with your host and credential.

## What the box must never hold

- Supabase service-role key (lives only on `workers/` / `terraoi-extraction`)
- Database password or Hyperdrive connection string
- Another tenant's credential
