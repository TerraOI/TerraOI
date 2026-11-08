import {
  detectPdfFeatures,
  featureNotes,
  hasPdfEof,
  inflateBounded,
  isFlateOnlyChain,
  looksLikePdf,
  readStream,
  referenceNumbers,
  scanObjects,
  sliceLatin1,
  unsupportedFilterNote,
  type PdfObjectSpan,
} from "./pdf-format";

/**
 * Digital-PDF text-layer extraction (plan §7.2 step 3, F12/F32; docs/contracts/knowledge-and-jobs.md
 * "Extract").
 *
 * The contract of this module is the contract of the whole extraction step: text **with page
 * locators**, or a visible failure. An empty string is never returned as a success — a scan, a
 * CID-encoded font this parser does not cover, or a broken document comes back as
 * `no_text_layer` / `parse_failed` so the pipeline can route it to the local box (T-211) or fail it
 * loudly instead of indexing nothing and calling that "indexed".
 *
 * Nothing in the document is executed. The parser reads `/Contents` streams and text-showing
 * operators; it never looks at actions, JavaScript, Launch entries or embedded files except to
 * report that they were refused (AGENTS.md §4.8, plan §7.2 step 2: "never execute macros or document
 * instructions"). Metadata (`/Title`, `/Author`, …) is likewise never emitted as document text: a
 * string in a metadata dictionary is data about the file, not content, and treating it as content is
 * how a prompt injection gets a path into retrieval.
 *
 * A content stream is decoded only when its whole `/Filter` chain is exactly `FlateDecode`, spelled
 * as a name or as a single-element array (ISO 32000-1 §7.4, Table 6). Anything else — another
 * filter, a longer chain, a `/Filter` value that could not be read — is refused with an
 * `unsupported_filter_*` note. There is no third option, because the alternative is appending bytes
 * whose encoding was never decoded to the text layer, and that text would be quoted to users.
 */

export interface ExtractionLimits {
  /** Plan §7.5 meters the pilot goal at 100 pages; the parser refuses more rather than truncating. */
  maxPages: number;
  /** Matches the `source_versions.body_text` ceiling in 20261105070000_knowledge_core.sql. */
  maxTextChars: number;
  /** Total inflated bytes across all streams of one document. */
  maxDecompressedBytes: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxPages: 200,
  maxTextChars: 200_000,
  maxDecompressedBytes: 64 * 1024 * 1024,
};

const MAX_OBJECTS_SCANNED = 20_000;
const DICT_WINDOW = 4096;

export interface ExtractedPage {
  /** 1-based page number, taken from the page-tree order (F12 locators). */
  page: number;
  text: string;
}

export type ExtractionOutcome = "extracted" | "no_text_layer" | "parse_failed";

export interface PdfExtraction {
  outcome: ExtractionOutcome;
  pages: ExtractedPage[];
  /** Page texts joined; empty unless something was really extracted. */
  text: string;
  notes: string[];
}

