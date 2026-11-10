# T-212 DOCX/XLSX extraction and routing of scans and images

Lane: 2 · Week: 2 · Protected: no · Depends on: T-111, T-112, T-211 · Status: ready
Plan refs: §7.1 (M1 file types), §7.2 steps 2–3 and "extraction executors", §7.5, §16 (ingestion row); F09, F10, F12

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **No artifact writer here** ([#135](https://github.com/TerraOI/TerraOI/issues/135)): the Owns item "artifact writer" becomes an **artifact mapper** — pure functions from extractor output to the `complete_parse_job_v1` artifact payload, with locators, tested against that contract. This packet writes nothing to the database and calls no job-API function; T-211's cloud loop stores the result.
- **Capture** ([#135](https://github.com/TerraOI/TerraOI/issues/135)): this packet opens capture for images (PNG/JPEG/TIFF/HEIC) and OOXML (DOCX/XLSX) in the validator, in the same PR as the extractors and their limits. Every verified object is still queued as `cloud_worker`; the routing decision sends images, scans and failed text layers to the box through T-211's retarget. Capture stays unaware of executors (`040_knowledge_uploads.test.sql:406-409` stands). The data class is inherited from the collection, as today.
- **Done evidence:** merges on `pnpm verify` and the unit and mapper tests. The staging run is **deferred, not waived** (COORDINATION §6a) until T-211's cloud loop, [#146](https://github.com/TerraOI/TerraOI/issues/146) and T-113's chunk writer are merged; the PR says so.

## Goal
Company1's office files become citable knowledge: digital PDF, DOCX, XLSX and form JSON are extracted
by the bounded cloud worker with page, section and sheet/row/column locators, while scanned PDFs,
images and PDFs whose text layer fails a quality check are routed to the local-box worker — and every
parser failure stays visible instead of becoming an empty "successful" source.

## Owns (may edit)
- `src/platform/knowledge/` (validator, type sniffing, the routing decision, DOCX and XLSX extractors,
  text-layer quality check, artifact writer)
- `src/platform/knowledge/*.test.ts`, `src/platform/knowledge/fixtures/` (synthetic files only),
  `evals/retrieval/` locator fixtures
- no migration is expected; if a state or routing check needs SQL, one new
  `supabase/migrations/YYYYMMDDHHMMSS_<snake_name>.sql` with the timestamp agreed in the daily sync —
  migrations are protected and merged migrations are never edited
- **[#66](https://github.com/TerraOI/TerraOI/issues/66):** the routing decision and the text-layer quality
  check are pure, tested functions here; this packet writes nothing to `ingestion_jobs`. Moving an
  `extract` job to the box is T-211's `retarget_extract_job_v1`

## Must not edit
`workers/` and `localbox/` (T-211), `src/contracts/`, merged migrations, `src/platform/gateway/`,
`src/platform/retrieval/` (T-114), and no real client document anywhere (AGENTS.md §4.7)

## Contract
[`IngestionJobPayload`](../../src/contracts/ingestion-job.ts) chooses the executor (`cloud_worker` vs
`local_box`, the latter only for stage `extract`) and carries `parserGeneration` for the stage
idempotency key; [`DataClass`](../../src/contracts/data-class.ts) plus `maxDataClass` are inherited
from the collection. Locator output must be expressible as
[`EvidenceRef`](../../src/contracts/answer.ts) chunk spans, so a citation can name a sheet row. Rules:
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md). Any parser library
added is listed with its reason in the PR (AGENTS.md §6) and runs only in the bounded worker.

## Acceptance tests (write first)
- [ ] positive: `src/platform/knowledge/xlsx-extract.test.ts` — a row keeps sheet, row and column
      locators plus header context, so "Sheet2!B7 under header *Payload capacity*" is citable
- [ ] positive: `src/platform/knowledge/docx-extract.test.ts` — headings and numbered clauses keep their
      section path, and units survive as text instead of being retyped by a model
- [ ] negative: formulas are read as cached values and never evaluated; macros, external links, remote
      references and instruction text inside a file are stored as data, never executed or obeyed
      (AGENTS.md §4.8)
- [ ] negative: routing — a scanned PDF, a PNG/JPEG/TIFF/HEIC image and a PDF whose text layer fails the
      quality check get `executor: local_box`; a digital PDF, DOCX or XLSX gets `cloud_worker`; an
      unsupported type is rejected with a clear message, never half-ingested
- [ ] negative: a `source_version` id from another tenant is refused by the composite FK, and a
      `client_confidential` version is never handed to a cloud or third-party OCR route its data class
      does not clear (plan §12.4)
- [ ] failure: a corrupt DOCX (bad zip), an encrypted PDF, an XLSX with formula errors or no cells, a
      decompression bomb and an over-page-count file each end in `quarantined`/`failed` with a safe
      reason code and visible parse warnings
- [ ] duplicate and out-of-order stage events for the same
      `(org, source, version, stage, parserGeneration)` produce exactly one artifact set

## Done evidence
`pnpm verify`, plus `pnpm db:test` if SQL landed; staging: upload a synthetic DOCX and XLSX for company1
and show the stored locators, then upload a scanned PDF and show it waiting for the local box.

## Out of scope
OCR engines and leases (T-211), connectors and their ACL mapping (deferred after M1), PPT/CAD/email
formats, chunking and embedding (T-113), table-extraction tuning beyond the pilot caps (§8.3).
