# TerraOI state (checkpoint)

**Status:** integration branch green on every locally runnable check; T-303 built (VERIFY).
**Branch:** `terraoi/build` (local only — GitHub is read-only from this session, Q-07).
**Current task:** TOI-009 (T-402 agent-side red-team tests) next.

## Latest evidence (terraoi/build)
lint pass · typecheck pass · unit 194 files / 2136 tests pass · pgTAP shim 36 files / 1716 pass · structure/docs pass.

## Blockers
Owner-only: merges/approvals (Q-01), GitHub write (Q-07), staging/production + Company1 approvals (Q-06).

## Exact next action
Read T-402 packet; add bait tests (cross-tenant/project ids, injected instructions in documents, forged chat history) against the integrated tree; fix what fails.
