# `evals/` — evaluation cases per expert

Lane 2 owns this folder ([`docs/REPO-STRUCTURE.md`](../docs/REPO-STRUCTURE.md), top-level table). The file
format, the field list, the locator rule and the provenance rule are in
[`docs/contracts/eval-case-format.md`](../docs/contracts/eval-case-format.md). Plan §14.1 owns the
workflow; TOI-ADR-17 owns the principle: **build agents draft, Company1 domain experts approve.**

## What is here

| Path | Contents |
|---|---|
| `uav-expert/drafts/`, `gpr-expert/drafts/` | F34-style candidate cases (`agent_drafted`), one JSON file per case — **56 UAV and 58 GPR** in this batch |
| `uav-expert/`, `gpr-expert/` | approved fixtures only. Empty today: no case has been approved |

A **draft** is a question with expected answer points, a synthetic source reference and an expected answer
status, written before any lead has looked at it. **F35 ignores drafts** — the runner reads only
`evals/<expert-key>/*.json`, never a `drafts/` folder (plan §14.1 step 3). Placement in this tree *is* the
approval state, so a draft cannot be scored by accident.

## How a draft becomes an approved fixture

1. A UAV or GPR lead opens the case in the tenant-side review view (the week-3 packet T-303; not on `main`
   yet) — a lead only ever sees a case whose expected source they are authorized to read.
2. The lead **approves**, **edits** (returns to pending with their text; the old text is not approved) or
   **rejects** it. Reviewer identity and time are recorded server-side from `TenantContext`.
3. The approval is exported: the case is written to `evals/<expert-key>/<case_id>.json` with
   `"status": "approved"`, `approvedBy`, `approvedAt`, and `expectedEvidence` bound to a published
   `sourceVersionId` + `chunkId` + character span. A hand-moved file with no recorded reviewer is not an
   approval.

Nothing in `drafts/` here is approved, and none of it can be approved as-is: every `expected_source` names
a `SYNTH-*` fixture that exists in no corpus. A lead re-binds each case to a real document before approving.

## Assumptions stated plainly

- **Folder names.** `uav-expert` / `gpr-expert`, the names the week-3 packets use. `supabase/seed.sql:118`
  and `:122` use `uav-compliance` / `gpr` as service keys and T-311's test expects routing to those, so the
  canonical expert key is still open — see Blank 1 in
  [`docs/contracts/eval-case-format.md`](../docs/contracts/eval-case-format.md). Undoing this is two folder
  renames plus the `expertKey` field in each file; nothing else here depends on it.
- **Validators (T-315).** `uav-expert/cases.test.ts` and `gpr-expert/cases.test.ts` parse every case
  file, require SYNTH fixtures + a §14.1 case type, refuse client-identifying patterns, and assert the
  six adversarial classes are present. They run under `pnpm test` / `pnpm eval:ci`.
- **Counts are drafted, not approved.** §14.1's pilot-entry thresholds (≥ 40 approved per expert,
  ≥ 10 must-refuse/clarify, ≥ 5 cross-tenant/project bait) are measured on **approved** cases, so this
  batch contributes material for the leads' weeks 3–4 and passes no threshold.
- `evals/LOADING.md` is the staging load runbook (T-315). `evals/retrieval/` and `evals/verification/`
  belong to T-114 / T-212 / T-215 / T-216.

## Data rule

Everything in `drafts/` is synthetic: `SYNTH-*` fixture ids, `synth-*` project keys, invented figures and
dates. No client document, client identifier, quoted document sentence or secret may be committed here
(AGENTS.md §4.6, §4.7, §4.8). Fixtures are machine-generated from the human-review workbook the leads
annotate, so the two stay in sync.
