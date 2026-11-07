import { describe, expect, it } from "vitest";

import { chunkExtractedText } from "./chunker";

/**
 * T-113 acceptance, written first (packet "Acceptance tests"; plan §7.2 steps 4–5, §6.2).
 *
 * The two properties this file pins are the ones later stages depend on: a chunk's identity must be
 * stable for the same (source version, parser generation) so a re-run is a no-op rather than a second
 * set of rows, and every chunk must carry the **highest** data class among its inputs, because a chunk
 * that quietly dropped to `internal` would become embeddable in an index it was never cleared for.
 */

const VERSION = "11111111-1111-4111-8111-111111111111";

async function chunked(
  text: string,
  options: Parameters<typeof chunkExtractedText>[0] extends infer T ? Partial<T> : never = {},
) {
  const input = {
    sourceVersionId: VERSION,
    parserGeneration: "v1",
    dataClass: "public" as const,
    ...options,
    text,
  };
  return chunkExtractedText(input);
}

describe("chunking keeps the structure that makes a chunk quotable (plan §7.2 step 4)", () => {
  it("attaches the heading to the rows under it, so a locator survives the split", async () => {
    const chunks = await chunked(
      ["## Site procedure", "", "Hold the trigger for two seconds, then release.", ""].join("\n"),
    );
    expect(chunks).toHaveLength(1);
    const [chunk] = chunks;
    expect(chunk?.headings).toContain("Site procedure");
    expect(chunk?.text).toContain("Hold the trigger");
  });

  it("keeps the heading and the first row in the same chunk when a section is split", async () => {
    const rows = Array.from({ length: 40 }, (_unused, i) => `Row ${i}: gain 4, frequency 400 MHz.`).join("\n\n");
    const chunks = await chunked(`## GPR settings\n\n${rows}`, { maxChars: 240 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.headings).toContain("GPR settings");
    }
  });

  it("carries a table header into every continuation chunk of that table", async () => {
    const header = "| line | depth | result |";
    const separator = "| --- | --- | --- |";
    const rows = Array.from(
      { length: 30 },
      (_unused, i) => `| L${i} | 1.2 m | rebar at ${i} cm |`,
    ).join("\n");
    const chunks = await chunked([header, separator, rows].join("\n"), { maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).toContain("line");
      expect(chunk.text).toContain("depth");
      expect(chunk.text).toContain("result");
    }
  });
});

describe("chunk identity is a function of (source version, parser generation, position, content)", () => {
  it("is stable across runs for the same version and parser generation", async () => {
    const text = "## A\n\nOne.\n\n## B\n\nTwo.\n";
    const first = await chunked(text);
    const second = await chunked(text);
    expect(first.map((chunk) => chunk.chunkId)).toEqual(second.map((chunk) => chunk.chunkId));
    expect(first.map((chunk) => chunk.ordinal)).toEqual([0, 1]);
  });

  it("changes when the parser generation changes, so a re-parse is a new set, not an update", async () => {
    const text = "One.\n";
    const v1 = await chunked(text, { parserGeneration: "v1" });
    const v2 = await chunked(text, { parserGeneration: "v2" });
    expect(v1[0]?.chunkId).not.toBe(v2[0]?.chunkId);
  });

  it("changes when the source version changes, and when the text changes", async () => {
    const a = await chunked("One.\n", { sourceVersionId: VERSION });
    const b = await chunked("One.\n", { sourceVersionId: "22222222-2222-4222-8222-222222222222" });
    const c = await chunked("One changed.\n", { sourceVersionId: VERSION });
    expect(a[0]?.chunkId).not.toBe(b[0]?.chunkId);
    expect(a[0]?.chunkId).not.toBe(c[0]?.chunkId);
  });

  it("assigns distinct ids to identical text at different positions", async () => {
    const chunks = await chunked("Same.\n\nSame.\n");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.chunkId).not.toBe(chunks[1]?.chunkId);
  });
});

describe("every chunk carries the highest data class among its inputs (plan §6.2)", () => {
  it("raises a chunk derived from a client_confidential input above the source's own label", async () => {
    const chunks = await chunked("Measured on site.\n", {
      dataClass: "internal",
      inputClasses: ["client_confidential"],
    });
    expect(chunks[0]?.dataClass).toBe("client_confidential");
  });

  it("can never be lowered by the caller asking for a smaller class", async () => {
    const chunks = await chunked("Restricted annex.\n", {
      dataClass: "restricted",
      inputClasses: ["internal"],
    });
    expect(chunks[0]?.dataClass).toBe("restricted");
  });

  it("carries the class through a multi-chunk document on every chunk", async () => {
    const rows = Array.from({ length: 30 }, (_unused, i) => `Row ${i} text.`).join("\n\n");
    const chunks = await chunked(rows, { maxChars: 160, dataClass: "client_confidential" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.dataClass).toBe("client_confidential");
    }
  });
});
