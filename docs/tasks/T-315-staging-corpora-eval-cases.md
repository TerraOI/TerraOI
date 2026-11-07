# T-315 Load approved Company1 corpora into staging; draft the first eval cases

Lane: 2 · Week: 3 · Protected: no · Depends on: T-111 (merged), T-112 (a merged as #32; b open as #54), T-113 (unclaimed — the pin is decided by #6's engineering half), T-114 (unclaimed), T-211 and T-212 (not started), T-312 (same week: F34/F35 machinery) · Status: ready
Gated by decisions: [#6](https://github.com/TerraOI/TerraOI/issues/6) (Company1 half), [#38](https://github.com/TerraOI/TerraOI/issues/38), [#51](https://github.com/TerraOI/TerraOI/issues/51), [#66](https://github.com/TerraOI/TerraOI/issues/66)
Plan refs: §14.1 (steps 1–2 and the thresholds), §7.1–§7.2, §6.2, §18.3, §20.3, §20.8; F34 (the runner is [T-312](./T-312-eval-harness.md)'s), F10/F12/F13 used, not owned

## Goal
The pilot corpus exists somewhere real: the documents Company1 approved for staging are uploaded to the
company1-staging workspace and walk the whole pipeline (validate → extract, cloud or local box → chunk →
embed → review → publish), and the first candidate eval cases are drafted from what published, plus the
adversarial cases that need no domain knowledge. This is the input §14.1's pilot-entry thresholds are
measured on and the material the UAV and GPR leads spend weeks 3–4 approving.

## Owns (may edit)
- `evals/uav-expert/` and `evals/gpr-expert/` — **drafted case files only**, in a `drafts/` subfolder that
  F35 ignores until an eligible reviewer approves; and `evals/LOADING.md`, the staging load runbook
  (file list, collection and project per corpus, expected stage timings, the box-offline path, counts
  against §14.1's thresholds)
- `evals/**/*.test.ts` — validators: every case file parses, names a published source version and
  locator, carries one of §14.1's four case types, and holds no client-identifying text
- no migration: capture is merged with T-112a (`040`), eval tables are `090` in
  [T-312](./T-312-eval-harness.md)

## Must not edit
`src/platform/evals/` (the drafting and scoring **code** is T-312's — this packet runs it and commits the
output; agree the split in the daily sync), `src/platform/knowledge/`, merged migrations,
`src/contracts/`, `supabase/seed.sql` (client corpora never enter the repository, AGENTS.md §4.7),
`src/app/`, `.github/`, and no real document text in any committed file.

## Contract
Case shape is plan §6.1's `eval_cases` (question, expected answer points, expected source versions,
origin `agent_drafted | expert_written | pilot`). F34 drafts **only from collections the reviewing expert
may read** (§14.1 step 1); builders add the six non-domain cases §14.1 step 2 lists: cross-tenant bait, a
project-restricted document, poisoned instructions inside a document, a missing source, an outage mid-run,
an ambiguous follow-up. Locators must be expressible as
[`EvidenceRef`](../../src/contracts/answer.ts); a run is bound to a published corpus generation, and
#6's engineering half decided that generation: `@cf/baai/bge-m3`, 1024 dims, cosine, `cleared_for` =
`public` + `internal` only. Loading uses the ordinary capture path — `begin_upload_session_v1` and
`register_source_version_v1` in the merged
[`20261106100000_knowledge_uploads.sql`](../../supabase/migrations/20261106100000_knowledge_uploads.sql)
— with no pilot special case.
**Assumed, not resolved; all four owe a supervisor decision and two can stop the packet:**
**#6** with `cleared_for` at `public` + `internal`, a `client_confidential` corpus is searchable only in
the labelled `lexical_only` lane, so an eval over it measures degraded retrieval — this packet loads
`public`/`internal` first and says so; **#66** capture queues `'extract', 'cloud_worker'` unconditionally
(that file, `:474`), and the stage key at `knowledge_core.sql:398` **excludes `executor`** while the enqueue
uses `on conflict … do nothing` (`knowledge_uploads.sql:477-478`) — so inserting a `local_box` row
afterwards is **discarded
silently, not refused**. Re-targeting has to be a guarded `UPDATE` through an RPC (only `select` is granted
to `authenticated` at `knowledge_core.sql:890-894`), the schema already expects exactly that with
`ingestion_jobs_local_box_runs_only_extract` (`:390-391`), and the status CHECK at `:363` has no
queued-for-OCR value, so §7.2's visible-queue wording needs a CHECK widening too. Until that lands, scans
and images in the corpus cannot reach the box; **#51** `body_text`, `payload` and
`parser_generation` are immutable for the row's life
([`20261105070000_knowledge_core.sql:573-577`](../../supabase/migrations/20261105070000_knowledge_core.sql))
and `unique (collection_id, content_hash)` at `:220` blocks a second version of the same bytes, so a
parser bump cannot re-extract in place; **#38** no storage credential, so uploads have no working server
side and this packet can only prepare and validate. And whether an approved client case's expected answer
points may be committed **at all** (§4.7 + §6.2) is a decision owed, not made here.

## Acceptance tests (write first)
- [ ] positive: `evals/uav-expert/cases.test.ts` — every committed case file parses, names a published source
      version with a locator, and carries one of the four §14.1 case types
- [ ] positive: staging runbook — each corpus file reaches `published` (or `awaiting_review`) with chunk count
      and corpus generation recorded, drafts are produced only from what published, and the adversarial six
      (§14.1 step 2) exist before any domain input is needed
- [ ] negative: the corpus loaded on company1-staging returns **zero** rows for the same query as a company2
      member, and the cross-tenant bait case records a refusal, not an answer
- [ ] negative: a `client_confidential` Site A corpus is invisible to a Company1 member outside Site A and to a
      `suspended` membership, and its drafted cases never appear for a reviewer who cannot read them
- [ ] negative: nothing client-identifying is committed — the validator fails on a client name, object key, site
      identifier or quoted document sentence in any `evals/` file (AGENTS.md §4.7)
- [ ] failure: a scanned PDF with the box offline stays in `extracting` as "queued for OCR" (T-211) and the
      runbook records that as expected, not as a failed load; an unsupported type is refused with a message,
      never half-ingested; an unapproved draft never enters a scored run

## Done evidence
Staging: the corpus manifest with per-file final state, chunk counts and corpus generation; the drafted
count per expert against §14.1's thresholds (≥40 approved, ≥10 must-refuse/clarify, ≥5 cross-tenant or
project bait) reported as **drafted**, since approval is the leads' weeks 3–4 work; `pnpm verify` for the
validators (no pgTAP of its own); the company2 zero-row check pasted with its query.

## Out of scope
Approving cases (the named leads, plan §20.8 — §18.3 still has no names), the harness and scoring (T-312),
the reviewer UI (T-303), tuning prompts/chunks/chains until thresholds pass (T-403), connectors and bulk
import tooling (§7.3, after M1), production data, and any client corpus past `internal` before Company1's
#6 answer is recorded.
