import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLATFORM_CHAIN,
  EmbeddingIndex,
  PlatformProvider,
  PLATFORM_DEFAULT_CLEARANCE,
  TaskClass,
  narrowClearance,
  type ClearanceMatrix,
} from "./provider-route";

// Plan §12.4: cost-ordered chain, clearance filtered by data class, pinned embeddings.
describe("platform provider chain (plan §12.4)", () => {
  it("is ordered cheapest first and contains exactly the five platform providers", () => {
    expect(DEFAULT_PLATFORM_CHAIN).toEqual([
      "local_box",
      "workers_ai",
      "claude",
      "deepseek",
      "openrouter",
    ]);
  });

  it("parses a provider route and rejects unknown fields or free-text task classes", () => {
    const parsed = PlatformProvider.parse({
      providerKey: "claude",
      capabilityTier: "large",
      costRank: 3,
      taskClasses: ["compose", "verify"],
      maxClearedClass: "client_confidential",
      supportsStructuredOutput: true,
    });
    expect(parsed.providerKey).toBe("claude");
    expect(() => PlatformProvider.parse({ providerKey: "claude", taskClasses: "compose" })).toThrow();
    expect(() =>
      PlatformProvider.parse({
        providerKey: "claude",
        capabilityTier: "large",
        costRank: 3,
        taskClasses: ["compose"],
        maxClearedClass: "public",
        apiKey: "sk-ant-…",
      }),
    ).toThrow();
  });

  it("accepts the four task classes of the pipeline", () => {
    for (const taskClass of ["route", "condense", "compose", "verify"] as const) {
      expect(TaskClass.parse(taskClass)).toBe(taskClass);
    }
    expect(() => TaskClass.parse("embed")).toThrow();
  });

  it("pins one model, dimension, metric and generation per embedding index (never chained)", () => {
    const parsed = EmbeddingIndex.parse({
      indexKey: "company1-gpr-v1",
      providerKey: "workers_ai",
      model: "bge-large-en-v1.5",
      dimensions: 1024,
      metric: "cosine",
      generation: 1,
      status: "active",
    });
    expect(parsed.dimensions).toBe(1024);
    expect(() => EmbeddingIndex.parse({ indexKey: "k", dimensions: 0 })).toThrow();
    expect(() =>
      EmbeddingIndex.parse({
        indexKey: "k",
        providerKey: "workers_ai",
        model: "a",
        dimensions: 1024,
        metric: "cosine",
        generation: 1,
        status: "active",
        fallbackModels: ["other"],
      }),
    ).toThrow();
  });
});

describe("clearance matrix (plan §12.4)", () => {
  it("matches the platform default matrix", () => {
    expect(PLATFORM_DEFAULT_CLEARANCE.public).toEqual([...DEFAULT_PLATFORM_CHAIN]);
    for (const cls of ["internal", "client_confidential", "restricted"] as const) {
      expect(PLATFORM_DEFAULT_CLEARANCE[cls]).not.toContain("deepseek");
      expect(PLATFORM_DEFAULT_CLEARANCE[cls]).not.toContain("openrouter");
    }
    expect(PLATFORM_DEFAULT_CLEARANCE.restricted).toEqual(["local_box"]);
    expect(PLATFORM_DEFAULT_CLEARANCE.client_confidential).not.toContain("workers_ai");
    expect(PLATFORM_DEFAULT_CLEARANCE.internal).toContain("workers_ai");
  });

  it("a tenant may narrow the matrix", () => {
    const narrowed = narrowClearance({ client_confidential: ["local_box"] });
    expect(narrowed.client_confidential).toEqual(["local_box"]);
    expect(narrowed.public).toEqual([...DEFAULT_PLATFORM_CHAIN]);
  });

  it("a tenant may not widen the matrix (needs a recorded decision)", () => {
    const widened = narrowClearance({
      client_confidential: [...DEFAULT_PLATFORM_CHAIN],
      restricted: [...DEFAULT_PLATFORM_CHAIN],
    });
    expect(widened.client_confidential).toEqual(["local_box", "claude"]);
    expect(widened.restricted).toEqual(["local_box"]);
  });

  it("keeps the platform cost order in the result and an empty class stays empty", () => {
    const result = narrowClearance({ public: ["claude", "local_box"] });
    expect(result.public).toEqual(["local_box", "claude"]);
    const cleared: Partial<ClearanceMatrix> = { internal: [] };
    expect(narrowClearance(cleared).internal).toEqual([]);
  });

  it("fails closed when the requested class is unknown to the matrix", () => {
    const matrix = { ...PLATFORM_DEFAULT_CLEARANCE } as ClearanceMatrix;
    expect(matrix.restricted).toEqual(["local_box"]);
    expect(() => narrowClearance({ secret: ["local_box"] } as never)).toThrow();
  });
});
