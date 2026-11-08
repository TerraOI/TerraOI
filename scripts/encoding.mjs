// Double-encoded UTF-8 detection (#61).
//
// The incident: a builder claimed a packet by editing its `Status:` line, and the edit went through a
// pipeline that decoded UTF-8 with the console codepage and re-encoded it. The middle dot `·` became
// `Â·`, the section sign `§` became `Â§`, the em dash `—` became `â€”` and the arrow `→` became
// `â†'` - quoted inside code spans, which is the documented exemption this file also defines. Three
// packet files on three open branches carried it, and `check:docs`, `check:structure`, `verify`,
// `migrations` and the `secrets` scan all passed. Packets are the files agents edit most, so this is
// the check that makes that class impossible to merge.
//
// Why the patterns are byte-shaped rather than "unusual character" heuristics: mojibake is
// specifically UTF-8 bytes that were *decoded* as Latin-1 or Windows-1252 and then *encoded* as UTF-8
// again. That always leaves a Latin-1 lead character (`Â`, `Ã`, `â`) glued directly to characters
// that can only be continuation bytes rendered as text. Correctly encoded prose - `café`, `naïve`,
// `Zhāng`, `中文`, an ordinary em dash or a plan citation `§5.1` - matches none of these, so the guard
// does not silence non-English writing, which matters in a repository that plans locales (#67).
//
// Two families are covered, because the two codepages differ in the 0x80-0x9F range: Latin-1 maps
// those bytes to C1 controls, while Windows-1252 (PowerShell's default, the one in the incident)
// maps them to typographic punctuation. The `Â`/`Ã`+control form and the `â`+punctuation form are the
// same corruption read through different codepages.

/** The Windows-1252 rendering of bytes 0x80-0x9F: never legitimate content right after Â/Ã/â. */
const CP1252_PUNCTUATION =
  "\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019" +
  "\u201c\u201d\u2014\u2015\u02dc\u2122\u0161\u203a\u0153\u017e\u0192";

/** Each entry: what to look for and a short label for the report. */
export const MOJIBAKE_PATTERNS = [
  // A0-BF decode identically in both codepages, so this catches `Â·`, `Â§`, `Â°` and friends.
  { label: "C2 lead glued to a Latin-1 continuation", re: /\u00c2[\u00a0-\u00bf]/g },
  // C3 lead with a C1 control: the Latin-1 reading of a two-byte sequence.
  { label: "C3 lead glued to a C1 control", re: /\u00c3[\u0080-\u00bf]/g },
  // C3 lead with the Windows-1252 punctuation rendering of the same byte.
  { label: "C3 lead glued to CP1252 punctuation", re: new RegExp(`\u00c3[${CP1252_PUNCTUATION}]`, "g") },
  // Three-byte sequence (E2 lead), Latin-1 reading.
  { label: "E2 lead with two C1 continuations", re: /\u00e2[\u0080-\u008f][\u0080-\u00bf]/g },
  // Three-byte sequence, Windows-1252 reading: the `â€”` and `â†'` shapes from the incident.
  {
    label: "E2 lead with CP1252 punctuation continuations",
    re: new RegExp(`\u00e2[${CP1252_PUNCTUATION}][${CP1252_PUNCTUATION}\u00a0-\u00bf]`, "g"),
  },
];

/** Ranges in `text` that are inside a fenced block or an inline code span, as [start, end) offsets. */
export function codeRanges(text) {
  const ranges = [];
  // Fenced blocks first: their content can contain stray backticks.
  for (const m of text.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ ]{0,3}\1[ \t]*$/gm)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Inline spans: a run of N backticks opens and the next run of exactly N closes (CommonMark).
  for (const m of text.matchAll(/(`+)(?:(?!\1)[\s\S])*?\1/g)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function inside(ranges, offset) {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

/**
 * Find double-encoded sequences outside code. Returns `{ line, column, label, snippet }` per hit, in
 * file order. `snippet` is a short slice of the line so a reader can find it, and it is escaped on
 * output by the caller so the report cannot itself become a source of the corruption.
 */
export function findMojibake(text) {
  const ranges = codeRanges(text);
  const hits = [];
  for (const { label, re } of MOJIBAKE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (inside(ranges, m.index)) continue;
      const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      hits.push({
        line: text.slice(0, m.index).split("\n").length,
        column: m.index - lineStart + 1,
        label,
        snippet: lineText.length > 120 ? `${lineText.slice(0, 120)}...` : lineText,
      });
    }
  }
  hits.sort((a, b) => a.line - b.line || a.column - b.column);
  return hits;
}

/** Escapes non-ASCII so a CI log shows `\u00c2\u00b7` rather than re-emitting the bytes. */
export function escapeNonAscii(value) {
  return value.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`);
}

/** Cheap "is this worth decoding as text" test, so the scanner never mangles a PNG or DOCX. */
export function looksBinary(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
