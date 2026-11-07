# T-313 Budgets and rate limits (F19) and the run audit (F22)

Lane: 2 · Week: 3 · Protected: yes (`supabase/migrations/`, `src/platform/gateway/` reservation seam) · Depends on: T-115 (a merged as #31 — config/clearance/circuit; b/c/d open as #53/#56/#58, and b carries the F19 metering), T-104 (unclaimed — its migration creates `agent_runs`), T-215 (not started), T-111 (merged) · Status: ready
Gated by decisions: [#45](https://github.com/TerraOI/TerraOI/issues/45), [#68](https://github.com/TerraOI/TerraOI/issues/68) (the stage idempotency key the contract names does not exist), [#46](https://github.com/TerraOI/TerraOI/issues/46) (no `verify` adapter, so verify spend is unreachable today)
Plan refs: §12.3 (budget authority and M1 scope), §17.1 (audit, chain observability), §16 (Budget/provider row), §14 ("no admitted budget reservations exceeding the ceiling"), §9.4, §15.0, §18.3; F19, F22 (callers F20 = F31 + F38)

## Goal
Spend becomes enforced and auditable instead of estimated. Before **every** billable phase — compose, each
verify, condense, route, ingestion — the gateway takes an atomic reservation for the conservative maximum
against the tenant account; a per-user burst limit and a per-tenant concurrent-run cap protect the
endpoint; free tiers are metered in units so allowance exhaustion is predicted, not discovered by a 429.
Every run's audit row is persisted **before** the answer is delivered.

## Owns (may edit)
- `src/platform/budgets/` (accounts, reservations, reconciliation, admission) and `src/platform/audit/`
  (append-only run/attempt ledger writers and the read guard), with `*.test.ts` beside each
- `src/platform/gateway/` **only** at the reservation seam T-115a opened; anything deeper goes through
  [COORDINATION.md §2](../../docs/COORDINATION.md)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_budgets_audit.sql` (budget accounts, reservations,
  usage entries, run/attempt audit tables) and
  `supabase/tests/database/095_budgets_and_run_audit.test.sql` — timestamp agreed in the daily sync

## Must not edit
`src/contracts/`, merged migrations, `src/platform/chat/` (delivery decides what the employee sees and the
audit-before-deliver order is asserted there), `src/app/` and `src/components/` (any spend view is Lane 1),
`workers/`, `localbox/`. KV or cache counters are an admission optimization, never the authority for a
hard ceiling (§12.3).

## Contract
F19 `reserveBudget`: org/run/attempt + maximum liability → atomic reservation; concurrency- and retry-safe;
**fail closed** when the reservation authority is unavailable; covering ingestion, verifier and fallback
cost, not only chat. Release only when no in-flight liability remains, and an ambiguous timeout counts as
potentially billed. M1 scope is exactly §12.3's: per-tenant daily and monthly ceilings, an atomic
reservation per chain attempt, a per-user burst limit, a per-tenant concurrent-run cap, free tiers metered
in units with the next paid tier reserved before it is called. F22 `commitRunResult` persists audit and
result before delivering content and reconciles ambiguous spend; §17.1 lists the traced fields, and
provider/model identity and the matrix revision used go to the audit and **never** into
[`Answer`](../../src/contracts/answer.ts) or a progress event
([`chat.ts`](../../src/contracts/chat.ts) keeps a closed enum for that reason). Rules:
[docs/contracts/model-chain.md](../../docs/contracts/model-chain.md) ("Cost control (F19)").
**Owed, not decided:** #45 — a per-tenant budget account and the unowned provider-configuration tables are
one question, and the quota-window decision depends on it; the ceiling **numbers** are a Company1 input
(§18.3, §20.8). A doc defect to note rather than fix here: that audit requirement is labelled **F40** in
[model-chain.md:62](../../docs/contracts/model-chain.md) and in
[`provider-route.ts`](../../src/contracts/provider-route.ts), while plan §11 stops at F38. And on PR #53
`attemptIdOf` (`call.ts:178-181`) collides for per-claim verify and the compose retry, so an attempt key of
`(run, task)` would double- or under-book — the key here must be (run, task, claim or pass, attempt).

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/095_budgets_and_run_audit.test.sql` — the reservation for the
      conservative maximum (input + output + retry + fallback) precedes the call, usage reconciles against
      it, and the unused amount is released only when no in-flight liability remains
- [ ] positive: the audit row is written **before** the final frame — asserted through
      [T-104](./T-104-chat-skeleton.md)'s stream test, not internals — with expert and prompt versions, corpus
      generation, chain positions, tier answered and the matrix revision
- [ ] positive: free tiers are metered in units at zero cash cost, and exhausting an allowance reserves the next
      paid tier **before** calling it
- [ ] negative: N concurrent runs at the ceiling admit exactly the allowed number and no admitted reservation
      exceeds it (§14); tenant A's exhaustion never books, blocks or reads tenant B's account; another tenant or
      a `suspended` membership reads no budget or audit row; a spend view shows amounts, chain positions and
      failure classes but never prompt bodies, document text or signed URLs (§6.2)
- [ ] negative: a retry after an ambiguous timeout keeps the first reservation billed and books the retry as its
      own attempt, and duplicate outbox events do not double-book — the live stage key is `ingestion_jobs`'
      unique key at [`20261105070000_knowledge_core.sql:398`](../../supabase/migrations/20261105070000_knowledge_core.sql),
      not the `ingestion_stage_runs` constraint [#68](https://github.com/TerraOI/TerraOI/issues/68) cites
- [ ] failure: no reservation authority → `unavailable`, fail closed; a failed audit write after a provider call
      retains the reservation, recovers the run and delivers nothing unaudited; a crashed worker's reservation
      expires per the documented rule

## Done evidence
`pnpm verify`; `pnpm db:test` (CI `database` job — no Docker here); staging: one question as
`owner1@company1.test` with its audit row, reservations and tier sequence pasted, then that tenant at its
ceiling refusing a new run while the company2 host still runs, and no provider name in the employee UI.

## Out of scope
The full ledger reconciliation UI (§15.0 defers it), provider-account dashboards and alerts (T-405),
ingestion fair scheduling beyond the caps named in M1, invoice-level currency and timezone reconciliation,
and the ceiling values themselves (a Company1 input, plan §20.8).
