# T-315 Load approved Company1 corpora into staging; draft the first eval cases

Lane: 2 · Week: 3 · Protected: no · Depends on: T-111 (merged), T-112 (a merged as #32; b open as #54), T-113 (unclaimed — the pin is decided by #6's engineering half), T-114 (unclaimed), T-211 and T-212 (not started), T-312 (same week: F34/F35 machinery) · Status: ready
Gated by decisions: [#6](https://github.com/TerraOI/TerraOI/issues/6) (Company1 half), [#38](https://github.com/TerraOI/TerraOI/issues/38), [#51](https://github.com/TerraOI/TerraOI/issues/51), [#66](https://github.com/TerraOI/TerraOI/issues/66) · Plan refs: §14.1 (steps 1–2, thresholds), §7.1–§7.2, §6.2, §18.3, §20.3 ("During weeks 3–4 the Company1 UAV and GPR leads review and approve eval cases"), §20.8; F34 (runner is [T-312](./T-312-eval-harness.md)'s), F10/F12/F13 used, not owned

## Goal
The pilot corpus exists somewhere real: the documents Company1 has approved for staging are uploaded to
the company1-staging workspace, walk the whole pipeline (validate → extract, cloud or local box → chunk →
embed → review → publish), and the first candidate eval cases are drafted from the published versions
plus the adversarial cases that need no domain knowledge. This is the input the §14.1 pilot-entry
thresholds are measured on, and the material the UAV and GPR leads spend weeks 3–4 approving.

## Owns (may edit)
- `evals/uav-expert/` and `evals/gpr-expert/` — **drafted case files only** (a `drafts/` subfolder that
  F35 ignores until an eligible reviewer approves them), plus the case-file schema check
- `evals/LOADING.md` — the staging load runbook: file list, collection and project per corpus, expected
  stage timings, the box-offline path, and the counts against §14.1's thresholds
- `evals/**/*.test.ts` — validators that every committed case file parses, has one of §14.1's four case
  types, names an expected source version and locator, and contains no client-identifying text
- no migration: capture, index and eval tables are other packets' (`040` capture pgTAP is merged with
  T-112a; `090` is [T-312](./T-312-eval-harness.md)'s)

## Must not edit
`src/platform/evals/` (the drafting and scoring **code** is T-312's; this packet runs it and commits its
output), `src/platform/knowledge/`, merged migrations, `src/contracts/`, `supabase/seed.sql` (client
corpora never enter the repository — AGENTS.md §4.7), `src/app/`, `.github/`, and no real document text of
any kind in any committed file.

## Contract
Case shape is plan §6.1's `eval_cases` (question, expected answer points, expected source versions,
origin `agent_drafted | expert_written | pilot`), drafted by F34 **only from collections the reviewing
expert is authorized to see** (§14.1 step 1), with the builders adding the non-domain adversarial set
§14.1 step 2 lists: cross-tenant bait, project-restricted documents, poisoned instructions inside a
document, a missing source, a provider outage mid-run, an ambiguous follow-up. Locators must be
expressible as [`EvidenceRef`](../../src/contracts/answer.ts) so an expected source is checkable; a
published corpus generation is what a run is bound to (§6.1, T-113's pin decided in #6:
`@cf/baai/bge-m3`, 1024 dims, cosine, `cleared_for` = `public` + `internal` only). Case rows inherit the
**highest** class of their sources (§6.2), and the load uses the ordinary capture path —
`begin_upload_session_v1` / `register_source_version_v1` from the merged capture migration
([`20261106100000_knowledge_uploads.sql`](../../supabase/migrations/20261106100000_knowledge_uploads.sql))
— with no special ingestion route for pilots.
**Conflicts this packet assumes rather than resolves — all four owe a supervisor decision, and two can
stop the packet outright:**
1. **[#6, Company1 half](https://github.com/TerraOI/TerraOI/issues/6):** with `cleared_for` limited to
   `public` + `internal`, any `client_confidential` corpus is searchable only in the labelled
   `lexical_only` lane, so an eval run over it measures degraded retrieval, not the pilot configuration.
   This packet loads `public`/`internal` corpora first and says so in the runbook; a
   `client_confidential` load waits for the recorded approval.
2. **[#66](https://github.com/TerraOI/TerraOI/issues/66):** capture queues `'extract', 'cloud_worker'`
   unconditionally (`…knowledge_uploads.sql:474`), so scanned pages and images in the corpus cannot be
   re-targeted to the local-box worker until the answer lands.
3. **[#51](https://github.com/TerraOI/TerraOI/issues/51):** `body_text`, `payload` and
   `parser_generation` are immutable for the row's life
   ([`20261105070000_knowledge_core.sql:573-577`](../../supabase/migrations/20261105070000_knowledge_core.sql))
   and `unique (collection_id, content_hash)` at `:220` blocks a second version of the same bytes, so a
   parser bump cannot re-extract a corpus in place.
4. **[#38](https://github.com/TerraOI/TerraOI/issues/38):** no storage credential is decided, so the
   staging upload path has no working server side; until then this packet can only prepare and validate.
   **Naming what may be committed:** AGENTS.md §4.7 and §6.2 mean committed cases carry no client text —
   they reference source-version ids and locators. Whether an approved client case's expected answer
   points may be committed at all is a decision owed, not made here.

## Acceptance tests (write first)
- [ ] positive: `evals/uav-expert/cases.test.ts` — every committed case file parses against the schema,
      names a published source version with a locator, and carries one of the four §14.1 case types
- [ ] positive: staging runbook evidence — each corpus file reaches `published` (or `awaiting_review`)
      with its chunk count and index generation recorded, and drafts are produced from what published
- [ ] positive: the adversarial set exists before any domain input is needed — cross-tenant bait, a
      project-restricted document, poisoned instructions inside a document, a missing source, an
      outage mid-run and an ambiguous follow-up (§14.1 step 2)
- [ ] negative: the corpus loaded on company1-staging returns **zero** rows for the same query as a
      company2 member, and a case that baited a cross-tenant id records a refusal, not an answer
- [ ] negative: a `client_confidential` Site A corpus is invisible to a Company1 member outside Site A and
      to a `suspended` membership, and its drafted cases never appear for a reviewer who cannot read it
- [ ] negative: nothing client-identifying is committed — a validator fails on a client name, an object
      key, a site identifier or a quoted document sentence in any `evals/` file (AGENTS.md §4.7)
- [ ] failure: a scanned PDF with the box offline stays in `extracting` as "queued for OCR" (T-211) and the
      runbook records that as expected, not as a failed load; an unsupported file type is refused with a
      message and never half-ingested (§7.1)
- [ ] failure: a drafted case whose expected source is later revoked (T-213) is flagged, and an unapproved
      draft never enters a scored run ([T-312](./T-312-eval-harness.md)'s rule, asserted from this side)

## Done evidence
Staging: the corpus manifest with per-file final state, chunk counts and corpus generation; the drafted
case count per expert against §14.1's thresholds (≥40 approved, ≥10 must-refuse/clarify, ≥5
cross-tenant/project bait) reported as **drafted**, since approval is the leads' weeks 3–4 work;
`pnpm verify` for the validators (no pgTAP of its own); the company2 zero-row check pasted with the query.

## Out of scope
Approving cases (the named UAV and GPR leads, plan §20.8 — and §18.3 still has no names), the harness and
scoring (T-312), the reviewer UI (T-303), prompt/chunk/chain tuning until thresholds pass (T-403),
connectors and bulk import tooling (§7.3, after M1), production data of any kind, and any client corpus
ingestion past `internal` before Company1's #6 answer is recorded.
