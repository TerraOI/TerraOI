# T-215 Verifier pass 2 (semantic entailment), Claude adapter, compose retry

Lane: 2 · Week: 2 · Protected: yes (`src/platform/gateway/`) · Depends on: T-115, T-114, T-113, T-104 · Status: ready
Plan refs: §12.1 (M1 two-pass verifier), §12.4 (chain walking, clearance), §9.3, §16 (model chain row); F20, F21, F31, F38

## Goal
Deterministic binding proves an answer's ids and spans exist; pass 2 proves the cited spans actually
**support** each claim. A different model at or above `minVerifierTier` judges each claim from its claim
text plus cited spans only, and a failing composition gets one retry on the next eligible tier.

## Owns (may edit)
- `src/platform/gateway/` (`verify` task class, pass-2 entailment, Claude adapter, compose retry,
  per-tier outcome metrics), `src/platform/agents/verify.ts`; tests `src/platform/gateway/*.test.ts`,
  `src/platform/agents/*.test.ts`, `evals/verification/` synthetic claim-and-span fixtures
- no SQL expected; if needed, one **new** protected `supabase/migrations/YYYYMMDDHHMMSS_<snake>.sql`
  with the timestamp agreed in the daily sync

## Must not edit
`src/contracts/` (statuses and verdicts are fixed by T-002), `src/platform/chat/` (delivery decides what
the employee sees), `src/app/`, `workers/`, `localbox/`, any merged migration

## Contract
[`TaskClass` `"verify"`, `CapabilityTier`, `PLATFORM_DEFAULT_CLEARANCE`,
`narrowClearance()`](../../src/contracts/provider-route.ts): the chain guard is
`chainFollowsPlatformOrder(chain, DEFAULT_TASK_CHAIN_ORDER[task])`, so a `verify` chain is checked
against `DEFAULT_TASK_CHAIN_ORDER.verify` (Claude before Workers AI, lands with #19) while the flat
`DEFAULT_PLATFORM_CHAIN` is only the `compose` order.
[`ExpertDefinition.modelChains`, `minVerifierTier`](../../src/contracts/expert-definition.ts) validates
each chain against its own task's order; verdicts land in
[`Claim.verificationStatus`](../../src/contracts/answer.ts) (`supported`, `partial`, `unsupported`,
`contradicted`) and the answer in `Answer.status`. **In M1 the `verify` chain starts at Claude**: the
box becomes a verifier only once an F35 evaluation proves a different, adequate model on it (#9).
Behavior: [docs/contracts/model-chain.md](../../docs/contracts/model-chain.md); no provider SDK
outside `src/platform/gateway/` (AGENTS.md §4.3).

## Acceptance tests (write first)
- [ ] positive: `src/platform/gateway/verifier-pass2.test.ts` — each claim is verified with **only** its
      claim text and cited spans (no other turn in the payload), and a `supported` verdict is delivered
- [ ] negative: for `verify` the first eligible provider is **Claude** and no box verifier runs before an
      F35-passing second model exists (#9); the composing provider and any tier below `minVerifierTier`
      are excluded, and a `client_confidential` payload shows zero DeepSeek/OpenRouter calls in the mock
- [ ] negative: `ExpertDefinition` rejects a `verify` chain that reorders that task's order and accepts
      one that merely drops `local_box` (drop ≠ reorder)
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
`pnpm verify`; staging: with the box offline, ask a question needing a `requirement` claim and show the
run audit records Claude verifying while another tier composed, with no provider name in the employee UI.

## Out of scope
DeepSeek/OpenRouter adapters, health checks and circuit tuning (T-314), budgets and rate limits (T-313),
reranking, eval scoring (T-312), expert authoring (T-311); never relax clearance to find a verifier (§12.4).
