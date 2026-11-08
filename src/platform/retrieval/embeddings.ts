import { type DataClass } from "@/contracts/data-class";
import { type EmbeddingIndex, isIngestibleInM1 } from "@/contracts/provider-route";

/**
 * T-113 steps 6–8 of plan §7.2, and the §12.4 "pinned embeddings and embedding clearance" gate.
 *
 * Everything in this file is decided **before a provider is contacted**, because both failure modes
 * are data-leak-shaped rather than retrieval-quality-shaped:
 *
 * - Vectors from different models, dimensions or metrics are incomparable (TOI-ADR-13). `EmbeddingIndex`
 *   has no fallback field on purpose, so a route that disagrees with the pinned index is refused
 *   rather than silently used — a mixed generation makes every similarity score meaningless.
 * - An embedding call ships the **full chunk text** to the provider. So the class decision
 *   (`clearedFor`, plan §12.4 "embedding clearance is a separate decision"; issue #6's engineering
 *   half: `public` and `internal` only) is made here, and `chunk_embeddings_guard` in the schema makes
 *   the same refusal on the way in. Both gates must exist: this one prevents the text from leaving,
 *   the schema one prevents a row from appearing.
 *
 * The class of a chunk is never lowered to fit an index (issue #13 item 4). A refused chunk keeps its
 * class and stays on the labelled lexical lane (`lexical_only`, the same vocabulary as
 * `ProgressEvent.retrievalMode` in `src/contracts/chat.ts`), so search degrades visibly instead of
 * quietly widening an index.
 *
 * **No provider call happens in this module.** `embedPlanned` takes an `embed` callback; in
 * production that callback is the gateway's embedding route (AGENTS.md §4.3 — all model calls go
 * through `src/platform/gateway/`). Keeping the gate and the transport separate is what makes the
 * gate testable without ever calling a provider, which is also the plan's rule for tests (§12.4).
 *
 * Not decided here: which index generation a tenant is on, the pointer switch that makes a version
 * visible (the next slice, one transaction in SQL), and whether a complete version may be published
 * at all — publication *policy* is the review queue, T-213.
 */

/** The route the gateway is configured with for embedding. Mirrors the pinned half of `EmbeddingIndex`. */
export interface EmbeddingRoute {
  providerKey: EmbeddingIndex["providerKey"];
  model: string;
  dimensions: number;
  metric: EmbeddingIndex["metric"];
}

/** A chunk as the embedding stage sees it (a subset of what `chunker.ts` produces). */
export interface ChunkToEmbed {
  chunkId: string;
  text: string;
  dataClass: DataClass;
}

export type EmbeddingRefusalReason =
  | "index_route_mismatch"
  | "index_not_active"
  | "class_not_ingestible_in_m1"
  | "class_not_cleared_for_index"
  | "provider_dimension_mismatch";

export type EmbeddingDecision =
  /** Exactly one generation is named, because exactly one index generation is pinned. */
  | { kind: "embed"; chunkId: string; generation: number }
  | {
      kind: "refused";
      chunkId: string;
      reason: EmbeddingRefusalReason;
      /** True when the chunk stays searchable through the labelled lexical lane. */
      lexicalOnly: boolean;
      detail?: string;
    };

export interface EmbeddingVector {
  chunkId: string;
  indexKey: string;
  generation: number;
  dimensions: number;
  embedding: readonly number[];
}

function indexMismatch(index: EmbeddingIndex, route: EmbeddingRoute): string | null {
  const offenders: string[] = [];
  if (index.model !== route.model) offenders.push(`model ${index.model} vs ${route.model}`);
  if (index.dimensions !== route.dimensions) {
    offenders.push(`dimensions ${index.dimensions} vs ${route.dimensions}`);
  }
  if (index.metric !== route.metric) offenders.push(`metric ${index.metric} vs ${route.metric}`);
  if (index.providerKey !== route.providerKey) {
    offenders.push(`provider ${index.providerKey} vs ${route.providerKey}`);
  }
  return offenders.length > 0 ? offenders.join("; ") : null;
}

/**
 * The plan, per chunk, in input order. Decides only; performs nothing.
 */
export function planEmbeddings(input: {
  index: EmbeddingIndex;
  route: EmbeddingRoute;
  chunks: readonly ChunkToEmbed[];
}): EmbeddingDecision[] {
  const mismatch = indexMismatch(input.index, input.route);
  return input.chunks.map((chunk) => {
    if (mismatch !== null) {
      return {
        kind: "refused",
        chunkId: chunk.chunkId,
        reason: "index_route_mismatch",
        lexicalOnly: true,
        detail: `${input.index.indexKey} g${input.index.generation}: ${mismatch}`,
      };
    }
    if (input.index.status !== "active") {
      return {
        kind: "refused",
        chunkId: chunk.chunkId,
        reason: "index_not_active",
        lexicalOnly: true,
        detail: `${input.index.indexKey} g${input.index.generation} is ${input.index.status}`,
      };
    }
    // §12.4 + M1: `restricted` is never embedded, and never ingested at all, so it has no lexical
    // row to fall back to either — the source is refused upstream, not downgraded here.
    if (!isIngestibleInM1(chunk.dataClass)) {
      return { kind: "refused", chunkId: chunk.chunkId, reason: "class_not_ingestible_in_m1", lexicalOnly: false };
    }
    if (!input.index.clearedFor.includes(chunk.dataClass)) {
      return {
        kind: "refused",
        chunkId: chunk.chunkId,
        reason: "class_not_cleared_for_index",
        lexicalOnly: true,
        detail: `${input.index.indexKey} g${input.index.generation} is cleared for [${input.index.clearedFor.join(", ")}]`,
      };
    }
    return { kind: "embed", chunkId: chunk.chunkId, generation: input.index.generation };
  });
}

