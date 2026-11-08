# T-113 Chunk, embed with the pinned model, and auto-publish for the skeleton

Lane: 2 · Week: 1 · Protected: yes (`src/platform/gateway/` route config) · Depends on: T-111, T-112, T-115 · Status: in progress (wyuinline) — the chunker and the embedding gate are on `main` via [#80](https://github.com/TerraOI/TerraOI/pull/80): `src/platform/knowledge/chunker.ts` (headings and table headers carried with their rows, page attribution, chunk ids stable per source version and parser generation, and a derived chunk that can never be labeled below its source class) and `src/platform/retrieval/embeddings.ts` (refuses a route whose model or dimension differs from the index, refuses a chunk whose class is outside that index's `cleared_for` and says why, refuses `restricted` outright, contacts no provider when the plan already refuses, and publishes only once every planned chunk is embedded). Still open in this packet: the database-side boxes — cross-tenant chunk rows rejected by the FK, the pointer switch as one transaction with an idempotent re-run of the same stage — which need a pgTAP suite whose slot is **not yet claimed**; and the staging evidence below, which waits on [#38](https://github.com/TerraOI/TerraOI/issues/38) (the upload storage path and credential) and on the pin decision in [#6](https://github.com/TerraOI/TerraOI/issues/6). `045` is already proposed by [ADR-0005](../decisions/0005-ocr-job-api-and-artifact-home.md) for the job API, `050` belongs to T-213 and `060` to T-214, so this suite needs its own number.
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
