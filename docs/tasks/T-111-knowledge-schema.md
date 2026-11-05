# T-111 Knowledge schema: collections, sources, versions, chunks, indexes, jobs

Lane: 2 (shared path) · Week: 1 · Protected: yes (`supabase/migrations/`) · Depends on: T-002, T-003 · Status: ready
Plan refs: §6.1 (knowledge, retrieval, ingestion groups), §6.2, §7.2; F08, F10, F12

## Goal
The knowledge half of the walking skeleton: collections that carry a data class, immutable source
versions, chunks, pinned embedding-index generations, and the job/outbox state a worker drives —
all tenant-scoped with composite FKs and RLS.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_knowledge_core.sql` (timestamp agreed in the
  daily sync; never edit the merged tenancy migration), `supabase/seed.sql` (synthetic collections)
- `supabase/tests/database/020_knowledge*.test.sql`, generated `src/contracts/database.types.ts`
  (regenerate with `pnpm db:types` after rebasing; never hand-edit)

## Must not edit
`src/platform/*` application code, `src/contracts/*.ts` other than the generated types, the
merged migration `20261105060000_tenancy_core.sql`

## Contract
[`DataClass`](../../src/contracts/data-class.ts) and
[`EmbeddingIndex`](../../src/contracts/provider-route.ts) (pinned model/dimensions/metric/
generation, no fallback), [`IngestionJobPayload`](../../src/contracts/ingestion-job.ts) (stages,
executors, `restricted` never enqueued). Scope comes from `set_tenant_scope` /
`current_organisation_id` in
[the tenancy migration](../../supabase/migrations/20261105060000_tenancy_core.sql).

## Acceptance tests (write first, pgTAP)
- [ ] guardrails 000 still pass (RLS everywhere, `search_path` pinned in every SECURITY DEFINER function)
- [ ] every new table: composite `(id, organisation_id)` unique keys, and a chunk insert that
      points at another tenant's source version fails with an FK violation (`23503`)
- [ ] negative: company1 member cannot select company2 collections/sources/chunks; a member whose
      membership is suspended sees nothing
- [ ] negative: a collection with `data_class = 'restricted'` cannot be created in M1
      (check/CHECK or trigger, mirroring `isIngestibleInM1`); `client_confidential` collections
      without a project are rejected
- [ ] negative: source version rows are immutable (an UPDATE of payload/hash/text is refused;
      corrections are new versions)
- [ ] the visible state set matches `received → validating → extracting → indexing →
      awaiting_review → published` plus `quarantined/failed/superseded/revoked/deleting/deleted`
      and an out-of-set value is rejected
- [ ] outbox: creating a source version in a transaction inserts exactly one outbox event; a
      rolled-back transaction inserts none

## Done evidence
`pnpm db:reset && pnpm db:test` (or the CI `database` job when the machine has no Docker),
`pnpm db:types` committed, `pnpm verify` green, CI `migrations` job green.

## Out of scope
Upload HTTP surface (T-112), embedding calls (T-113), retrieval RPC (T-114), connectors,
employee submissions (T-302), forms (T-301).
