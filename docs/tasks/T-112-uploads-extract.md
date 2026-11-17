# T-112 Upload session, completion and cloud extraction of digital PDFs

Lane: 2 · Week: 1 · Protected: yes (`src/app/api/knowledge/`, and any migration here) · Depends on: T-111 · Status: in progress — **T-112c claimed by Lane 2 (PR #168)**; T-112 a/b are done — merged as [PR #32](https://github.com/TerraOI/TerraOI/pull/32) (a: upload session and capture RPCs) and [PR #54](https://github.com/TerraOI/TerraOI/pull/54) (b: digital-PDF extraction with page locators); the staging demo below is **not** claimed — it waits on #37 (how a Worker carries verified identity into Postgres), #38 (storage credential) and #75 (session-store reach), and until #37/#38 are decided `uploadDeps()` stays null and the routes answer 503 (`upload-adapters.ts:8-21`). The acceptance list below is now ticked item by item with the test that proves each one, and each item says what that proof does not cover
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

All eight are ticked, each with the test that proves it. Two limits cover the whole list and are
not repeated item by item:

- The handler-side items are proven at the seam (`handleBeginUpload` / `handleCompleteUpload`)
  against the fake `UploadStore` of `upload-session.test.ts`. `uploadDeps()` returns null
  (`upload-adapters.ts:19-21`) while #37 and #38 stay open, so the deployed routes answer 503 and
  nothing here is proven over HTTP.
- The SQL items run only in CI's `database` job: there is no Docker on this machine (FAQ-0009), so
  no `pnpm db:test` number exists for them locally.

- [x] positive: session issues an object key the client cannot choose; completion verifies hash,
      size and **actual** file signature, then creates one source version + one outbox event —
      `upload-session.test.ts:318` (the key comes from the store), `:446` (exactly one version, one
      job and one outbox row), `:684` (a stored object past the session bound is refused and never
      read whole), `:700` (a declared hash that does not match the bytes is refused);
      `object-validator.test.ts:68` (the declared hash is only a claim), `:100` (typed by its header,
      not its name).
- [x] positive: the stored row's `uploaded_by` equals the calling `auth.uid()` and its tenant equals
      the host-resolved organization; a body claiming another `uploaded_by` or tenant is ignored —
      `upload-session.test.ts:334`; and in SQL the value is never a parameter at all:
      `20261116213000_capture_scope.sql:105` and `:229` take the user from `auth.uid()`, and `:344`
      and `:349-352` write it. After this slice `UploadStore.beginSession` has no `userId` parameter
      either, so the port itself cannot carry one (#163, ruling above).
- [x] negative: a direct `insert` into `knowledge_sources` or `source_versions` as `authenticated`
      is a permission error (`42501`) — only the scoped RPC writes (#13(1)) — proven in SQL by
      `040_knowledge_uploads.test.sql:247-250` (assertions 1 and 2, the second of which names the
      reason: a client cannot mint a version with its own `uploaded_by`, issue #8).
- [x] negative: a session created for tenant A cannot be completed on tenant B, and cannot be
      completed into a collection the user may not publish into — `upload-session.test.ts:510` and
      `:528` (a permission lost mid-flight writes nothing). In SQL the second half is 041's
      `fresh_after_loss` case (`041_knowledge_uploads_guard.test.sql:469-472`): an `awaiting_upload`
      session is completed after the caller's project membership is removed, so the first refusal it
      can reach is this migration's completion re-check (`:293-297`), and assertion 37 pins that
      refusal's whole message and not only its SQLSTATE.
- [x] negative: a user without collection publish permission gets 403 and no source row —
      `upload-session.test.ts:363`. In SQL `040_knowledge_uploads.test.sql:332-358` (assertions 17-19:
      a member holding only `knowledge.read` cannot open a session at all, `knowledge.write` at level
      `write` is what opens the tenant corpus, and that grant does not reach a project corpus).
- [x] failure: a `.pdf` that is really an `.exe`, an oversized file, a 0-byte file, a zip bomb and
      an encrypted PDF each end in `quarantined`/`failed` with a safe reason code — never a
      silently empty "successful" source — `upload-session.test.ts:652` (safe reason, no source
      row), `:816` (a guard refusal from the write path maps to a safe code with no rows);
      `object-validator.test.ts:80` (0-byte), `:90` (oversize), `:100` (renamed `.exe`), `:123`
      (encrypted), `:134`/`:154`/`:173`/`:194`/`:265` (bombs, including one parked past the
      structural scan cap), `:290` (a truncated tail is malformed, not empty), `:284` (the budgets
      are finite). In SQL, 040 assertions 52 and 53: that RPC can only move a session to
      `quarantined`/`failed`, and the quarantine keeps a safe reason code.
- [x] idempotency: the same completion posted twice creates exactly one version and one job; an
      "already uploaded" hint appears **only** when the existing copy is readable by this uploader,
      otherwise a generic result with no existence signal (#13(2)) — `upload-session.test.ts:543`
      (one version, one job), `:563` (the hint, when the copy is readable), `:582` and `:620` (the
      same bytes in another tenant, and in a project corpus the uploader cannot read: their own
      version and no signal); in SQL, 040 assertion 22 (exactly one version row after the completion)
      and 28 (a replayed completion replays instead of capturing twice), and 041 assertions 36-39,
      which make the replay refusal byte-identical to the not-allowed refusal so the replay branch is
      not an existence oracle (#96 clause 1).
- [x] extraction keeps page numbers and refuses to run macros/JS embedded in the PDF —
      `pdf-text-extract.test.ts:12` (numbers and page order), `:182` (numbering comes from the page
      tree, not object order), `:213` (a page with no text operators is reported, never stored as an
      empty success), `:221` (JavaScript, Launch actions and embedded files refused), `:91` (a
      multi-filter chain is refused rather than published as text).

## Done evidence
`pnpm verify`; `pnpm db:test` if SQL changed (CI `database` job where there is no Docker); staging:
upload a synthetic digital PDF for company1, watch it reach `indexing`, and show the same upload
rejected on company2.

## Out of scope
OCR and scans (T-211/T-212), DOCX/XLSX (T-212), chunk/embed/publish (T-113), connectors, review UI.
