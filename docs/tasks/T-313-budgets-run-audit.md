# T-313 Budgets and rate limits (F19) and the run audit (F22)

Lane: 2 · Week: 3 · Protected: yes (`supabase/migrations/`, `src/platform/gateway/` reservation seam) · Depends on: T-115 (a merged as #31 — config/clearance/circuit; b/c/d open as #53/#56/#58, and b carries the F19 metering), T-104 (unclaimed — its migration creates `agent_runs`), T-215 (not started), T-111 (merged) · Status: ready
Gated by decisions: [#45](https://github.com/TerraOI/TerraOI/issues/45), [#68](https://github.com/TerraOI/TerraOI/issues/68) (the stage idempotency key the contract names does not exist), [#46](https://github.com/TerraOI/TerraOI/issues/46) (no `verify` adapter until T-215, so verify spend is currently unreachable)
Plan refs: §12.3 (budget authority + M1 budget scope), §17.1 (audit and chain observability), §16 (Budget/provider row), §14 ("no admitted budget reservations exceeding the ceiling"), §9.4, §15.0 ("Budget: daily/monthly ceiling + burst limit"), §18.3 (ceilings not yet named); F19, F22 (callers: F20 = F31 + F38)

## Goal
Spend becomes an enforced, auditable fact instead of an estimate. Before **every** billable phase —
compose, each verify, condense, route, ingestion — the gateway takes an atomic reservation for the
conservative maximum against the tenant's account; a per-user burst limit and a per-tenant concurrent-run
cap protect the endpoint; free tiers are metered in units so allowance exhaustion is predicted rather
than discovered by a 429. And every run's audit row — expert and prompt versions, corpus generation,
chain positions, verifier outcome, reservations and usage — is persisted **before** the answer is
delivered, with the deterministic ledger kept separate from any content-rich review view.

## Owns (may edit)
- `src/platform/budgets/` (accounts, reservations, reconciliation, admission), `src/platform/audit/`
  (the append-only run/attempt ledger writers and the read guard)
- `src/platform/gateway/` **only** at the reservation seam T-115 opened (config/route/circuit are already
  on `main`); anything deeper is requested through
  [COORDINATION.md §2](../../docs/COORDINATION.md)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_budgets_audit.sql`: budget accounts, reservations,
  usage entries and the run/attempt audit tables — timestamp agreed in the daily sync; merged migrations
  are never edited
- `supabase/tests/database/095_budgets_and_run_audit.test.sql`, `src/platform/budgets/*.test.ts`,
  `src/platform/audit/*.test.ts`

## Must not edit
`src/contracts/`; merged migrations; `src/platform/chat/` (delivery decides what the employee sees, and
the audit-before-deliver order is asserted there); `src/app/` and `src/components/` (any admin spend view
is Lane 1); `workers/`/`localbox/`; KV/cache counters are an admission **optimization** only and never
the authority for a ceiling (§12.3).

## Contract
F19 `reserveBudget`: org/run/attempt + maximum liability → atomic reservation; concurrency- and
retry-safe, **fail closed** if the reservation authority is unavailable, and covering
ingestion/verifier/fallback cost, not just chat (§11, §12.3). Release only when no in-flight liability
remains, and an ambiguous timeout counts as potentially billed. M1 scope is exactly §12.3's: per-tenant
daily and monthly ceilings, atomic reservation per chain attempt, per-user burst limit, per-tenant
concurrent-run cap, free tiers metered in units with the next paid tier reserved before it is called.
F22 `commitRunResult`: persist audit and result before delivering content; reconcile ambiguous spend.
Traced fields are §17.1's list; provider/model identity and the matrix revision used go to the audit and
**never** into [`Answer`](../../src/contracts/answer.ts) or a progress event
([`chat.ts`](../../src/contracts/chat.ts) keeps a closed enum for exactly that reason).
Rules: [docs/contracts/model-chain.md](../../docs/contracts/model-chain.md) ("Cost control (F19)").
**Two things owed, not decided here:** (1) [#45](https://github.com/TerraOI/TerraOI/issues/45) — where
`model_providers` / `provider_routes` / `tenant_provider_policy` / `provider_health` live; a per-tenant
budget account and those rows are the same configuration question, and quota-window decisions depend on
it. (2) the doc defect that this requirement is labelled **F40** in
[model-chain.md:62](../../docs/contracts/model-chain.md) and
[`provider-route.ts`](../../src/contracts/provider-route.ts), while plan §11 stops at F38 — this packet
assumes the *requirement* (audit the matrix revision) and files nothing; the label is the supervisor's.
(3) the numbers themselves (daily/monthly ceilings) are a Company1 input, §18.3/§20.8.
**Known defect to respect:** on the in-flight chain (PR #53) `attemptIdOf` collides for per-claim verify
calls and the compose retry, so an attempt key of `(run, task)` would double-book or under-book. The
attempt key here must be unique per (run, task, claim or pass, attempt).

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/095_budgets_and_run_audit.test.sql` — a reservation for the
      conservative maximum (input + output + retry + fallback) precedes the call, usage reconciles
      against it, and the unused amount is released only when no in-flight liability remains
- [ ] positive: the audit row is written before the final frame — assert the order through
      [T-104](./T-104-chat-skeleton.md)'s stream test, not through internals — and it carries expert and
      prompt versions, corpus generation, chain positions, tier answered and the matrix revision
- [ ] positive: free-tier calls are metered in units at zero cash cost, and exhausting the allowance
      reserves the next paid tier **before** calling it (§12.3's stated M1 behavior)
- [ ] negative: N concurrent runs at the ceiling admit exactly the allowed number — one reservation wins
      atomically, the rest refuse — and no admitted reservation exceeds the ceiling (§14)
- [ ] negative: tenant A's exhaustion never blocks, books or reads tenant B's account; another tenant and
      a `suspended` membership read no budget or audit row at all
- [ ] negative: an audit or spend admin view shows amounts, chain positions and failure classes but not
      prompt bodies, document text or signed URLs (§6.2: append-only audit ≠ every admin reads every prompt)
- [ ] negative: a retry after an ambiguous timeout keeps the first reservation billed and books the retry
      as its own attempt; duplicate outbox/queue events do not double-book (the live stage idempotency key
      is `ingestion_jobs`' unique key at [`20261105070000_knowledge_core.sql:398`](../../supabase/migrations/20261105070000_knowledge_core.sql), not the `ingestion_stage_runs` constraint that [#68](https://github.com/TerraOI/TerraOI/issues/68) reports the contract citing)
- [ ] failure: the reservation authority is unavailable → the run fails closed with `unavailable`, never
      "allow and hope"; a failed audit write after a provider call retains the reservation, recovers the
      run and delivers nothing unaudited; a crashed worker's reservation expires per the documented rule

## Done evidence
`pnpm verify`; `pnpm db:test` (CI `database` job — no Docker on this machine); staging: ask one question
as `owner1@company1.test` and paste the audit row with its reservations and tier sequence, then show the
same tenant at its ceiling refusing a new run while the company2 host still runs, and confirm no provider
name appears in the employee UI.

## Out of scope
The full ledger reconciliation UI (§15.0 defers it), provider-account dashboards and alerts (T-405),
per-tenant fair scheduling for ingestion beyond the caps named in M1, currency/timezone reconciliation
with provider invoices, KV counters as the ceiling authority, and the spend numbers themselves (a Company1
input, plan §20.8).
