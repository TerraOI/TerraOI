# TerraOI state (checkpoint)

**Status:** baseline done; integration branch green on every locally runnable check.
**Branch:** `terraoi/build` (local; remote push via GitHub API, see TOI-011).
**Current task:** TOI-005 harness commit → TOI-011 push → TOI-006 (T-303 eval review view).

## Evidence
See [TerraOI-todo.md](TerraOI-todo.md) baseline table and [TOI-001](TerraOI-tasks/TOI-001-integration.md).

## Blockers
Owner-only: merges/approvals (Q-01), staging/production accounts and Company1 approvals (Q-06).

## Exact next action
Commit TOI-005; push branch; open draft PR; then implement T-303 under `src/app/(tenant)/evals/` + `src/components/evals/` against `src/platform/evals/{list-eval-cases,review-eval-case}.ts`.
