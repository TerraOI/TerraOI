import { describe, expect, it } from "vitest";

import { DataClass } from "@/contracts/data-class";
import { EmbeddingIndex } from "@/contracts/provider-route";

import {
  embedPlanned,
  planClassChange,
  planEmbeddings,
  planPublication,
  type EmbeddingRoute,
} from "./embeddings";

/**
 * T-113 acceptance, written first (packet "Acceptance tests"; plan §12.4 "pinned embeddings and
 * embedding clearance", §7.2 steps 6–8; issues #6 and #13(4)).
 *
 * The index pin is the one recorded in #6: `@cf/baai/bge-m3`, 1024 dimensions, cosine, cleared for
 * `public` and `internal` only, and **never widened in code or seed data**. Everything here is decided
 * before a provider is contacted: an incomparable vector or a vector in an index the class was never
 * cleared for is a data-leak-shaped bug, not a retrieval-quality bug.
 */

const INDEX = EmbeddingIndex.parse({
  indexKey: "m1-bge-m3",
  providerKey: "workers_ai",
  model: "@cf/baai/bge-m3",
  dimensions: 1024,
  metric: "cosine",
  generation: 1,
  status: "active",
  clearedFor: ["public", "internal"],
});

const ROUTE: EmbeddingRoute = {
  providerKey: "workers_ai",
  model: "@cf/baai/bge-m3",
  dimensions: 1024,
  metric: "cosine",
};

function chunk(chunkId: string, dataClass: DataClass) {
  return { chunkId, text: `synthetic text for ${chunkId}`, dataClass };
}

describe("the pinned index is checked against the configured route before any provider call", () => {
  it("refuses a route whose model differs from the index (incomparable vectors)", () => {
    const decisions = planEmbeddings({
      index: INDEX,
      route: { ...ROUTE, model: "@cf/baai/bge-large-en" },
      chunks: [chunk("c1", "public")],
    });
    expect(decisions[0]).toMatchObject({ kind: "refused", reason: "index_route_mismatch" });
  });

  it("refuses a route whose dimension differs from the index", () => {
    const decisions = planEmbeddings({
      index: INDEX,
      route: { ...ROUTE, dimensions: 768 },
      chunks: [chunk("c1", "public")],
    });
    expect(decisions[0]).toMatchObject({ kind: "refused", reason: "index_route_mismatch" });
  });

  it("refuses an index that is not active, so nothing lands in a building generation", () => {
    const decisions = planEmbeddings({
      index: { ...INDEX, status: "building" },
      route: ROUTE,
      chunks: [chunk("c1", "public")],
    });
    expect(decisions[0]).toMatchObject({ kind: "refused", reason: "index_not_active" });
  });

  it("contacts no provider at all when the plan refuses (the gate is before the call)", async () => {
    let calls = 0;
    const outcome = await embedPlanned({
      index: { ...INDEX, clearedFor: ["public"] },
      route: ROUTE,
      chunks: [chunk("c1", "internal"), chunk("c2", "public")],
      embed: async (texts) => {
        calls += 1;
        return texts.map(() => [0, 0, 0]);
      },
    });
    expect(calls).toBe(1);
    expect(outcome.vectors.map((vector) => vector.chunkId)).toEqual(["c2"]);
    expect(outcome.refused[0]).toMatchObject({ chunkId: "c1", reason: "class_not_cleared_for_index" });
  });
});

describe("embedding clearance is a separate decision from the chunk existing (#13(4), #6)", () => {
  it("refuses a chunk whose class is not in the index's cleared_for, and says why", () => {
    const decisions = planEmbeddings({
      index: INDEX,
      route: ROUTE,
      chunks: [chunk("c1", "client_confidential")],
    });
    expect(decisions[0]).toMatchObject({
      kind: "refused",
      reason: "class_not_cleared_for_index",
      lexicalOnly: true,
    });
  });

  it("never lowers the class to make it fit the index", () => {
    const original = chunk("c1", "client_confidential");
    const decisions = planEmbeddings({ index: INDEX, route: ROUTE, chunks: [original] });
    expect(decisions[0]?.kind).toBe("refused");
    expect(original.dataClass).toBe("client_confidential");
  });

  it("refuses `restricted` outright: M1 does not ingest it at all", () => {
    const decisions = planEmbeddings({ index: INDEX, route: ROUTE, chunks: [chunk("c1", "restricted")] });
    expect(decisions[0]).toMatchObject({ kind: "refused", reason: "class_not_ingestible_in_m1" });
  });

  it("embeds exactly one index generation for an accepted chunk", () => {
    const decisions = planEmbeddings({ index: INDEX, route: ROUTE, chunks: [chunk("c1", "internal")] });
    expect(decisions[0]).toEqual({ kind: "embed", chunkId: "c1", generation: 1 });
  });
});

describe("publish is atomic and a failed embed never publishes partially (§7.2 step 8)", () => {
  it("waits instead of publishing when any planned chunk failed", () => {
    expect(planPublication({ generation: 1, planned: 5, embedded: 4, failed: 1 })).toMatchObject({
      kind: "wait",
      reason: "incomplete_embedding",
    });
  });

  it("publishes once every planned chunk is embedded", () => {
    expect(planPublication({ generation: 1, planned: 5, embedded: 5, failed: 0 })).toEqual({
      kind: "publish",
      generation: 1,
    });
  });

  it("a plan with nothing embeddable still reports the refusal rather than an empty publish", () => {
    const decisions = planEmbeddings({ index: INDEX, route: ROUTE, chunks: [chunk("c1", "restricted")] });
    const publication = planPublication({
      generation: 1,
      planned: decisions.length,
      embedded: decisions.filter((d) => d.kind === "embed").length,
      failed: decisions.filter((d) => d.kind === "refused").length,
    });
    expect(publication).toMatchObject({ kind: "wait", reason: "incomplete_embedding" });
  });
});

describe("a metadata-only class change flips visibility without re-embedding (§7.2, #13)", () => {
  it("flips between two cleared classes with no re-embed", () => {
    expect(planClassChange({ index: INDEX, fromClass: "internal", toClass: "public" })).toMatchObject({
      action: "flip_visibility",
      reembed: false,
    });
  });

  it("removes the vectors when the new class is not cleared for the index, and labels the lexical lane", () => {
    expect(
      planClassChange({ index: INDEX, fromClass: "internal", toClass: "client_confidential" }),
    ).toMatchObject({ action: "remove_vectors", lane: "lexical_only", reembed: false });
  });

  it("removes the vectors when the new class cannot be ingested at all", () => {
    expect(planClassChange({ index: INDEX, fromClass: "public", toClass: "restricted" })).toMatchObject({
      action: "remove_vectors",
      reason: "class_not_ingestible_in_m1",
    });
  });
});
