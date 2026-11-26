# ADR-0010 Eval case format: refusal key, drafted evidence, and M1 chunk-only citations

Status: **accepted** — records the supervisor's rulings on [#84](https://github.com/TerraOI/TerraOI/issues/84) and [#137](https://github.com/TerraOI/TerraOI/issues/137) (2026-11-09). The schema and validator land in the same PR as this file: `src/contracts/eval-case.ts`, `docs/contracts/eval-case-format.md`, and the draft mechanical fixes under `evals/`.
Plan refs: §14.1 (case workflow), §6.1 (Evaluation group), §6.2 (data-class propagation), §10.1 (no tool calls in M1), TOI-ADR-17
Deciders: supervisor (#84, #137), Lane 2 (implementation) · Date: 2026-11-20

## Context

T-315 committed 114 drafted cases under `evals/*/drafts/` against a proposed prose layout in `docs/contracts/eval-case-format.md`. No `EvalCase` schema existed in `src/contracts/`, so a typo or a contradicted rule failed no test. #137 audited four defects that would block T-312 scoring:

1. `expectedEvidence` was both "`[]` in a draft" and "≥ 1 when `citationRequired`" — a validator could not implement both.
2. Three drafts expected `record_fact` claims, but M1 document-QA evidence is `chunk` only (pass 1 refuses `record` / `form_field`).
3. Two drafts declared `dataClass: "restricted"`, which M1 cannot ingest or embed.
4. Thirty-eight refusal drafts needed an `expectedRefusalKey` so F35 can score which refusal sentence the run showed — `Answer.refusalKey` already exists (ADR-0009); the case file had nowhere to state the expectation.

## Decision

**1. `expectedEvidence` is status-discriminated.** While `status` is `drafted`, the array is exactly `[]`. In an `approved` export, when `citationRequired` is `true`, the array has at least one entry. Binding happens at approval against the live corpus; drafts name synthetic fixtures only.

**2. M1 evidence for document-QA cases is `chunk` only.** `expectedEvidence[]` entries are the `chunk` member of `EvidenceRef` without `quotedText` in committed files (provenance: AGENTS.md §4.7). Do not widen §3 for `record` or `form_field` in M1. `UAV-E013`, `UAV-E022` and `GPR-E012` are restated as `source_fact` (or rejected) at review, not by editing drafts here. T-301 owes no document-eval coverage in M1.

**3. The two `restricted` drafts (`UAV-E046`, `GPR-E046`) are rejected at review.** Capture refusal for `restricted` is already proved by `isIngestibleInM1` and knowledge pgTAP; an eval case that can never bind adds nothing.

**4. `expectedRefusalKey`.** One of `no_evidence`, `insufficient_support`, `out_of_scope`, `unavailable` (same enum as `Answer.refusalKey` / ADR-0009). Required exactly when `expectedAnswerStatus` is `refused` or `unavailable`, and absent otherwise. Pairing: `unavailable` goes with status `unavailable`; the other three go with `refused`. F35 scores the key as its own dimension against `Answer.refusalKey`.

**5. Contract enums land here.** `CaseType` and `AdversarialClass` move from plan prose into `src/contracts/eval-case.ts`. Mechanical draft fixes authorized by #137 (site labels → `SYNTH-SITE-*`, `UAV-E013` fixture list, unresolved-project data class) ship in the same PR.

## Consequences

- `docs/contracts/eval-case-format.md` becomes **accepted**; a Vitest suite parses every JSON under `evals/<expert>/` and `evals/<expert>/drafts/`.
- Later T-312 PRs (SQL, runner, nightly workflow) consume this schema; they do not redefine it.
- Reviewer restatements / rejections stay in the review view (FAQ-0007); this PR does not rewrite claim types or delete the `restricted` drafts.

## Alternatives considered

- **Widen §3 for `record` / `form_field` in M1.** Rejected (#137): pass 1 refuses those kinds, and plan §10.1 rules out tool calls in M1. The packet that makes record/form evidence answerable widens §3 with its own ADR.
- **Score refusals on `expectedAnswerStatus` alone.** Rejected (#97 / #137): a wrong-but-safe refusal would pass.
- **Convert the `restricted` cases into guard cases.** Rejected: capture guards already exist where they belong.
