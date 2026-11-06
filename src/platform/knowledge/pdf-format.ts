// Byte-level PDF reading (plan §7.2 step 3, F12/F32).
//
// A deliberately small in-house subset of ISO 32000: enough structure to find the page tree, read a
// page's content streams and decode FlateDecode, using Workers-safe primitives only (typed arrays
// plus CompressionStream — no fs, no child_process, no native modules, no dependency).
//
// What it is *not* is the point. This is an observer of bytes, not a renderer and not an
// interpreter: no xref/table repair, no CMap or Identity-H glyph decoding, no forms, no actions, no
// JavaScript, no embedded-file handling. A PDF is untrusted input (AGENTS.md §4.8), so nothing found
// inside one is ever treated as a command or executed; the feature probes below exist precisely to
// report that such content was refused.

/** A PDF file starts with `%PDF-` (a small binary or comment prefix before it is legal). */
export const PDF_SIGNATURE = "%PDF-";
const SIGNATURE_WINDOW = 1024;

export type PdfFeature = "encrypted" | "active_content" | "embedded_files";

export interface PdfObjectSpan {
  objectNumber: number;
  /** Byte offset just after `N G obj`. */
  bodyStart: number;
  /** Byte offset just before the matching `endobj`. */
  bodyEnd: number;
}

export interface PdfStreamData {
  /** The object dictionary, as latin1 text (structure only — its content is untrusted data). */
  dict: string;
  data: Uint8Array;
  filter: string | null;
}

export function indexOfAscii(haystack: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  for (let i = from; i <= haystack.length - needle.length; i += 1) {
    if (haystack[i] !== first) continue;
    let matched = true;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

/** Decodes a byte slice as latin1, so one byte is one character (PDF strings are byte strings). */
export function sliceLatin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  const stop = Math.min(end, bytes.length);
  for (let i = start; i < stop; i += 1) out += String.fromCharCode(bytes[i] as number);
  return out;
}

const isDigit = (code: number | undefined): boolean => code !== undefined && code >= 0x30 && code <= 0x39;
const isWhitespace = (code: number | undefined): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;

/**
 * Lists indirect objects in file order, up to `maxObjects`. A stream body is skipped by its
 * `/Length`, because stream payload bytes may contain the words `endobj` or `endstream`; a stream
 * whose `/Length` lies is recovered by scanning for `endstream` (the usual case in damaged writers).
 *
 * `truncated` is part of the contract, not an optimization detail: it says "there may be more
 * objects after the last one I returned". Every caller has to fail closed on it — a document with
 * 100,000 streams whose payload lives in stream #99,001 is exactly how a partial check turns into a
 * false "verified" (the seam this function's cap would otherwise create).
 */
export interface PdfObjectScan {
  spans: PdfObjectSpan[];
  truncated: boolean;
}

export function scanObjects(bytes: Uint8Array, maxObjects: number): PdfObjectScan {
  const objects: PdfObjectSpan[] = [];
  let cursor = 0;
  for (;;) {
    const keyword = indexOfAscii(bytes, "obj", cursor);
    if (keyword < 0) return { spans: objects, truncated: false };
    if (objects.length >= maxObjects) return { spans: objects, truncated: true };
    // Read `<number> <generation> obj` backwards from the keyword.
    let p = keyword - 1;
    while (p >= 0 && isWhitespace(bytes[p])) p -= 1;
    const genEnd = p + 1;
    while (p >= 0 && isDigit(bytes[p])) p -= 1;
    const genStart = p + 1;
    if (genStart === genEnd) {
      cursor = keyword + 3;
      continue;
    }
    while (p >= 0 && isWhitespace(bytes[p])) p -= 1;
    const numEnd = p + 1;
    while (p >= 0 && isDigit(bytes[p])) p -= 1;
    const numStart = p + 1;
    if (numStart === numEnd) {
      cursor = keyword + 3;
      continue;
    }
    const objectNumber = Number(sliceLatin1(bytes, numStart, numEnd));
    const bodyStart = keyword + 3;
    let bodyEnd = indexOfAscii(bytes, "endobj", bodyStart);
    const streamAt = indexOfAscii(bytes, "stream", bodyStart);
    if (streamAt >= 0 && (bodyEnd < 0 || streamAt < bodyEnd)) {
      const dict = sliceLatin1(bytes, bodyStart, streamAt);
      const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
      let dataStart = streamAt + "stream".length;
      if (bytes[dataStart] === 0x0d) dataStart += 1;
      if (bytes[dataStart] === 0x0a) dataStart += 1;
      const declared = lengthMatch ? Number(lengthMatch[1]) : Number.NaN;
      const dataEnd =
        Number.isFinite(declared) && dataStart + declared <= bytes.length
          ? dataStart + declared
          : Math.max(dataStart, indexOfAscii(bytes, "endstream", dataStart));
      const afterStream = indexOfAscii(bytes, "endobj", dataEnd);
      bodyEnd = afterStream >= 0 ? afterStream : bytes.length;
    }
    if (bodyEnd < 0) return { spans: objects, truncated: true };
    objects.push({ objectNumber, bodyStart, bodyEnd });
    cursor = bodyEnd + "endobj".length;
  }
}

/** The dictionary + payload of one indirect object, or null when it carries no stream. */
export function readStream(bytes: Uint8Array, span: PdfObjectSpan): PdfStreamData | null {
  const streamAt = indexOfAscii(bytes, "stream", span.bodyStart);
  if (streamAt < 0 || streamAt > span.bodyEnd) return null;
  const dict = sliceLatin1(bytes, span.bodyStart, streamAt);
  let dataStart = streamAt + "stream".length;
  if (bytes[dataStart] === 0x0d) dataStart += 1;
  if (bytes[dataStart] === 0x0a) dataStart += 1;
  const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
  const declared = lengthMatch ? Number(lengthMatch[1]) : Number.NaN;
  const dataEnd =
    Number.isFinite(declared) && dataStart + declared <= span.bodyEnd + 64
      ? Math.min(dataStart + declared, span.bodyEnd)
      : indexOfAscii(bytes, "endstream", dataStart);
  if (dataEnd < 0 || dataEnd < dataStart) return null;
  const filterMatch = /\/Filter\s*\/([A-Za-z0-9._]+)/.exec(dict);
  return { dict, data: bytes.subarray(dataStart, dataEnd), filter: filterMatch ? (filterMatch[1] as string) : null };
}

export type InflateResult = { ok: true; data: Uint8Array } | { ok: false; reason: "budget" | "corrupt" };

/**
 * zlib inflate with a hard output cap (plan §7.2 step 2: decompression limits). A stream that
 * expands past the budget is stopped *while it is being read* and reported as `budget` — that is
 * the ZIP-bomb case, and the payload is never buffered whole. `corrupt` means the bytes are not a
 * zlib stream at all, which is a damaged document rather than an attack.
 */
export async function inflateBounded(data: Uint8Array, budgetBytes: number): Promise<InflateResult> {
  if (budgetBytes <= 0) return { ok: false, reason: "budget" };
  try {
    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();
    // The write is not awaited on purpose: a producer that never gets consumed must not make the
    // reader wait forever, and a rejected write is handled by the error path below.
    // The cast is the `ArrayBuffer` vs `ArrayBufferLike` view typing of the WebStreams spec, not a
    // widening: `data` is a plain byte array here.
    void writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined);
    void writer.close().catch(() => undefined);
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > budgetBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "budget" };
      }
      chunks.push(value);
    }
    let size = 0;
    for (const chunk of chunks) size += chunk.byteLength;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, data: out };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

