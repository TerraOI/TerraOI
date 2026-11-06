# T-115 Gateway skeleton: route selection, clearance filter, compose, verifier pass 1

Lane: 2 · Week: 1 · Protected: yes (`src/platform/gateway/`) · Depends on: T-002, T-111 · Status: in progress (wyuinline)
Plan refs: §12.1 (pass 1), §12.3, §12.4 (chain walking), §10.1; F20 (=F31+F38), F31, F38, F19 (reserve only)

## Goal
The only place a provider SDK is called. Given a task class and a payload's data class, it picks
the eligible chain in cost order, calls the first provider that answers, and refuses rather than
relaxing clearance. Compose and the deterministic first-pass verifier run on top of it.

## Owns (may edit)
- `src/platform/gateway/` (route selection, adapters for `local_box` and `workers_ai`, circuit
  state, compose, pass-1 verifier), `src/platform/agents/compose.ts`
- `src/platform/gateway/*.test.ts`, `src/platform/agents/*.test.ts`

## Must not edit
`src/contracts/` (chain and clearance shapes are fixed by T-002), any provider SDK import outside
`src/platform/gateway/` (a blocking finding), `src/platform/retrieval/`

## Contract
[`PlatformProvider`, `TaskClass`, `CapabilityTier`, `ClearanceMatrix`,
`PLATFORM_DEFAULT_CLEARANCE`, `narrowClearance()`, `chainFollowsPlatformOrder()`,
`EmbeddingIndex`](../../src/contracts/provider-route.ts) and
[`ExpertDefinition.modelChains`, `minVerifierTier`](../../src/contracts/expert-definition.ts),
[`Answer`, `Claim`, `EvidenceRef`](../../src/contracts/answer.ts).
Behavior rules: [docs/contracts/model-chain.md](../../docs/contracts/model-chain.md).

**M1 verifier order (#9):** the `verify` chain starts at **Claude** — the expert *drops* `local_box`
from that chain (the box is not a verifier until an F35 evaluation proves a different, adequate model
on it) but never reorders what remains: each task class has its own order in
`DEFAULT_TASK_CHAIN_ORDER` (`src/contracts/provider-route.ts`). Configuration, not a code branch, and
clearance is never relaxed to find a verifier.

## Acceptance tests (write first)
- [ ] positive: `public` compose walks local box → Workers AI and reports which tier answered
- [ ] negative: a `client_confidential` payload never reaches DeepSeek or OpenRouter, and never
      reaches Workers AI unless the tenant explicitly added it (which `narrowClearance` cannot do)
- [ ] negative: a `restricted` payload with the local box offline returns `unavailable` — it does
      not fall through to any cloud provider
- [ ] negative: for `verify` the first eligible provider is **Claude**, and no local-box verifier is
      selected before an F35-passing second model is configured on the box (#9)
- [ ] negative: `verify` never selects the provider that composed the answer, and never a tier
      below `minVerifierTier`; with no eligible verifier, `requirement` claims are withheld and the
      answer degrades to `partial`
- [ ] advance on connection failure, timeout, 429, 5xx, context overflow and invalid structured
      output; a circuit opens after repeated failures and closes after a successful health check
- [ ] every attempt is metered in units even on free tiers, and each attempt has a reservation
      before the call and a reconciliation after (ambiguous timeout counts as potentially billed)
- [ ] failure: no secrets in logs; provider names are absent from employee-visible output
- [ ] pass 1: a claim citing a chunk id that was not retrieved in this run, a span that does not
      exist in that chunk version, or a quoted text that is not verbatim → rejected

## Done evidence
`pnpm verify`; staging: kill the local box (or point the tunnel at nothing) and show the chain
advancing with the fallback recorded; `client_confidential` probe with a mock that records which
provider received the payload — DeepSeek/OpenRouter must show zero calls.

## Out of scope
DeepSeek/OpenRouter adapters and passive health checks (T-314), budgets and rate limits as a
feature (T-313), verifier pass 2 and compose retry on the next tier (T-215), reranking.
