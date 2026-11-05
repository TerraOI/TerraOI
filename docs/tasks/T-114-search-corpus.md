# T-114 `search_corpus_v1`: hybrid retrieval under RLS

Lane: 2 (shared path) · Week: 1 · Protected: yes (`supabase/migrations/`) · Depends on: T-111, T-113 · Status: ready
Plan refs: §8.1–§8.3, §6.2; F16, F08

## Goal
One security-invoker RPC answers a scoped question with authorized, ranked evidence rows and
bounded coverage diagnostics — full-text plus vector, combined by rank fusion, never wider than the
caller may see.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_search_corpus.sql` (timestamp from the daily
  sync), indexes and partial indexes it proves necessary
- `supabase/tests/database/030_search_corpus*.test.sql`, `src/platform/retrieval/` (client wrapper)
- `evals/retrieval/` synthetic query/recall fixtures

## Must not edit
`supabase/migrations/20261105060000_tenancy_core.sql`, `src/contracts/`, `src/platform/gateway/`

## Contract
Signature and diagnostics in [docs/contracts/model-chain.md](../../docs/contracts/model-chain.md)
and plan §8.2: `p_organisation_id` (host-derived), `p_service_keys`, `p_project_id`,
`p_collection_ids` (narrowing only), `p_query_text`, `p_query_embedding`, `p_embedding_index_id`,
`p_effective_on`, `p_authority_filters`, `p_limit`. Error taxonomy: `no_accessible_evidence`,
`coverage_unknown`, `historical_gap`, `index_unavailable`, `backend_failure`. Evidence rows feed
[`EvidenceRef`](../../src/contracts/answer.ts).

## Acceptance tests (write first, pgTAP + unit)
- [ ] positive: an exact equipment model / provision number query returns the right chunk with its
      page locator before any vector search
- [ ] negative: the same question from another tenant returns zero rows; a project-restricted
      source is absent for a non-member and present for a member
- [ ] negative: with no transaction scope set the RPC raises rather than searching the whole tenant
- [ ] negative: passing a `p_collection_ids` value the user may not read narrows to nothing — it
      never widens, and an invalid `p_project_id` is an error, not a silently dropped filter
- [ ] negative: an index id that does not match the pinned model/dimension/metric is rejected
- [ ] failure: embedding route unavailable → `lexical_only` results labeled as degraded, still
      fully authorized; a database error is distinguishable from a legitimate empty result
- [ ] revoked source stops returning results immediately (no re-index needed)
- [ ] recall on the synthetic fixture set is measured and printed (Recall@10 baseline, plan §8.3)

## Done evidence
`pnpm db:test`; `pnpm verify`; staging: the same query on company1 returns evidence rows and on
company2 returns zero, with the diagnostics JSON pasted in the PR.

## Out of scope
Query condensation and exact-lookup routing in the pipeline (T-216), reranking, citations/preview
(T-203), connector freshness, index-generation switching runbook.
