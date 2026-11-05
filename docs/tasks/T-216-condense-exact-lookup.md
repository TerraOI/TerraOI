# T-216 Query condensation (F30) and deterministic exact lookup before hybrid search

Lane: 2 · Week: 2 · Protected: no (the lookup RPC migration is protected) · Depends on: T-104, T-111, T-114, T-115 · Status: ready
Plan refs: §8.1 steps 4–5, §8.2, §12.4 (per-task chains), §16 (retrieval row); F16, F17, F30

## Goal
Follow-up turns search well and obvious identifiers resolve immediately: a follow-up is rewritten into a
standalone query using only the authorized conversation history, exact record ids, provision numbers,
document titles and equipment models are matched deterministically **before** any vector search, and
both the original question and the condensed query are recorded for audit and evaluation.

## Owns (may edit)
- `src/platform/agents/condense.ts` (the F30 call over the `condense` chain), `src/platform/retrieval/`
  (query planning: exact lookup first, then hybrid; both variants recorded)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_exact_lookup.sql` if the deterministic matcher is a
  security-invoker RPC (`exact_lookup_v1`) — timestamp agreed in the daily sync; migrations are
  protected and merged migrations are never edited
- `supabase/tests/database/070_exact_lookup.test.sql`, `src/platform/retrieval/*.test.ts`,
  `src/platform/agents/*.test.ts`, `evals/retrieval/` condensation and identifier fixtures

## Must not edit
`src/contracts/`, `src/platform/chat/` (history loading F17 is Lane 1's call), `src/platform/gateway/`
(ask for a chain route through [COORDINATION.md §2](../../docs/COORDINATION.md)), `src/app/`,
merged migrations

## Contract
F30 `condenseQuery(authorizedHistory, followUp) -> standalone query`, fed **only** by F17 output and run
through the cheapest cleared entry of
[`ExpertDefinition.modelChains.condense`](../../src/contracts/expert-definition.ts);
[`ProgressEvent.searching.retrievalMode`](../../src/contracts/chat.ts) labels `hybrid` vs `lexical_only`;
the searched scope stays whatever [`ChatRequest`](../../src/contracts/chat.ts) and `TenantContext` allow,
and the plan passes it unchanged to `search_corpus_v1` from [T-114](./T-114-search-corpus.md).
Condensation is a **search rewrite**, never a source of facts and never an input to composition (plan
§8.1 step 5 keeps the original question for that).

## Acceptance tests (write first)
- [ ] positive: `src/platform/retrieval/query-plan.test.ts` — "and the 120 m one?" becomes a standalone
      query naming the previous subject, and both query strings are persisted on the run
- [ ] positive: `supabase/tests/database/070_exact_lookup.test.sql` — a provision number, equipment model
      or exact document title returns its chunk with locator before any vector search runs, and the
      Recall@10 baseline from the fixtures does not regress
- [ ] negative: condensation may use only history the caller is authorized to see — a turn from another
      user or a withheld source cannot enter the rewrite, and the rewrite cannot introduce a project or
      collection outside `TenantContext.permittedProjectIds`
- [ ] negative: an identifier belonging to another tenant matches nothing at all (no row, no existence
      signal), and exact lookup runs under the same RLS and publication filters as hybrid search
- [ ] failure: the `condense` chain is unavailable or times out → search proceeds with the raw question
      plus the last user turn, and the run records that condensation was skipped
- [ ] failure: condensed output that is empty, oversized, or adds an entity absent from the history is
      discarded in favor of the raw question; no exact match falls through to hybrid, not a dead end

## Done evidence
`pnpm db:test` when the lookup RPC lands, `pnpm verify`; staging: in one conversation ask a question and
then anaphoric follow-ups, show both query strings and the chosen lane in the run diagnostics, and show
a provision number resolving to the right page while the same id on company2 returns nothing.

## Out of scope
Reranking, Auto multi-expert routing and `routeExpert` (T-311), live tools for current operational state
(TOI-07/TOI-10, deferred), query-cache layers (need an ADR, FAQ-0002), embedding-model changes or
shadow re-indexing (§8.3).
