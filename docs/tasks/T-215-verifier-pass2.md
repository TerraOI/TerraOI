# T-215 Verifier pass 2 (semantic entailment), Claude adapter, compose retry

Lane: 2 · Week: 2 · Protected: yes (`src/platform/gateway/`) · Depends on: T-115, T-114, T-113, T-104 · Status: ready
Plan refs: §12.1 (M1 two-pass verifier), §12.4 (chain walking, clearance), §9.3, §16 (model chain row); F20, F21, F31, F38

## Goal
Deterministic binding proves an answer's ids and spans exist; pass 2 proves the cited spans actually
**support** each claim. A different model at or above the expert's `minVerifierTier` judges each claim
from its claim text plus cited spans only, its verdict is recorded per claim, and a materially failing
composition gets exactly one retry on the next eligible tier before the answer degrades or refuses.

## Owns (may edit)
- `src/platform/gateway/` (`verify` task class, pass-2 entailment, Claude adapter, compose retry,
  per-tier outcome metrics), `src/platform/agents/verify.ts`
- `src/platform/gateway/*.test.ts`, `src/platform/agents/*.test.ts`, `evals/verification/` synthetic
  claim-and-span fixtures
- no SQL expected; if a chain or tier row needs one, it is a **new**
  `supabase/migrations/YYYYMMDDHHMMSS_<snake_name>.sql` (protected, timestamp from the daily sync)

## Must not edit
`src/contracts/` (statuses and verdicts are fixed by T-002), `src/platform/chat/` (delivery decides what
the employee sees), `src/app/`, `workers/`, `localbox/`, any merged migration

## Contract
[`TaskClass` `"verify"`, `CapabilityTier`, `PLATFORM_DEFAULT_CLEARANCE`, `narrowClearance()`,
`chainFollowsPlatformOrder()`](../../src/contracts/provider-route.ts) and
[`ExpertDefinition.modelChains`, `minVerifierTier`](../../src/contracts/expert-definition.ts); verdicts
land in [`Claim.verificationStatus`](../../src/contracts/answer.ts) (`supported | partial |
unsupported | contradicted`) and the whole answer in `Answer.status`
(`answered | partial | refused | unavailable`). Behavior:
[docs/contracts/model-chain.md](../../docs/contracts/model-chain.md) and
[docs/contracts/chat-protocol.md](../../docs/contracts/chat-protocol.md). No provider SDK anywhere
outside `src/platform/gateway/` (AGENTS.md §4.3).

## Acceptance tests (write first)
- [ ] positive: `src/platform/gateway/verifier-pass2.test.ts` — each claim is verified with **only** its
      claim text and cited spans (assert no other conversation turn is in the payload), and a
      `supported` verdict reaches the delivered answer
- [ ] negative: the provider that composed the answer is never selected for `verify`, and any tier below
      `minVerifierTier` is excluded; a `client_confidential` verify payload shows zero calls to
      DeepSeek and OpenRouter in the recording mock
- [ ] negative: an `unsupported` or `contradicted` claim is dropped and coherence re-checked; if dropping
      it changes the decision the answer comes back `refused`, not quietly shortened
- [ ] failure: no eligible verifier → `requirement` claims are withheld, the answer is `partial` with the
      limitation stated, and low-risk `source_fact` quotes that passed pass 1 may still appear
- [ ] failure: composition fails pass 2 materially → **one** retry on the next eligible compose tier
      (assert exactly two compose attempts), the second failure returns `refused` or `partial`, and no
      candidate text is streamed at any point
- [ ] failure: verifier output that is malformed or off-schema advances to the next provider instead of
      crashing; which tier composed and verified goes to the run audit, never into `Answer`

## Done evidence
`pnpm verify`; staging: ask a question needing a `requirement` claim with the local box offline,
capture the recorded chain (a compose tier and a different verify tier) and the per-claim verdicts from
the run audit, and show the employee-visible answer names no provider.

## Out of scope
DeepSeek/OpenRouter adapters, passive health checks and circuit tuning (T-314), budgets and rate limits
(T-313), reranking, evaluation scoring (T-312), expert prompt authoring (T-311), any relaxation of
clearance to find a verifier (never allowed, plan §12.4).
