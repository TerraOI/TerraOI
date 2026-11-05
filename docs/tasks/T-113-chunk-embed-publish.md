# T-113 Chunk, embed with the pinned model, and auto-publish for the skeleton

Lane: 2 · Week: 1 · Protected: yes (embedding route config touches the gateway; `src/platform/gateway/` is protected) · Depends on: T-111, T-112, T-115 · Status: ready
Plan refs: §7.2 steps 4–8, §12.4 (pinned embeddings), §8.3; F12, F13

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
and generation, **no fallback field**; `isIngestibleInM1`; `maxDataClass` for derived rows;
`IngestionJobPayload` stages `index` then `publish`.

## Acceptance tests (write first)
- [ ] positive: chunking keeps headings and table headers with the rows, and a chunk id is stable
      for the same (source version, parser generation)
- [ ] negative: every chunk carries the **highest** data class among its inputs; a chunk derived
      from a `client_confidential` source can never be labeled `internal`
- [ ] negative: an embedding call for an index whose pinned model/dimension does not match the
      configured route is refused before any provider call (incomparable vectors)
- [ ] negative: chunks are written only for the tenant that owns the source; a cross-tenant
      version id is rejected by the FK
- [ ] failure: the pinned embedding route is down → the source waits in `indexing` with a visible
      reason, and search falls back to the labeled lexical-only lane; **no** partial publication
- [ ] publish is atomic: an interrupted embed leaves the previous published version active; the
      pointer switch is one transaction; `pnpm verify` and a re-run of the same stage are no-ops
- [ ] metadata-only ACL change flips visibility immediately without re-embedding

## Done evidence
`pnpm verify`; staging: publish one Company1 PDF, then in the company2 workspace confirm the chunk
is not retrievable; show the index generation id and the chunk count from the database.

## Out of scope
Review queue and publication policy (T-213), revoke and derived-output invalidation (T-213),
shadow re-index runbook (§8.3, later), OCR inputs (T-211/T-212).