/**
 * Runs the plan and contacts the provider **once**, with only the accepted chunk texts. The refusal
 * is therefore proven to precede the call: a chunk the class decision rejected never reaches the
 * provider at all, which is the whole point of making embedding clearance a separate decision.
 */
export async function embedPlanned(input: {
  index: EmbeddingIndex;
  route: EmbeddingRoute;
  chunks: readonly ChunkToEmbed[];
  embed: (texts: string[]) => Promise<readonly (readonly number[])[]>;
}): Promise<{ vectors: EmbeddingVector[]; refused: EmbeddingDecision[] }> {
  const decisions = planEmbeddings(input);
  const refused = decisions.filter((decision) => decision.kind === "refused");
  const accepted: ChunkToEmbed[] = [];
  decisions.forEach((decision, position) => {
    if (decision.kind === "embed") {
      const chunk = input.chunks[position] as ChunkToEmbed;
      accepted.push(chunk);
    }
  });
  if (accepted.length === 0) return { vectors: [], refused };

  const produced = await input.embed(accepted.map((chunk) => chunk.text));
  if (produced.length !== accepted.length) {
    // A short or long batch means we cannot say which vector belongs to which chunk; guessing would
    // attach one chunk's vector to another chunk's text and class.
    throw new Error(
      `embedPlanned: the embedding route returned ${produced.length} vectors for ${accepted.length} chunks`,
    );
  }
  const vectors: EmbeddingVector[] = [];
  accepted.forEach((chunk, position) => {
    const embedding = produced[position] as readonly number[];
    if (embedding.length !== input.index.dimensions) {
      refused.push({
        kind: "refused",
        chunkId: chunk.chunkId,
        reason: "provider_dimension_mismatch",
        lexicalOnly: true,
        detail: `route returned ${embedding.length} dimensions, index pins ${input.index.dimensions}`,
      });
      return;
    }
    vectors.push({
      chunkId: chunk.chunkId,
      indexKey: input.index.indexKey,
      generation: input.index.generation,
      dimensions: input.index.dimensions,
      embedding,
    });
  });
  return { vectors, refused };
}

export type PublicationPlan =
  | { kind: "publish"; generation: number }
  | {
      kind: "wait";
      reason: "incomplete_embedding";
      planned: number;
      embedded: number;
      failed: number;
    };

/**
 * §7.2 step 8: activate a complete version/generation only, never half-embedded chunks. The caller
 * counts the outcomes it actually wrote; this function only decides, so the SQL slice keeps the
 * pointer switch in one transaction and an interrupted run leaves the previous version active.
 *
 * `planned: 0` with nothing failed publishes: a source with no embeddable chunk is a lexical-only
 * source (issues #6 and #13 label the degraded lane rather than blocking the row). What gates
 * publication beyond completeness is the review queue, and that is T-213.
 */
export function planPublication(input: {
  generation: number;
  planned: number;
  embedded: number;
  failed: number;
}): PublicationPlan {
  if (input.failed > 0 || input.embedded !== input.planned) {
    return {
      kind: "wait",
      reason: "incomplete_embedding",
      planned: input.planned,
      embedded: input.embedded,
      failed: input.failed,
    };
  }
  return { kind: "publish", generation: input.generation };
}

export type ClassChangePlan =
  /** Both classes are cleared: the vector already exists and is comparable, so only visibility moves. */
  | { action: "flip_visibility"; reembed: false; generation: number }
  | { action: "remove_vectors"; lane: "lexical_only"; reembed: false; generation: number }
  | {
      action: "remove_vectors";
      reason: "class_not_ingestible_in_m1";
      reembed: false;
      generation: number;
    }
  /** The new class is cleared and the old one was not: there is no vector to flip, one must be made. */
  | { action: "embed_required"; reembed: true; generation: number };

/**
 * §7.2 and issue #13: a metadata-only class change that stays inside the cleared set flips
 * visibility without re-embedding (no provider call, no cost, no new vector for text already sent).
 * Moving out of the cleared set removes the vectors — text may not sit in an index its class was
 * never cleared for — and leaves the labelled lexical lane. Neither direction ever changes the class
 * itself; the row's class is what the caller says it is.
 */
export function planClassChange(input: {
  index: EmbeddingIndex;
  fromClass: DataClass;
  toClass: DataClass;
}): ClassChangePlan {
  const generation = input.index.generation;
  if (!isIngestibleInM1(input.toClass)) {
    return { action: "remove_vectors", reason: "class_not_ingestible_in_m1", reembed: false, generation };
  }
  const hadVector = input.index.clearedFor.includes(input.fromClass);
  const mayHaveVector = input.index.clearedFor.includes(input.toClass);
  if (hadVector && mayHaveVector) return { action: "flip_visibility", reembed: false, generation };
  if (hadVector) return { action: "remove_vectors", lane: "lexical_only", reembed: false, generation };
  if (mayHaveVector) return { action: "embed_required", reembed: true, generation };
  return { action: "flip_visibility", reembed: false, generation };
}
