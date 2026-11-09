# T-111 Knowledge schema: collections, sources, versions, chunks, indexes, jobs

Lane: 2 (shared path) · Week: 1 · Protected: yes (`supabase/migrations/`) · Depends on: T-002, T-003 · Status: done — merged as [PR #12](https://github.com/TerraOI/TerraOI/pull/12)
Plan refs: §6.1 (knowledge, retrieval, ingestion groups), §6.2, §7.2; F08, F10, F12

## Goal
The knowledge half of the walking skeleton: data-classed collections, immutable source versions, chunks,
pinned embedding-index generations and the job/outbox state a worker drives — all tenant-scoped.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_knowledge_core.sql` (timestamp agreed in the
  daily sync; never edit the merged tenancy migration), `supabase/seed.sql` (synthetic collections)
- `supabase/tests/database/020_knowledge*.test.sql`, generated `src/contracts/database.types.ts`
  (regenerate with `pnpm db:types` after rebasing; never hand-edit)

## Must not edit
`src/platform/*` application code, `src/contracts/*.ts` other than the generated types, and merged
migrations (including `20261105060000_tenancy_core.sql`)

## Contract
[`DataClass`](../../src/contracts/data-class.ts) and
[`EmbeddingIndex`](../../src/contracts/provider-route.ts) (pinned model/dimensions/metric/
generation, no fallback), [`IngestionJobPayload`](../../src/contracts/ingestion-job.ts) (stages,
executors, `restricted` never enqueued). Scope comes from `set_tenant_scope` /
`current_organisation_id` in the merged tenancy migration (lands with T-003).

**Grants, per #13(1) and [FAQ-0004](../../docs/FAQ.md):** members hold `select` on the knowledge
tables only — no `insert`, `update` or `delete` for `authenticated`. Writes go through scoped RPCs
(`create_collection_v1`, `register_source_version_v1`, later `review_decision_v1`) that set the tenant,
check role level and apply data-class rules; other lanes call the RPC, never the table.

**Embedding pin, per #6 and [ADR-0007](../decisions/0007-e1-embedding-clearance.md):** the M1 pin is `@cf/baai/bge-m3` (1024 dims, cosine),
and E1 is decided for every tenant, so each index is `cleared_for = {public, internal,
client_confidential}`. The seeded rows carry that value; fixtures stay synthetic.

## Acceptance tests (write first, pgTAP)
- [ ] guardrails 000 still pass (RLS everywhere, `search_path` pinned in every SECURITY DEFINER function)
- [ ] composite `(id, organisation_id)` unique keys everywhere; a chunk pointing at another tenant's
      source version fails with an FK violation (`23503`)
- [ ] negative: `authenticated` has no `insert`, `update` or `delete` on any knowledge table (`42501`),
      while the scoped RPCs succeed for a permitted member (#13(1))
- [ ] negative: a company1 member cannot select company2 collections/sources/chunks, and a member whose
      membership is suspended sees nothing
- [ ] negative: `data_class = 'restricted'` cannot be created in M1 (check or trigger mirroring
      `isIngestibleInM1`); a `client_confidential` collection without a project is rejected
- [ ] negative: source version rows are immutable (an UPDATE of payload/hash/text is refused;
      corrections are new versions)
- [ ] negative: a vector for a class outside the index's `cleared_for` is refused, and `restricted` is
      never embedded (#6, ADR-0007)
- [ ] the state set matches `received → validating → extracting → indexing → awaiting_review → published`
      plus `quarantined/failed/superseded/revoked/deleting/deleted`; an out-of-set value is rejected
- [ ] outbox: one source version inserts exactly one outbox event; a rolled-back transaction inserts none

## Done evidence
`pnpm db:reset && pnpm db:test` (or the CI `database` job when the machine has no Docker),
`pnpm db:types` committed, `pnpm verify` green, CI `migrations` job green.

## Out of scope
Upload HTTP surface (T-112), embedding calls (T-113), retrieval RPC (T-114), connectors,
employee submissions (T-302), forms (T-301).
