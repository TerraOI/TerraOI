# Local-box OCR pull worker

The tenant box runs **no inbound listener** (plan §13, F32). It polls the platform job API over the staging tunnel with a scoped worker credential, leases one `extract` job, pulls object bytes through a short-lived signed URL, runs an injected OCR extractor, and completes or aborts the lease.

## What lives here

| Path | Role |
|---|---|
| `cli.ts` | OWNER-facing entry: env → deps → one poll (`--once`) or the sleep loop |
| `cli.test.ts` | Arg parsing and unbound-env fail-closed tests (no network, no OCR) |
| `ocr-pull.ts` | Outbound HTTP client for `/api/jobs/{lease,renew,object-url,complete,abort}` |
| `ocr-pull.test.ts` | Contract tests against the JSON shapes the app Worker returns |
| `box-extractor.ts` | `BoxExtractorPort` — OCR engine seam (unavailable / command / test double) |
| `box-extractor.test.ts` | Engine-port unit tests (no real OCR binary) |

No secrets, connection strings, or service-role keys belong in this folder (AGENTS.md §4.6, ADR-0011).

## Owner setup (T-004 §20.8 — not committed)

1. Issue a `local_box` worker credential with `scripts/worker-credential.mjs`; store only the hash in `job_api.worker_credentials`.
2. Put the raw token in the box's password manager / env — never in this repo.
3. Point the client at the tenant staging host (e.g. `https://company1-staging.terraoi.app`) over the staging tunnel.
4. Confirm `/api/jobs/lease` answers `found: false` when the queue is empty (401 without a Bearer; 503 when `JOB_DB` is unbound).

## OWNER OCR engine install (T-211 PR-3f)

This folder does **not** ship an OCR binary and does not add an npm OCR engine dependency. Extraction is an injected port:

- Default: `resolveBoxExtractor()` → `createCommandBoxExtractor` when `OCR_COMMAND` is set, otherwise an unavailable abort (`unsupported_document` / `ocr_command_unbound`).
- Tests: `createFixedBoxExtractor` returns a deterministic artifact set or abort.
- Bytes stay in process memory (stdin to the child). No temp files, no service-role, no credentials in this module.

### Install (OWNER machine only)

1. Install whatever OCR/CLI tool the site trusts (Tesseract, a commercial engine, a site wrapper script, …). TerraOI does not prescribe one.
2. Set `OCR_COMMAND` to a shell command that:
   - reads **document bytes on stdin**
   - writes **JSON on stdout** — either an artifact array, or `{ "artifacts": [ … ] }` matching `ArtifactInput` (`artifactIndex`, `bodyText`, optional `locator` / `confidence` / `notes`)
   - exits `0` on success; non-zero → the box aborts `quality_failed`
3. Keep credentials out of the command string and out of engine logs that the box might inherit. The adapter never logs stdout/stderr.

Until `OCR_COMMAND` is set, leased jobs download bytes and then abort `unsupported_document` — they are never completed with an empty artifact set.

## Run (once the token and host are in the local environment)

```bash
# From the repo root — wire env outside git (password manager / box install).
# OCR_COMMAND="my-ocr --json" \
# TOI_JOB_API_BASE_URL="https://company1-staging.terraoi.app" \
# TOI_WORKER_TOKEN="<raw worker credential>" \
pnpm exec tsx localbox/cli.ts            # poll loop (DEFAULT_POLL_INTERVAL_MS)
pnpm exec tsx localbox/cli.ts --once     # one lease attempt, then exit
# optional: --poll-interval-ms 15000
```

Unbound `TOI_JOB_API_BASE_URL` or `TOI_WORKER_TOKEN` fails closed before any socket opens (exit 1).
Stdout is JSON lines of closed `BoxEvent` shapes only — never the token, never a URL, never document words.
`OCR_COMMAND` is optional; when unset, leased jobs abort `unsupported_document` via `resolveBoxExtractor()`.

## What the box must never hold

- Supabase service-role key (lives only on `workers/` / `terraoi-extraction`)
- Database password or Hyperdrive connection string
- Another tenant's credential
- An OCR vendor API key inside this repo (OWNER env / password manager only)
