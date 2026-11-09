# ADR-0007 E1: Workers AI may embed `client_confidential` text, for every tenant

Status: **accepted** · Date: 2026-11-08 · Deciders: Company1 (approved E1), supervisor (extended it to every tenant; [#6](https://github.com/TerraOI/TerraOI/issues/6))
Plan refs: §12.4 (embedding clearance, lines 805–811), §18.3, §20.8; TOI-ADR-13

## Context

Embedding sends the full chunk text to the embedding provider, so the pinned index must be cleared for every data class it holds (plan §12.4). The plan left Workers AI **not** cleared for `client_confidential` by default and asked Company1 to choose between **E1** (Workers AI embeds `client_confidential`) and **E2** (a separate local-box-only index, with lexical-only search whenever the box is offline). On 2026-11-06 the engineering half of #6 pinned the index, `@cf/baai/bge-m3`, 1024 dimensions, cosine, and held `cleared_for` at `public` and `internal` until the data-policy half was decided.

## Decision

1. **E1.** Company1 approved Workers AI embedding its `client_confidential` text, and the supervisor makes that the platform default: **every tenant's** pinned Workers AI index is `cleared_for = {public, internal, client_confidential}`. This supersedes plan §12.4's "Workers AI is not cleared for `client_confidential` by default" **for embeddings only**.
2. **`restricted` is never embedded.** It is not ingested in M1 at all (`isIngestibleInM1`).
3. **Embedding clearance only.** It is enforced by `embedding_indexes.cleared_for` (`20261105070000_knowledge_core.sql:740`) and `src/platform/retrieval/embeddings.ts`. The chat/model clearance matrix is a separate decision and **does not change**: `PLATFORM_DEFAULT_CLEARANCE.client_confidential` stays `["local_box", "claude"]` (`src/contracts/provider-route.ts`), so Workers AI does not compose or verify answers over client data.
4. **The pin is still verified in TOI-04** against Company1 documents (plan §12.4). If `bge-m3` fails there, a new index row and a re-embed follow (TOI-ADR-13); nothing switches at runtime.

## Consequences

- `client_confidential` chunks are embedded instead of taking the labelled `lexical_only` lane (T-113, T-315). The gate still refuses any class an index does not clear, and pgTAP assertion 72 keeps proving it against an index narrowed inside the test.
- `supabase/seed.sql` widens both synthetic tenants' index rows to the new value. Fixtures stay synthetic (plan §16).
- **Human step (§20.8):** each tenant's staging and production `embedding_indexes` row carries `{public, internal, client_confidential}` when it is created. Agents do not create those rows.
- A tenant that wants E2 instead records its own decision; its index then narrows to `{public, internal}`, and a second, local-box-only index holds its `client_confidential` chunks.

## Alternatives considered

- **E1 for Company1 only.** Rejected by the supervisor in favour of one platform default; a tenant can still narrow.
- **E2 (local-box-only index).** Keeps client text on owner hardware, but every client collection falls back to lexical-only search whenever the box is offline, and the box is also the OCR path (§7.2), so one outage would hurt client corpora twice.
- **Widen the chat matrix as well.** Not part of E1; it would be a separate decision with its own ADR and gateway test changes.
