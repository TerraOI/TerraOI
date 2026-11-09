# Knowledge lifecycle, jobs and forms

Schemas: [`ingestion-job.ts`](../../src/contracts/ingestion-job.ts),
[`form-template.ts`](../../src/contracts/form-template.ts),
[`answer.ts`](../../src/contracts/answer.ts) ·
Plan §6.2, §7.2, §7.5, §7.6, §13 · Functions F08–F16, F32, F33

## Source version state machine (F10–F14)

```text
received → validating → extracting → indexing → awaiting_review → published
                 ↘ quarantined  ↘ failed            ↘ superseded / revoked → deleting → deleted
```

The database holds the state; a job message only asks a worker to run one stage. The employee
sees received / processing / needs review / ready / failed — never a claim that an upload
"taught" an agent (plan §7.2).

- **Capture** (F09/F10): server-issued object key, hash verified, immutable version row and the
  outbox event committed in the same transaction.
- **Extract** (F12/F32): digital PDF text layer, DOCX, XLSX and form JSON run in the bounded
  cloud worker; scans, images and PDFs that fail the text-layer quality check go to the local-box
  pull worker. Locators (page/section/table/row) and OCR confidence are metadata, and a failed
  parse is visible, not an empty "successful" source.
- **Index** (§12.4): the pinned `EmbeddingIndex` generation only. Metadata-only ACL changes
  change visibility immediately without re-embedding.
- **Publish** (F13): atomic activation of a complete version once policy and reviewer checks pass.
  **Revoke** (F14): new retrieval is blocked by database state within 60 seconds, and derived
  answers, summaries and caches are marked for revalidation (F27).

## Jobs carry scope, not authority

`IngestionJobPayload` is `.strict()` and never contains object URLs, tokens or keys — the job API
issues a short-lived signed URL when the worker asks for the job (F32). Every worker call
re-reads the job row and re-checks lease, tenant, source version and expected stage, so a
replayed or stale message cannot process another tenant's object or resurrect a revoked source.

- The stage idempotency key is `(org, source, version, stage, parser/index generation)` (§7.5),
  and `attempt` is **not** part of it (issue #16 N3): a fresh key per retry would re-enqueue a
  stage that already ran and defeat the deduplication that at-least-once Cloudflare Queues needs.
  `attempt` is consumer bookkeeping — lease, backoff, observability — and the unique stage key on
  `ingestion_jobs` (`20261105070000_knowledge_core.sql:398`) leaves it out for exactly that reason.
  Attempt history is not modelled as rows in M1. Retries increment `attempt` in place, and lease
  state lives on the job row (#68).
- `executor: local_box` is valid **only** for `extract`: inference and OCR are separate
  processes on the box, and OCR load must not starve chat (§13).
- `dataClass: restricted` cannot be enqueued in M1 (§12.4). Lifting that needs an ADR.
- Workers hold no database credentials and no employee session; they use job-scoped server
  interfaces (§13).

## Forms (F33, TOI-ADR-16)

A `FormTemplate` is a versioned JSON Schema plus whitelisted field hints (`order`, `placeholder`,
`helpText`, `unit`). The schema rejects unknown top-level keys (`customCss`, `stylesheetUrl`,
`onSubmitUrl`) and refuses any template whose schema or hints contain handler keys,
`$ref`, script/style/html markers or remote/data URLs — a template is untrusted content with a
path into retrieval, and its values become citable `form_field` evidence
(`submissionId` + `fieldPath` + `templateVersion`) in an `Answer`.

Submissions are immutable; a correction is a new submission linked to the old one, and
publication follows the collection's review policy (§7.2 step 7). M1 ships two to three
platform-seeded templates, at least one per expert, with no form designer and no conditional
logic beyond JSON Schema (§15.0).
