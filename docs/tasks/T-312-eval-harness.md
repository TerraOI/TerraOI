# T-312 Eval harness (F34–F36): CI subset on PRs, full set nightly on staging

Lane: 2 · Week: 3 · Protected: yes (`supabase/migrations/`, `.github/` is not this packet's) · Depends on: T-111 (merged), T-113 (unclaimed — unblocked on the pin by the #6 engineering decision), T-114 (unclaimed), T-104 (unclaimed), T-311 (same week: an expert version to run) · Status: ready
Plan refs: §14.1 (workflow + pilot-entry thresholds), §14 (measure table), §6.1 (Evaluation group), §15.2 (M1-PILOT gate), §16 (Retrieval/Model chain rows), §20.3; F34, F35, F36 (TOI-ADR-17)

## Goal
An expert version is only as good as its approved case set. This packet lands the harness: F34 drafts
candidate cases from published collection versions (marked `agent_drafted`, and never drafted from a
collection the reviewing expert cannot read), F35 runs the **approved** set in deterministic order and
scores every case with its evidence and a failure class bound to the corpus generation, and F36 refuses
to publish an expert version that has not passed the §14.1 thresholds, keeping the previous version
selectable for rollback. A fast subset runs on PRs; the full set runs nightly on staging.

## Owns (may edit)
- `src/platform/evals/` (drafting, runner, scoring, thresholds, failure classes), `src/platform/evals/*.test.ts`
- `evals/` — the per-expert layout (`evals/uav-expert/`, `evals/gpr-expert/`), **and an `evals/README.md`**
  (REPO-STRUCTURE requires a README in every browsable top-level folder; `evals/` does not exist yet)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_evals.sql`: `eval_cases`, `eval_reviews`,
  `eval_runs`, `eval_results` per plan §6.1, plus the scoped RPCs — timestamp agreed in the daily sync;
  merged migrations are never edited
- `supabase/tests/database/090_eval_cases_and_runs.test.sql`; the `pnpm eval:ci` / `pnpm eval:nightly`
  script entries in `package.json` (shared root config — coordinate the change in the daily sync)

## Must not edit
`.github/` — the **scheduled nightly workflow is a supervisor PR** ([#74](https://github.com/TerraOI/TerraOI/issues/74)
asks who schedules it), this packet only ships the command it
calls (AGENTS.md §6: `.github/` is protected and no packet owns it); `src/contracts/`; merged migrations;
`src/app/` and `src/components/` (the review page is [T-303](./T-303-eval-review-view.md));
`supabase/seed.sql` with anything other than synthetic cases (AGENTS.md §4.7).

## Contract
Tables and their fields come from plan §6.1 (`eval_cases` with origin
`agent_drafted | expert_written | pilot`, `eval_reviews` with reviewer/decision/edits, `eval_runs` with
expert version + chain + corpus generation, `eval_results` with per-case score and failure class). F35's
acceptance line is the contract: deterministic case order, per-case evidence and failure class, results
bound to the corpus generation. F34's is: drafts only, marked `agent_drafted`, unusable until an eligible
expert approves, and **F35 ignores unapproved cases**. F36 refuses publication without a passing run at
§14.1's thresholds — ≥40 approved cases per expert (≥10 must-refuse/clarify, ≥5 cross-tenant/project
bait), 100% isolation/bait pass, zero displayed unsupported normative claims, ≥80% correct useful answers
and ≥85% Recall@10 — recording which tier answered so a cheap tier with poor quality is visible.
Every eval run is a **real** gateway call: same clearance, same reservation, no bypass
([docs/contracts/model-chain.md](../../docs/contracts/model-chain.md), AGENTS.md §4.3/§4.4).
**Assumed:** [T-311](./T-311-expert-definitions.md) registers the two v1 experts; they are *selectable*,
not *published*, until this packet's F36 gate can pass.

## Acceptance tests (write first)
- [ ] positive: `src/platform/evals/run.test.ts` — the same inputs produce the same case order, and the run row
      names the expert version, chain configuration and corpus generation it was measured against
- [ ] positive: `supabase/tests/database/090_eval_cases_and_runs.test.sql` — one run row per execution with one
      result per case carrying a failure class; a rerun writes a new run and never edits the old one
- [ ] positive: F34 drafts land as `agent_drafted` with expected source version and locator, excluded from
      scoring until an eligible reviewer approves them
- [ ] negative: a `client_confidential` case produces **zero** DeepSeek/OpenRouter calls in the mock (§16), and
      an eval run never widens `narrowClearance` to make a case runnable
- [ ] negative: cases drafted from a collection the reviewing expert may not read do not exist for them; a
      company1 case never appears in company2's set and an id from another tenant returns no row; an approval
      by a `suspended` membership or by someone not entitled to the expert's collections is not valid, and its
      case stays out of the scored set; isolation and bait cases must show the expert **refusing**, not an
      absent answer, which scores as a failure
- [ ] failure: a provider outage mid-run is an infrastructure failure class, never a zero that would push tuning
      the wrong way; a corpus generation that changed mid-run discards the run; F36 refuses publication when any
      threshold or the approved count is short and the previous expert version stays selectable; a case whose
      expected source was revoked (T-213) re-queues for review instead of silently scoring zero

## Done evidence
`pnpm eval:ci` subset output in the PR; `pnpm verify`; `pnpm db:test` (CI `database` job — no Docker on
this machine); staging nightly: the run row with per-case scores and the tier that answered, plus the
threshold table from §14.1 pasted with the case counts still short, exactly as they stand.

## Out of scope
The reviewer UI (T-303), the corpus load and the first drafted cases (T-315), tuning prompts/chunking
until the thresholds pass (T-403), dashboards and alert thresholds (T-405), reranking experiments, and
the scheduled workflow file itself (`.github/`, supervisor PR — see Must not edit).
