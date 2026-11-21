# Pilot feedback → eval cases (plan §14.1 step 5, #102)

**Status of this runbook: prepared; the buttons and the draft RPC are not on `main` yet.** [T-302](../tasks/T-302-feedback-save-knowledge.md) / [T-302b](../tasks/T-302b-knowledge-submissions.md) and the `#102` drafting path are still behind T-104 and friends. This file states the loop so week 4 does not invent a second one when those packets land.

**Data rule:** `expectedEvidence` is a **locator**, never quoted client text. Precedent: [#114](https://github.com/TerraOI/TerraOI/pull/114) removed two quoted payloads from drafted eval cases and raised understated data classes. The same rule applies to every draft this loop produces (AGENTS §4.7; §6.2 propagation).

## The loop, as steps

| # | Step | Who | Packet / ruling |
|---|---|---|---|
| 1 | Employee marks an answer **Incorrect** or **Suggest correction** | Employee | [T-302](../tasks/T-302-feedback-save-knowledge.md) — chat text never becomes company fact automatically (F15) |
| 2 | System opens a knowledge-submission / feedback row, not a published source | `AGENT` (the path T-302/T-302b owns) | [T-302b](../tasks/T-302b-knowledge-submissions.md) |
| 3 | A draft eval case is created with `draft_eval_case_from_feedback_v1` (name as #102 settles it) carrying a source **locator** | `AGENT` | [#102](https://github.com/TerraOI/TerraOI/issues/102): pilot cases count toward the **exit** report, not the §14.1 entry threshold |
| 4 | Eligible reviewer approves or rejects | `OWNER`-named UAV/GPR reviewer (D-6) | [T-303](../tasks/T-303-eval-review-view.md); approval is a domain-expert act (§14.1, §20.8) |
| 5 | Next F35 / nightly run picks up **approved** cases only | `AGENT` (T-312 harness) | [T-312](../tasks/T-312-eval-harness.md); draft rows must be ignored until approval |

## What "done" looks like for one rehearsal cycle

1. One "Suggest correction" on a **synthetic** staging tenant produces a `draft` case.
2. The case carries a locator (collection / source version / chunk id shape as the contract requires) and **zero** quoted client sentences.
3. The next F35 run's result set does not treat that draft as scored until an eligible reviewer sets `approvedBy` / `approvedAt`.
4. The register row cites the run ids and labels the cycle Observed or Planned with the named blocker.

## Entry vs exit (do not collapse these)

| Gate | What pilot feedback counts for |
|---|---|
| §14.1 **entry** (≥40 approved, bait quotas) | **Not** these drafts — #102 |
| §14 **exit** (≥30 completed pilot cases / expert over ≥2 weeks) | Yes — clock starts **after** M1-PILOT (§14), not during week-4 rehearsal |

## Owner-step table

| Owner step | Blocker | Notes |
|---|---|---|
| Name UAV/GPR reviewers | D-6 | Without names, step 4 is not runnable |
| Confirm pilot drafts stay out of entry threshold | #102 (recorded) | Do not re-litigate into entry counts |
| Real employees in the loop only after M1-PILOT | D-11 | Rehearsal stays synthetic |

## Stop conditions

- A draft case would need to embed document prose to be useful → **stop**; store a locator and file a `needs-contract` if the locator shape is missing.
- Chat feedback is being written straight into a published collection → **stop**; that skips T-302b and F15.
- Scoring includes `draft` rows → **stop**; fix T-312 / the scorer, do not "make the number look better".
