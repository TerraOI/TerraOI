import { describe, expect, it } from "vitest";

import { MOJIBAKE_PATTERNS, codeRanges, escapeNonAscii, findMojibake, looksBinary } from "./encoding.mjs";

/**
 * The guard #61 asked for, and its own tests. Every corrupted literal here is written as a Unicode
 * escape: this suite lives in the tree the guard scans, and a test that carried the corruption in a
 * string literal (outside a code span) would fail the very check it is proving.
 */

const MID_DOT_MOJIBAKE = "\u00c2\u00b7"; // U+00C2 U+00B7 - the middle-dot form from the incident
const SECTION_MOJIBAKE = "\u00c2\u00a7"; // U+00C2 U+00A7 - the section-sign form
const EM_DASH_MOJIBAKE = "\u00e2\u20ac\u201d"; // U+00E2 U+20AC U+201D - the em dash, CP1252 reading
const ARROW_MOJIBAKE = "\u00e2\u2020\u2019"; // U+00E2 U+2020 U+2019 - the arrow, CP1252 reading
const DIAERESIS_MOJIBAKE = "\u00c3\u00a2"; // U+00C3 U+00A2 - a two-byte lead read as Latin-1

describe("findMojibake", () => {
  it("catches each of the shapes the incident produced", () => {
    for (const bad of [MID_DOT_MOJIBAKE, SECTION_MOJIBAKE, EM_DASH_MOJIBAKE, ARROW_MOJIBAKE, DIAERESIS_MOJIBAKE]) {
      const hits = findMojibake(`Lane: 1 ${bad} Week: 1`);
      expect(hits, escapeNonAscii(JSON.stringify(bad))).toHaveLength(1);
    }
  });

  it("reports the line and column a human can jump to", () => {
    const hits = findMojibake(`line one\nsecond ${SECTION_MOJIBAKE} here`);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].column).toBe("second ".length + 1);
    expect(hits[0].snippet).toContain("second");
  });

  it("sorts hits by position, so one file's report reads top to bottom", () => {
    const hits = findMojibake(`b ${ARROW_MOJIBAKE} end\na ${MID_DOT_MOJIBAKE} start`);
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
  });

  it("exempts a code span, which is how the incident file quotes the corruption", () => {
    const text = "`·` became `" + MID_DOT_MOJIBAKE + "`";
    expect(findMojibake(text)).toEqual([]);
  });

  it("exempts a fenced block", () => {
    const text = ["explanation:", "```", "git grep " + MID_DOT_MOJIBAKE, "```"].join("\n");
    expect(findMojibake(text)).toEqual([]);
  });

  it("still reports a hit that sits outside the exempted code", () => {
    const text = ["clean `code " + MID_DOT_MOJIBAKE + "` span", "prose " + MID_DOT_MOJIBAKE + " here"].join("\n");
    const hits = findMojibake(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  it("does not fire on ordinary accented text or on the intended symbols", () => {
    // The repository plans locales (#67) and cites plan sections as §, so a guard that flagged
    // correct Unicode would be a censor, not a check.
    const clean = [
      "café naïve São Paulo Žižkov",
      "Zhāng CJK Chinese text",
      "plan §5.1 line 269, the em dash — the arrow → and the separator ·",
    ].join("\n");
    expect(findMojibake(clean)).toEqual([]);
  });
});

describe("codeRanges", () => {
  it("marks an inline span and a fenced block", () => {
    const text = "x `one` y\n\n```text\nblock\n```\n\nz";
    const ranges = codeRanges(text);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    // Order is fenced-blocks-then-inline-spans, so look the span up rather than assuming a slot.
    const slices = ranges.map(([start, end]) => text.slice(start, end));
    expect(slices).toContain("`one`");
    expect(slices.some((s) => s.startsWith("```"))).toBe(true);
  });

  it("does not let a fenced block's lone backtick swallow the rest of the file", () => {
    const text = "```\na ` b\n```\noutside `ok`\nreal " + MID_DOT_MOJIBAKE;
    expect(findMojibake(text)).toHaveLength(1);
  });
});

describe("patterns", () => {
  it("every pattern is a global regex, so matchAll cannot loop or throw", () => {
    for (const { label, re } of MOJIBAKE_PATTERNS) {
      expect(re.global, label).toBe(true);
    }
  });
});

describe("escapeNonAscii", () => {
  it("renders the corruption as escapes so the CI report cannot re-emit it", () => {
    expect(escapeNonAscii(MID_DOT_MOJIBAKE)).toBe("\\u00c2\\u00b7");
  });

  it("leaves ASCII untouched", () => {
    expect(escapeNonAscii("Status: in progress")).toBe("Status: in progress");
  });
});

describe("looksBinary", () => {
  it("treats a NUL in the first kilobytes as binary", () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))).toBe(true);
  });

  it("treats UTF-8 text as text, including text with high bytes", () => {
    expect(looksBinary(Buffer.from("café § — ·", "utf8"))).toBe(false);
  });
});
