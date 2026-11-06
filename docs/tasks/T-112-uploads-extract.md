# T-112 Upload session, completion and cloud extraction of digital PDFs

Lane: 2 · Week: 1 · Protected: yes (`src/app/api/knowledge/`, and any migration here) · Depends on: T-111 · Status: in progress (wyuinline)
Plan refs: §7.2 steps 1–3, §9.2.1, §6.2; F09, F10, F12

## Goal
An authorized member starts an upload, the object lands in private storage under a server-chosen
key, completion verifies the object and creates an immutable source version plus an outbox event,
and a bounded cloud extractor pulls the text layer of a digital PDF with page locators.

## Owns (may edit)
- `src/platform/knowledge/` (upload session, completion, validator, PDF text extractor),
  `src/app/api/knowledge/uploads/` (Lane 2 per [FAQ-0005](../../docs/FAQ.md))
- `src/platform/knowledge/*.test.ts`; if storage/bucket policy needs SQL, one new
  `supabase/migrations/YYYYMMDDHHMMSS_*.sql` (protected, timestamp from the daily sync)

## Must not edit
`supabase/migrations/20261105060000_tenancy_core.sql`, `src/contracts/` (schemas are fixed;
request/response shapes are local), `src/platform/gateway/`

## Contract
`IngestionJobPayload` (stage `validate`/`extract`, `executor: cloud_worker`),
`DataClass`; rules in [docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md).

`register_source_version_v1` is the only write path (#13(1), #8, [FAQ-0004](../../docs/FAQ.md)): it
sets the tenant, `uploaded_by` (taken from `auth.uid()`, never from the request body), the verified
content hash and the object key **server-side**, and members hold no direct write grant on the
knowledge tables. `uploaded_by` is what T-213 later compares a reviewer against.

## Acceptance tests (write first)
- [ ] positive: session issues an object key the client cannot choose; completion verifies hash,
      size and **actual** file signature, then creates one source version + one outbox event
- [ ] positive: the stored row's `uploaded_by` equals the calling `auth.uid()` and its tenant equals
      the host-resolved organization; a body claiming another `uploaded_by` or tenant is ignored
- [ ] negative: a direct `insert` into `knowledge_sources` or `source_versions` as `authenticated`
      is a permission error (`42501`) — only the scoped RPC writes (#13(1))
- [ ] negative: a session created for tenant A cannot be completed on tenant B, and cannot be
      completed into a collection the user may not publish into
- [ ] negative: a user without collection publish permission gets 403 and no source row
- [ ] failure: a `.pdf` that is really an `.exe`, an oversized file, a 0-byte file, a zip bomb and
      an encrypted PDF each end in `quarantined`/`failed` with a safe reason code — never a
      silently empty "successful" source
- [ ] idempotency: the same completion posted twice creates exactly one version and one job; an
      "already uploaded" hint appears **only** when the existing copy is readable by this uploader,
      otherwise a generic result with no existence signal (#13(2))
- [ ] extraction keeps page numbers and refuses to run macros/JS embedded in the PDF

## Done evidence
`pnpm verify`; `pnpm db:test` if SQL changed (CI `database` job where there is no Docker); staging:
upload a synthetic digital PDF for company1, watch it reach `indexing`, and show the same upload
rejected on company2.

## Out of scope
OCR and scans (T-211/T-212), DOCX/XLSX (T-212), chunk/embed/publish (T-113), connectors, review UI.
