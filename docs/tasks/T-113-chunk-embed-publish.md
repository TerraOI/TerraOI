# T-113 Chunk, embed with the pinned model, and auto-publish for the skeleton

Lane: 2 · Week: 1 · Protected: yes (`src/platform/gateway/` route config) · Depends on: T-111, T-112, T-115 · Status: ready
Plan refs: §7.2 steps 4–8, §12.4 (pinned embeddings and embedding clearance), §8.3; F12, F13

## Goal
Extracted text becomes stable, located chunks, embedded into exactly one index generation, and
for the skeleton the version publishes automatically under a policy that will later be replaced by
the review queue.

## Owns (may edit)
- `src/platform/knowledge/` (chunker, embedder, publisher), `src/platform/retrieval/embeddings.ts`
- `src/platform/knowledge/*.test.ts`, `src/platform/retrieval/*.test.ts`

## Must not edit
`src/contracts/` (the pin contract exists), the merged migrations, `src/platform/gateway/`
chain-selection code (ask for a route through
[COORDINATION.md §2](../../docs/COORDINATION.md) if a change is needed)

## Contract
[`EmbeddingIndex`](../../src/contracts/provider-route.ts): one provider, model, dimension, metric
and generation, **no fallback field**, and a `clearedFor` list that must cover the class of every
chunk written to that index; `isIngestibleInM1`; `maxDataClass` for derived rows;
`IngestionJobPayload` stages `index` then `publish`.

The M1 pin is the **candidate** `@cf/baai/bge-m3` (1024 dimensions, cosine) with
`cleared_for = {public}` only, pending Company1's E1 decision (#6) — until that decision is recorded,
only `public` fixtures are embedded and no client collection is ingested past `public`.

## Acceptance tests (write first)
- [ ] positive: chunking keeps headings and table headers with the rows, and a chunk id is stable
      for the same (source version, parser generation)
- [ ] negative: an embedding call for an index whose pinned model/dimension does not match the
      configured route is refused before any provider call (incomparable vectors)
- [ ] negative: a vector insert is refused when the chunk's `data_class` is **not** in that index's
      `cleared_for` — the chunk stays unembedded with a visible reason, and the class is never
      lowered to fit the index (#13(4))
- [ ] negative: every chunk carries the **highest** data class among its inputs; a chunk derived
      from a `client_confidential` source can never be labeled `internal`
- [ ] negative: chunks are written only for the tenant that owns the source; a cross-tenant
      version id is rejected by the FK
- [ ] failure: the pinned embedding route is down → the source waits in `indexing` with a visible
      reason, and search falls back to the labeled lexical-only lane; **no** partial publication
- [ ] publish is atomic: an interrupted embed leaves the previous published version active; the
      pointer switch is one transaction; `pnpm verify` and a re-run of the same stage are no-ops
- [ ] metadata-only ACL change flips visibility immediately without re-embedding

## Done evidence
`pnpm verify`; staging: publish one synthetic Company1 `public` PDF, then in the company2 workspace
confirm the chunk is not retrievable; show the index generation id and the chunk count from the
database (CI `database` job for pgTAP where the machine has no Docker).

## Out of scope
Review queue and publication policy (T-213), revoke and derived-output invalidation (T-213),
shadow re-index runbook (§8.3, later), OCR inputs (T-211/T-212).
