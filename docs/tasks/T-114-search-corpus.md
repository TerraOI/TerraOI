# T-114 `search_corpus_v1`: hybrid retrieval under RLS

Lane: 2 (shared path) · Week: 1 · Protected: yes (`supabase/migrations/`) · Depends on: T-111, T-113 · Status: in progress (wyuinline) — SQL half green in CI's `database` job at head `26cd5d8` (#160, pgTAP slot 037 + the `001` allow-list row; that head is two commits behind #160's tip). The typed client and the Recall@10 harness ride in the stacked PR on top of it: branch `t-114b-retrieval-client`, code head `d58d199` — the only commit after it is this status line, whose own sha cannot appear inside it. That half's evidence is `pnpm verify` plus the COORDINATION §6a loopback harness, all run locally; `pnpm db:test` was not run (no Docker here, and this half changes no SQL), and the **Recall@10 baseline is owed, not measured**: the scorer runs on synthetic fixture expectations only, and a baseline needs the CI or staging database. So staging evidence remains owed per §6a (T-004 §20.8 human step) and no acceptance box naming a measurement or a staging run is ticked. Provisional on #161 (`p_authority_filters` / `p_effective_on` have no columns).
Plan refs: §8.1–§8.3, §6.2; F16, F08

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Spans** ([#95](https://github.com/TerraOI/TerraOI/issues/95), ADR-0008): `search_corpus_v1` returns text, never a `startChar`/`endChar`; spans are UTF-16 offsets into `knowledge_chunks.body_text`, computed only in the Worker.
- **Slot and role** ([#136](https://github.com/TerraOI/TerraOI/issues/136)): the pgTAP file is `supabase/tests/database/037_search_corpus.test.sql` (`030` is T-130's, merged). This packet is a reader only: `search_corpus_v1` is security invoker, `EXECUTE` granted to `authenticated` by full signature and added to `001_function_privileges.test.sql`'s allow-list in the same PR ([#142](https://github.com/TerraOI/TerraOI/issues/142)); it creates no write path (T-113 owns chunk writes and the publish switch).
- **Filters with no column yet** ([#161](https://github.com/TerraOI/TerraOI/issues/161)): `p_authority_filters` stays in the signature; `NULL` or `'{}'` means no filter, a non-empty array raises `22023`, and `authority_filters_applied` is always `false`. `p_effective_on` compares `published_at < ((p_effective_on + 1)::timestamp at time zone 'UTC')` (the UTC calendar day), sets `historical_gap` when later readable versions exist, and returns `coverage_unknown` when nothing qualifies. `037` asserts the day boundary. The PR that first stores an authority value or an effective interval replaces these interims in a new migration.
- **Tenant scope** ([#163](https://github.com/TerraOI/TerraOI/issues/163), FAQ-0011): `search_corpus_v1` begins with `perform public.set_tenant_scope(p_organisation_id);`, refuses a pre-existing scope for a different organisation, and is `volatile`. The client half calls through `withTenantRpc` (T-101c).

## Goal
One security-invoker RPC answers a scoped question with authorized, ranked evidence rows and
bounded coverage diagnostics — full-text plus vector, combined by rank fusion, never wider than the
caller may see.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_search_corpus.sql` (timestamp from the daily
  sync), indexes and partial indexes it proves necessary
- `supabase/tests/database/037_search_corpus.test.sql`, `src/platform/retrieval/` (client wrapper)
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
