# T-314 DeepSeek and OpenRouter adapters, provider health checks (F37) and circuit breakers

Lane: 2 · Week: 3 · Protected: yes (`src/platform/gateway/`) · Depends on: T-115 (a merged as #31 — config/clearance/circuit; b/c/d open as #53/#56/#58, and b is the fetch adapters plus chain walking), T-215 (not started — it owns the Claude adapter, see #46), T-311 (same week: `route` chains that reach these tiers), T-313 (same week: quota-window signal) · Status: ready
Gated by decisions: [#45](https://github.com/TerraOI/TerraOI/issues/45), [#46](https://github.com/TerraOI/TerraOI/issues/46), [#74](https://github.com/TerraOI/TerraOI/issues/74) (nobody owns the week-3 box-offline drill this packet's Done evidence is), plus the model-selection finding posted on PR #53 (not an issue)
Plan refs: §12.4 (chain rows 4–5 and the clearance matrix), §16 (Model chain row), §17.1 (chain observability; box offline within one check interval), §13 (local-box contract), §15.0, §18.2 ("Client data reaches an uncleared provider"); F37, F31, F38, F20

## Goal
The two cheapest cloud fallbacks become real, and health becomes something the platform knows instead of
something it discovers mid-answer. DeepSeek and OpenRouter adapters join the gateway's provider list —
**`public` data only by default**, with OpenRouter's upstream models pinned — and F37 runs scheduled plus
passive (error-rate) checks so an offline local box, an exhausted Workers AI allowance or a 429 storm
opens a circuit, skips that position for the rest of the window, and closes only after a cooldown and a
successful check. §20.3's week-3 drill with the local box offline is measured against this packet.

## Owns (may edit)
- `src/platform/gateway/` — the `deepseek` and `openrouter` fetch adapters, the F37 checker (scheduled
  probe plus passive error-rate signal), circuit persistence and the health snapshot reader, with
  `src/platform/gateway/*.test.ts`
- `localbox/` **notes only** for the health-endpoint probe shape — no credentials in the repo (§4.6)
- **only if #45 assigns them here**: one migration
  `supabase/migrations/YYYYMMDDHHMMSS_provider_health.sql` (`provider_health`, §6.1) plus
  `supabase/tests/database/105_provider_health.test.sql` — timestamp agreed in the daily sync

## Must not edit
`src/contracts/` ([`PlatformProvider`, `PLATFORM_DEFAULT_CLEARANCE`, `TaskClass`,
`DEFAULT_TASK_CHAIN_ORDER`](../../src/contracts/provider-route.ts) are merged; a change needs an ADR);
`src/platform/chat/`, `src/app/`, `src/components/` (no provider name is employee-visible);
`workers/` and `localbox/` code (the box's processes are T-211's and the owner's, §20.8); the Claude
adapter (T-215's unless #46 rules otherwise); merged migrations; and no provider SDK outside
`src/platform/gateway/` (AGENTS.md §4.3).

## Contract
`PlatformProvider` rows for `deepseek` and `openrouter` carry `maxClearedClass: "public"`, matching
[`PLATFORM_DEFAULT_CLEARANCE`](../../src/contracts/provider-route.ts): a config row wider than the matrix
is refused at load, and `narrowClearance` still has no widening parameter (§12.4). Chain walking is
F31 + F38: build the eligible list, drop what is uncleared, unhealthy, in an open circuit, out of quota,
below the task's minimum tier, or (for `verify`) the model that composed the answer; call the first
remaining; advance on connection failure, timeout, 429, 5xx, context overflow or invalid structured
output; an empty list is `unavailable`; **never** relax data policy to find a provider. F37 is the health
contract: provider key → health, latency, quota window and circuit state, scheduled **and** passive, with
the box detected offline **within one check interval**. Employee-visible wording stays the closed enum
[`TierChangeReason`](../../src/contracts/chat.ts); provenance rules:
[docs/contracts/model-chain.md](../../docs/contracts/model-chain.md).
**Owed:** **#45** — with no `model_providers`/`provider_routes`/`provider_health` tables, circuit and quota
state live in a Worker isolate and die on restart, so the persistence half is unowned until the supervisor
schedules it; **#46** — Claude, the `verify` chain's first real provider, has no adapter until T-215, so
`partial` stays the honest M1 outcome. **Finding posted on PR #53, not an issue:** the chain selects a
verifier model (`route.ts:193-207`) that the call path (`call.ts:285-292`) never passes to the adapter,
which hard-codes its own endpoint model (`adapters.ts:170,195,261`), so §12.4 rule (e) holds at selection
only. This packet assumes each adapter is called **with** the selected model and refuses an attempt whose
selected model is not the one contacted. The rule-(e) fix is **assigned to PR #53** (T-115b, the gateway
chain), where it must be proven at the adapter call boundary — this packet does not touch chain selection.

## Acceptance tests (write first)
- [ ] positive: `src/platform/gateway/adapters-external.test.ts` — `deepseek` and `openrouter` answer a
      `public` payload at their chain positions, each attempt reserved (F19 seam) and audited with the tier
      that answered
- [ ] positive: `src/platform/gateway/health.test.ts` — a box that stops answering is offline within one check
      interval and its chain entries are skipped without waiting for a user-visible timeout; a circuit opens
      after repeated failures and closes only after the cooldown **and** a successful health check (§16)
- [ ] negative: a `client_confidential` or `restricted` payload produces **zero** DeepSeek and OpenRouter
      calls in the mock, whatever ids or tenant policy the caller passes (§16, §18.2)
- [ ] negative: an OpenRouter request never reaches an upstream model outside the pinned allow-list, and a
      provider config row wider than the clearance matrix is refused at load
- [ ] negative: an open circuit skips that provider for every tenant until it recovers, and no tenant setting,
      header or expert chain re-opens a provider the platform took out
- [ ] failure: 200-with-garbage advances as `output_rejected` rather than crashing; an exhausted allowance
      reads as `quota_exhausted` before a 429 arrives; a health endpoint that fails authentication reads as
      offline; no employee-visible string names a provider or model, and no secret appears in a health log

## Done evidence
`pnpm verify`; the staging drill §20.3 puts in week 3: take the tunnel down, show F37 marking the box
offline within one interval, the chain advancing with the reason recorded, and OCR jobs waiting in
`extracting` as "queued for OCR" (T-211); restore it and show the circuit closing; plus the
`client_confidential` probe recording zero DeepSeek/OpenRouter calls.

## Out of scope
Budgets, ceilings and rate limits as a feature (T-313), the Claude adapter (#46, T-215), box hardware,
model server, tunnel and Access token (§20.8 human-only), dashboards and alert thresholds (T-405),
reranking or alternative embeddings, connector health checks (§7.3, after M1), and anything that would
widen the clearance matrix — that is a recorded tenant decision and a supervisor call.
