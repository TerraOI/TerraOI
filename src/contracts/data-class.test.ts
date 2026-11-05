import { describe, expect, it } from "vitest";

import { DataClass, dataClassRank, maxDataClass } from "./data-class";

// Plan §6.2: "Chunks, conversation turns, summaries, saved answers, eval cases and cached
// results carry the highest class among their dependencies."
describe("DataClass (plan §6.2)", () => {
  it("accepts exactly the four classes", () => {
    for (const cls of ["public", "internal", "client_confidential", "restricted"] as const) {
      expect(DataClass.parse(cls)).toBe(cls);
    }
  });

  it("rejects an unknown class instead of coercing it", () => {
    expect(() => DataClass.parse("confidential")).toThrow();
    expect(() => DataClass.parse(null)).toThrow();
  });

  it("maxDataClass returns the highest class among the inputs", () => {
    expect(maxDataClass(["public", "client_confidential"])).toBe("client_confidential");
    expect(maxDataClass(["internal", "public"])).toBe("internal");
    expect(maxDataClass(["public", "restricted", "internal"])).toBe("restricted");
    expect(maxDataClass(["internal"])).toBe("internal");
  });

  it("a derived object is never lower than any of its inputs", () => {
    const inputs = ["public", "internal", "client_confidential"] as const;
    const derived = maxDataClass(inputs);
    for (const cls of inputs) {
      expect(dataClassRank(derived)).toBeGreaterThanOrEqual(dataClassRank(cls));
    }
  });

  it("fails closed on an empty dependency list rather than defaulting to public", () => {
    expect(() => maxDataClass([])).toThrow();
  });

  it("rejects an unvalidated value that is not a data class", () => {
    expect(() => maxDataClass(["public", "confidential" as never])).toThrow();
  });

  it("rank order is public < internal < client_confidential < restricted", () => {
    expect(dataClassRank("public")).toBeLessThan(dataClassRank("internal"));
    expect(dataClassRank("internal")).toBeLessThan(dataClassRank("client_confidential"));
    expect(dataClassRank("client_confidential")).toBeLessThan(dataClassRank("restricted"));
  });
});
