# TerraOI state (checkpoint)

**Status:** integration branch green on every locally runnable check; T-303 built (VERIFY).
**Branch:** `terraoi/build` (local only — GitHub is read-only from this session, Q-07).
**Current task:** TOI-008 (T-302 feedback + save-as-knowledge UI) next.

## Latest evidence (terraoi/build)
lint pass · typecheck pass · unit 189 files / 2108 tests pass · pgTAP shim 35 files / 1694 pass · structure/docs pass · webpack build (font mock) compiles incl. /evals routes.

## Blockers
Owner-only: merges/approvals (Q-01), GitHub write (Q-07), staging/production + Company1 approvals (Q-06).

## Exact next action
Read T-302 packet + T-302b routes (`src/app/api/knowledge/submissions`, `src/platform/knowledge/submission-*`) on this branch; build the four answer controls and the reviewer queue screen; the rating table needs a migration (`085_chat_feedback`).
