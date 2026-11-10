# T-115 Gateway skeleton: route selection, clearance filter, compose, verifier pass 1

Lane: 2 · Week: 1 · Protected: yes (`src/platform/gateway/`) · Depends on: T-002, T-111 · Status: in progress (wyuinline) — all four parts are now on `main`: **a** as [#31](https://github.com/TerraOI/TerraOI/pull/31), **b** as [#53](https://github.com/TerraOI/TerraOI/pull/53), the fix that belongs between `b` and `c` as [#76](https://github.com/TerraOI/TerraOI/pull/76) at `f6d9a9f` (the `invalid_request` failure class per plan §12.4 chain-walking rule (b), the per-call Workers AI account-token read, and the adapter-seam plus import-boundary tests), and **c** (verifier pass 1, `src/platform/gateway/verify-binding.ts`) and **d** (`src/platform/agents/compose.ts`) as [#56](https://github.com/TerraOI/TerraOI/pull/56) and [#58](https://github.com/TerraOI/TerraOI/pull/58). `main` only received `c` and `d` through [#113](https://github.com/TerraOI/TerraOI/pull/113) on 2026-11-08: #56 and #58 were based on a feature branch, so both read "MERGED" while their commits sat off `main`. Every part is re-confirmed with `git merge-base --is-ancestor`, not PR state, against `main` at `c7e7e8d`, where CI, `Main guard` and `Deploy staging` are green. Not claimed: the staging Done-evidence below (kill-the-box run and the external mock probe), which is the question in [#92](https://github.com/TerraOI/TerraOI/issues/92); the two rulings this chain now needs, [#95](https://github.com/TerraOI/TerraOI/issues/95) (which index space `startChar`/`endChar` count in, and whether the quoted span comes from the packed or the body text) and [#97](https://github.com/TerraOI/TerraOI/issues/97) (the refusal copy vocabulary); and the Claude adapter, now slice **T-115f** below by the [#46](https://github.com/TerraOI/TerraOI/issues/46) ruling (not started)
Plan refs: §12.1 (pass 1), §12.3, §12.4 (chain walking), §10.1; F20 (=F31+F38), F31, F38, F19 (reserve only)

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Loopback harness** ([#92](https://github.com/TerraOI/TerraOI/issues/92), COORDINATION.md §6a): one listener per provider base URL; a `client_confidential` request leaves zero requests on the DeepSeek, OpenRouter and Workers AI listeners, the allowed listener receives the payload, and each adapter's built base URL is covered. The kill-the-box run is T-314's drill ([#74](https://github.com/TerraOI/TerraOI/issues/74)); the external-mock probe is re-run on staging in the same session.
- **Citation spans** ([#95](https://github.com/TerraOI/TerraOI/issues/95)): one Lane 2 PR — ADR-0008; the model cites `chunkId` + exact `quotedText` only; pass 1 derives the span (first exact occurrence in `body_text`, UTF-16 units); `ChunkEvidence.quotedText` required; tests for a non-BMP crossing quote and a quote from the second chunk of a rendered pack.
- **Refusal vocabulary** ([#97](https://github.com/TerraOI/TerraOI/issues/97)): one Lane 2 PR — ADR-0009; `refusalTemplates` gains required `insufficient_support`; compose selects `no_evidence` for an empty pack and `insufficient_support` when evidence existed but no claim survived. The same PR adds an optional `refusalKey` to `Answer` (`src/contracts/answer.ts`, the four keys), set exactly when `status` is `refused` or `unavailable`, with its contract test, recorded in ADR-0009 ([#137](https://github.com/TerraOI/TerraOI/issues/137)).
- **Truncation** ([#87](https://github.com/TerraOI/TerraOI/issues/87)): `finishReason` gains `"unknown"`; Workers AI returns it until a recorded staging response fixture proves its field; `unknown` at the output cap is handled as `length`, under the cap a parse failure is `possibly_truncated`; every attempt records `truncationReported`.

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

## T-115f Claude adapter (added 2026-11-08 by the #46 ruling)
Without it the week-1 demo ("a cited, verified answer") cannot run: `verify` starts at Claude (#9), so
every answer would degrade to `partial`. Small slice, same Owns as above.
- The adapter goes in `src/platform/gateway/adapters`, behind the existing import-boundary guard. No
  Anthropic SDK or HTTP call outside `src/platform/gateway/`.
- **The clearance filter decides** what reaches Claude. This slice does not relax clearance: a data
  class not cleared for `claude` still never leaves.
- The credential is read per call from a Worker secret, like the Workers AI token (`4dd0501`). Tests
  use an injected fake and never a real key.
- Acceptance: a `verify` call for a cleared class reaches the fake Claude adapter and is metered; an
  uncleared class never reaches it; a missing secret is `unavailable`, never a crash or a logged key.
- **Human step (§20.8, owner):** Anthropic account, spend limit, and the API key as a `wrangler secret`
  on staging ([T-004](./T-004-infrastructure.md)). Agents never handle the key.

## Out of scope
DeepSeek/OpenRouter adapters and passive health checks (T-314), budgets and rate limits as a
feature (T-313), verifier pass 2 and compose retry on the next tier (T-215), reranking.