const FEATURE_TOKENS: Record<PdfFeature, readonly string[]> = {
  encrypted: ["/Encrypt"],
  active_content: ["/JavaScript", "/OpenAction", "/AA ", "/Launch", "/XFA"],
  embedded_files: ["/EmbeddedFile", "/Filespec"],
};

/**
 * Which dangerous PDF facilities this file mentions. Detection is a byte scan, because a PDF is
 * untrusted input: the answer decides what is *reported*, never what is *run* (AGENTS.md §4.8).
 */
export function detectPdfFeatures(bytes: Uint8Array): Set<PdfFeature> {
  const found = new Set<PdfFeature>();
  for (const feature of Object.keys(FEATURE_TOKENS) as PdfFeature[]) {
    for (const token of FEATURE_TOKENS[feature]) {
      if (indexOfAscii(bytes, token) >= 0) {
        found.add(feature);
        break;
      }
    }
  }
  return found;
}

/** Metadata a reviewer must see: the file offered these facilities and the parser refused them. */
export function featureNotes(features: Set<PdfFeature>): string[] {
  const notes: string[] = [];
  if (features.has("active_content")) notes.push("active_content_refused");
  if (features.has("embedded_files")) notes.push("embedded_files_refused");
  return notes;
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  const at = indexOfAscii(bytes, PDF_SIGNATURE);
  return at >= 0 && at < SIGNATURE_WINDOW;
}

export function hasPdfEof(bytes: Uint8Array): boolean {
  const from = Math.max(0, bytes.length - SIGNATURE_WINDOW);
  return indexOfAscii(bytes, "%%EOF", from) >= 0;
}

/** `/Kids [ 3 0 R 5 0 R ... ]` — the page-tree order, which is the page-number order (F12). */
export function referenceNumbers(text: string, entry: string): number[] {
  const start = text.indexOf(entry);
  if (start < 0) return [];
  const inline = new RegExp(`${entry}\\s+(\\d+)\\s+\\d+\\s+R`).exec(text.slice(start));
  if (inline) return [Number(inline[1])];
  const bracketStart = text.indexOf("[", start + entry.length);
  if (bracketStart < 0) return [];
  const bracketEnd = text.indexOf("]", bracketStart);
  if (bracketEnd < 0) return [];
  const inside = text.slice(bracketStart + 1, bracketEnd);
  const refs: number[] = [];
  for (const match of inside.matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(match[1]));
  return refs;
}
