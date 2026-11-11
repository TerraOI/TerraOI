# T-112 Upload session, completion and cloud extraction of digital PDFs

Lane: 2 · Week: 1 · Protected: yes (`src/app/api/knowledge/`, and any migration here) · Depends on: T-111 · Status: in progress — **T-112c claimed by Lane 2 (PR #168)**; T-112 a/b are done — merged as [PR #32](https://github.com/TerraOI/TerraOI/pull/32) (a: upload session and capture RPCs) and [PR #54](https://github.com/TerraOI/TerraOI/pull/54) (b: digital-PDF extraction with page locators); the staging demo below is **not** claimed — it still waits on #38 (storage credential) and #75 (session-store reach)
Plan refs: §7.2 steps 1–3, §9.2.1, §6.2; F09, F10, F12

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Follow-up PR** ([#40](https://github.com/TerraOI/TerraOI/issues/40)): delete the stored object when a capture is quarantined or fails, per the #40 ruling.
- **T-112c** ([#96](https://github.com/TerraOI/TerraOI/issues/96)): a new migration (never edit the merged one) so that the `completed` replay in `register_source_version_v1` filters `organisation_id` and checks `source_is_readable`/`collection_is_readable`, answering with the same generic refusal as the dedup and race branches; and the session guard pins `expires_at` and makes `completed`, `quarantined`, `failed` and `expired` final (only `awaiting_upload` may change state). pgTAP in slot `041`. Lane 2, protected, week 2.
- **Capture RPCs take the organisation** ([#163](https://github.com/TerraOI/TerraOI/issues/163), FAQ-0011), in T-112c's migration: `begin_upload_session_v1`, `register_source_version_v1` and `record_upload_outcome_v1` are replaced by versions that take `p_organisation_id uuid` first and begin with `perform public.set_tenant_scope(p_organisation_id);`. The old signatures are dropped (no adapter calls them, `upload-adapters.ts:19-21`), and the new ones go on `001`'s allow-list. `UploadStore.beginSession` keeps `organisationId` and drops `userId`: the user comes from the token.

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