function dictOf(bytes: Uint8Array, span: PdfObjectSpan): string {
  return sliceLatin1(bytes, span.bodyStart, Math.min(span.bodyEnd, span.bodyStart + DICT_WINDOW));
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

/** A PDF literal string `(...)`, with the spec's escape forms; nesting is counted, as the spec says. */
function readLiteral(content: string, at: number): { value: string; next: number } {
  let out = "";
  let depth = 1;
  let i = at + 1;
  while (i < content.length) {
    const ch = content[i] as string;
    if (ch === "\\") {
      const nextCh = content[i + 1];
      if (nextCh === undefined) break;
      if (nextCh === "\r" || nextCh === "\n") {
        // A line-continuation backslash: the newline pair is not content.
        i += 2;
        if (nextCh === "\r" && content[i] === "\n") i += 1;
        continue;
      }
      if (nextCh >= "0" && nextCh <= "7") {
        let octal = "";
        let j = i + 1;
        while (j < content.length && octal.length < 3) {
          const digit = content[j] as string;
          if (digit < "0" || digit > "7") break;
          octal += digit;
          j += 1;
        }
        out += String.fromCharCode(Number.parseInt(octal, 8));
        i = j;
        continue;
      }
      out += ESCAPES[nextCh] ?? nextCh;
      i += 2;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { value: out, next: i + 1 };
    }
    out += ch;
    i += 1;
  }
  return { value: out, next: content.length };
}

function readHex(content: string, at: number): { value: string; next: number } {
  const end = content.indexOf(">", at + 1);
  const body = content.slice(at + 1, end < 0 ? content.length : end);
  let out = "";
  let pending = "";
  for (const ch of body) {
    if (!/[0-9a-fA-F]/.test(ch)) continue;
    pending += ch;
    if (pending.length === 2) {
      out += String.fromCharCode(Number.parseInt(pending, 16));
      pending = "";
    }
  }
  if (pending) out += String.fromCharCode(Number.parseInt(pending + "0", 16));
  return { value: out, next: end < 0 ? content.length : end + 1 };
}

const isDelimiter = (ch: string): boolean => " \t\r\n\f()<>[]{}/%".includes(ch);

/**
 * Text-showing operators only: `Tj`, `TJ`, `'`, `"` yield strings; `Td`, `TD`, `T*`, `Tm` and `ET`
 * move the line, so they become newlines. Numbers (kerning, matrices) and graphics operators are
 * structure, not content, and are dropped. That is a deliberate, documented subset: it keeps page
 * locators honest without a font engine, and it cannot be steered by anything in the file.
 */
function contentText(content: string, maxChars: number): string {
  const parts: string[] = [];
  let line: string[] = [];
  let operands: string[] = [];
  let i = 0;

  const endLine = (): void => {
    if (line.length === 0) return;
    parts.push(line.join(""));
    line = [];
    parts.push("\n");
  };

  while (i < content.length) {
    const ch = content[i] as string;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\x00") {
      i += 1;
    } else if (ch === "%") {
      while (i < content.length && content[i] !== "\n" && content[i] !== "\r") i += 1;
    } else if (ch === "(") {
      const literal = readLiteral(content, i);
      operands.push(literal.value);
      i = literal.next;
    } else if (ch === "<" && content[i + 1] !== "<") {
      const hex = readHex(content, i);
      operands.push(hex.value);
      i = hex.next;
    } else if (ch === "<" && content[i + 1] === "<") {
      i += 2;
    } else if (ch === ">" && content[i - 1] !== ">") {
      i += 1;
    } else if (ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      i += 1;
    } else if (ch === "/") {
      i += 1;
      while (i < content.length && !isDelimiter(content[i] as string)) i += 1;
    } else if (/[-+.0-9]/.test(ch)) {
      while (i < content.length && /[-+.0-9eE]/.test(content[i] as string)) i += 1;
    } else if (/[A-Za-z'"*]/.test(ch)) {
      let operator = "";
      while (i < content.length && /[A-Za-z0-9'"*]/.test(content[i] as string)) {
        operator += content[i];
        i += 1;
      }
      if (operator === "Tj" || operator === "TJ") {
        if (operands.length > 0) line.push(operands.join(""));
        operands = [];
      } else if (operator === "'" || operator === '"') {
        endLine();
        if (operands.length > 0) line.push(operands.join(""));
        operands = [];
      } else if (operator === "Td" || operator === "TD" || operator === "Tm" || operator === "T*" || operator === "ET") {
        endLine();
        operands = [];
      } else if (operator === "BT") {
        operands = [];
      } else {
        operands = [];
      }
    } else {
      i += 1;
    }
  }
  endLine();
  const joined = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

function failed(notes: string[]): PdfExtraction {
  return { outcome: "parse_failed", pages: [], text: "", notes };
}

export async function extractPdfTextLayer(
  bytes: Uint8Array,
  limits?: Partial<ExtractionLimits>,
): Promise<PdfExtraction> {
  const budget: ExtractionLimits = { ...DEFAULT_EXTRACTION_LIMITS, ...limits };
  const featureNotesList = featureNotes(detectPdfFeatures(bytes));

  if (!looksLikePdf(bytes)) return failed(["not_a_pdf", ...featureNotesList]);
  if (!hasPdfEof(bytes)) return failed(["missing_eof", ...featureNotesList]);

  const scan = scanObjects(bytes, MAX_OBJECTS_SCANNED);
  if (scan.truncated) {
    // Same rule as capture: a scan we could not finish is a failure, never a partial success whose
    // missing pages would quietly become missing evidence.
    return failed(["scan_truncated", ...featureNotesList]);
  }
  const spans = scan.spans;
  const byNumber = new Map<number, PdfObjectSpan>();
  for (const span of spans) if (!byNumber.has(span.objectNumber)) byNumber.set(span.objectNumber, span);

  // Page order comes from the page tree (`/Kids` order), which is the page-number order. Object
  // order or xref order would silently renumber pages and corrupt every locator downstream.
  const catalogSpan = spans.find((span) => dictOf(bytes, span).includes("/Type /Catalog"));
  const pageTreeRoot = catalogSpan
    ? referenceNumbers(dictOf(bytes, catalogSpan), "/Pages")[0]
    : referenceNumbers(sliceLatin1(bytes, Math.max(0, bytes.length - DICT_WINDOW), bytes.length), "/Root")[0];
  if (pageTreeRoot === undefined) return failed(["no_page_tree", ...featureNotesList]);

  const pageContentRefs: number[][] = [];
  const walk = (objectNumber: number | undefined, depth: number): void => {
    if (objectNumber === undefined || depth > 16 || pageContentRefs.length > budget.maxPages) return;
    const span = byNumber.get(objectNumber);
    if (!span) return;
    const dict = dictOf(bytes, span);
    if (dict.includes("/Type /Pages")) {
      for (const kid of referenceNumbers(dict, "/Kids")) walk(kid, depth + 1);
      return;
    }
    if (dict.includes("/Type /Page")) {
      const contents = referenceNumbers(dict, "/Contents");
      if (contents.length > 0) pageContentRefs.push(contents);
    }
  };
  walk(pageTreeRoot, 0);

  if (pageContentRefs.length === 0) {
    // A document whose tree is broken or inlined: fall back to document order, which is the only
    // ordering left that keeps some page numbering honest.
    for (const span of spans) {
      const dict = dictOf(bytes, span);
      if (dict.includes("/Type /Page") && !dict.includes("/Type /Pages")) {
        const contents = referenceNumbers(dict, "/Contents");
        if (contents.length > 0) pageContentRefs.push(contents);
      }
    }
    if (pageContentRefs.length > 0) featureNotesList.push("page_tree_fallback");
  }
  if (pageContentRefs.length === 0) return failed(["no_page_tree", ...featureNotesList]);
  if (pageContentRefs.length > budget.maxPages) {
    // Plan §7.2 step 2: meter the limits before the expensive work, and fail visibly rather than
    // publishing a partial document that looks complete.
    return failed(["page_budget_exceeded", ...featureNotesList]);
  }

  let inflateBudget = budget.maxDecompressedBytes;
  let charBudget = budget.maxTextChars;
  let truncated = false;
  const pages: ExtractedPage[] = [];

  for (let index = 0; index < pageContentRefs.length; index += 1) {
    let content = "";
    for (const ref of pageContentRefs[index] as number[]) {
      const span = byNumber.get(ref);
      if (!span) continue;
      const stream = readStream(bytes, span);
      if (!stream) {
        featureNotesList.push("content_stream_missing");
        continue;
      }
      let data = stream.data;
      const chain = stream.filters;
      if (isFlateOnlyChain(chain)) {
        const inflated = await inflateBounded(data, inflateBudget);
        if (!inflated.ok) {
          return failed([inflated.reason === "budget" ? "decompression_budget_exceeded" : "stream_decode_failed", ...featureNotesList]);
        }
        inflateBudget -= inflated.data.byteLength;
        data = inflated.data;
      } else if (chain.length > 0) {
        // LZW/DCT/JPX and friends, a chain of several filters, or a `/Filter` value that could not
        // be read: a different decoder and a different budget, and silently skipping a page would be
        // an empty "successful" source — so say so, and *never* fall through to appending the stored
        // bytes. An array-spelled FlateDecode stream used to land here with `filter === null`, and
        // still-deflated bytes went out as "extracted" text with no note at all: unverified junk
        // heading for the knowledge base (AGENTS.md §4.5, §4.8).
        featureNotesList.push(unsupportedFilterNote(chain));
        continue;
      }
      // No `/Filter` entry at all: genuinely uncompressed content, read exactly as stored.
      content += sliceLatin1(data, 0, data.length);
    }

    const available = Math.max(0, charBudget - (index === 0 ? 0 : 2));
    const full = contentText(content, Number.MAX_SAFE_INTEGER);
    const text = full.slice(0, available);
    if (text.length < full.length) truncated = true;
    charBudget -= text.length + (index === 0 ? 0 : 2);
    pages.push({ page: index + 1, text });
  }

  const notes = [...featureNotesList];
  if (truncated) notes.push("text_budget_exceeded");
  const text = pages.map((page) => page.text).join("\n\n");
  if (text.length === 0) {
    // F12: scans, CID-encoded fonts and image-only pages have no text layer. Route them (T-211),
    // do not store them as an empty published source.
    return { outcome: "no_text_layer", pages, text: "", notes: [...notes, "no_text_layer"] };
  }
  return { outcome: "extracted", pages, text, notes };
}
