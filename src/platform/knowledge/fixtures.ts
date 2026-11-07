// Synthetic byte fixtures for the knowledge tests (AGENTS.md §4.7).
//
// Every pattern here is generated for this repository: no real client document, no real malware,
// no real credential. `buildSyntheticPdf` emits structurally valid digital-PDF bytes (catalog,
// page tree, page objects, uncompressed or FlateDecode content streams) so the in-house extractor
// and the validator are tested against actual PDF structure rather than a mock. The unsafe
// fixtures — a PE header, a standard-security encryption dictionary, a stream that expands far
// past its stored length — exist so the negative tests exercise real signatures instead of file
// names, which is exactly the trap plan §7.2 step 2 warns about.
//
// Test support only: no production module imports this file.

/** Bytes of an ASCII string, one char per byte (all fixtures are ASCII by construction). */
export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** zlib-wrapped deflate, the same transform PDF FlateDecode streams use. */
export async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  await writer.write(bytes as Uint8Array<ArrayBuffer>);
  await writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A `MZ` portable-executable header: what a ".pdf" that is really an .exe starts with. */
export function syntheticExecutableBytes(): Uint8Array {
  const header = new Uint8Array(512);
  header.set(ascii("MZ"), 0);
  header.set(ascii("synthetic fixture — not a document, not malware, just a PE header"), 64);
  // e_lfanew at 0x3c: a fake PE header offset, so the bytes look like an executable, not text.
  header[0x3c] = 0x80;
  return header;
}

/** `PK\x03\x04`: a ZIP container (DOCX/XLSX are ZIP; T-212 owns them). */
export function syntheticZipBytes(): Uint8Array {
  return concatBytes([ascii("PK\x03\x04"), ascii("\x14\x00\x00\x00\x08\x00"), ascii("synthetic zip fixture")]);
}

/** A PNG header: an image, which this packet never ingests (scans go to T-211/T-212). */
export function syntheticPngBytes(): Uint8Array {
  const header = new Uint8Array(24);
  header[0] = 0x89;
  header.set(ascii("PNG\r\n\x1a\n"), 1);
  header.set(ascii("IHDR"), 12);
  return header;
}

/**
 * How the `/Filter` entry of a content stream is spelled. ISO 32000-1 §7.4 (Table 6) allows a name
 * *or* an array of names, and real writers emit both, so every spelling has to be testable without
 * hand-writing PDF bytes in the test file.
 */
export type PdfFilterSyntax = "name" | "array" | "array_spaced";

export interface PdfPageSpec {
  /** Text lines shown with `Tj`; each line is escaped for a PDF literal string. */
  lines?: string[];
  /** Raw content-stream operators, for tokenizing and adversarial cases. */
  content?: string;
  /** Store this page's content stream with /Filter /FlateDecode, spelled per `filterSyntax`. */
  compressed?: boolean;
  /**
   * The spelling of the `/Filter` entry: `/Filter /FlateDecode` (the default, and the only spelling
   * this builder emitted before the option existed), `/Filter [/FlateDecode]`, or
   * `/Filter [ /FlateDecode ]`.
   */
  filterSyntax?: PdfFilterSyntax;
  /**
   * The whole filter chain to write instead of the single FlateDecode entry, in the order the spec
   * decodes it — e.g. `["ASCII85Decode", "FlateDecode"]`. One name is written as a name, several as
   * an array (spaced per `filterSyntax`). The payload is zlib-deflated when `compressed` is set or
   * when the chain starts with FlateDecode: the fixture emits what a real writer *claims* in the
   * dictionary, which is exactly what a parser that cannot decode that chain has to cope with.
   */
  filters?: readonly string[];
}

export interface PdfSpec {
  pages?: PdfPageSpec[];
  /** `/Info << /Title ... >>`: metadata, which must stay data and never become text or a command. */
  title?: string;
  /** Adds a `/JavaScript` action wired through `/OpenAction` and `/AA`. */
  javascript?: string;
  /** Adds a `/Launch` action (an external-program action) to `/AA`. */
  launch?: boolean;
  /** Adds an `/EmbeddedFiles` name tree with a filespec and an attached stream. */
  embeddedFile?: boolean;
  /** Adds a `/Encrypt` reference in the trailer plus a Standard security dictionary. */
  encrypted?: boolean;
  /** Drops the `%%EOF` marker: a truncated or non-PDF-shaped tail. */
  missingEof?: boolean;
  /** Emits one content stream whose literal text expands to this many bytes (bomb fixture). */
  expandContentToBytes?: number;
  /**
   * Emits this many extra FlateDecode objects *after* the pages: filler that a bounded structural
   * scan must count, used with `bombStreamBytes` to place a bomb past the scan cap.
   */
  fillerStreams?: number;
  /** Emits a final FlateDecode object that inflates to this many bytes (past every filler). */
  bombStreamBytes?: number;
}

function pdfLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return `(${out})`;
}

function contentOperators(page: PdfPageSpec): string {
  if (page.content !== undefined) return page.content;
  const lines = page.lines ?? [];
  const shows = lines.map((line) => `${pdfLiteral(line)} Tj T*`).join(" ");
  return `BT /F1 12 Tf 72 720 Td 12 TL ${shows} ET`;
}

/**
 * The `/Filter` entry for one content stream, in the spelling the spec allows. An empty chain means
 * the stream carries no `/Filter` at all (genuinely uncompressed), which is a different case from
 * "filtered" and must stay distinguishable in tests.
 */
function filterEntry(chain: readonly string[], syntax: PdfFilterSyntax = "name"): string {
  if (chain.length === 0) return "";
  const names = chain.map((name) => `/${name}`).join(" ");
  if (chain.length === 1 && syntax === "name") return ` /Filter ${names}`;
  return syntax === "array_spaced" ? ` /Filter [ ${names} ]` : ` /Filter [${names}]`;
}

/**
 * Builds a small digital PDF. Object numbers are stable (catalog 1, page tree 2, font 3, then
 * pages and their content streams) and the special fixtures live at 90+ so a test can name them.
 * No xref table is written: the extractor walks the page tree from the catalog, and a missing
 * xref must not change what a well-formed document yields.
 */
export async function buildSyntheticPdf(spec: PdfSpec): Promise<Uint8Array> {
  const pages = spec.pages ?? [{ lines: ["Synthetic page one."] }];
  const pageCount = pages.length;
  const firstPage = 4;
  const firstContent = firstPage + pageCount;

  // Optional feature objects live at 90+, so a test can name them without counting pages.
  const jsAction = 90;
  const launchAction = 91;
  const filespec = 92;
  const filespecStream = 93;
  const encryptDict = 94;
  const infoDict = 95;

  const catalogExtras: string[] = [];
  if (spec.javascript !== undefined) {
    catalogExtras.push(`/OpenAction ${jsAction} 0 R`, spec.launch ? `/AA << /O ${jsAction} 0 R /C ${launchAction} 0 R >>` : `/AA << /O ${jsAction} 0 R >>`);
  }
  if (spec.launch && spec.javascript === undefined) {
    catalogExtras.push(`/AA << /C ${launchAction} 0 R >>`);
  }
  if (spec.embeddedFile) catalogExtras.push(`/Names << /EmbeddedFiles << /Names [(synthetic-payload.bin) ${filespec} 0 R] >> >>`);

  const parts: Uint8Array[] = [ascii("%PDF-1.7\n")];
  const add = (body: string): void => {
    parts.push(ascii(body));
  };

  add(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${catalogExtras.join(" ")} >>\nendobj\n`);
  const kids = pages.map((_, i) => `${firstPage + i} 0 R`).join(" ");
  add(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  add("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");

  for (let i = 0; i < pageCount; i += 1) {
    add(
      `${firstPage + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${firstContent + i} 0 R >>\nendobj\n`,
    );
  }

  if (spec.javascript !== undefined) {
    add(`${jsAction} 0 obj\n<< /S /JavaScript /JS ${pdfLiteral(spec.javascript)} >>\nendobj\n`);
  }
  if (spec.launch) {
    add(
      `${launchAction} 0 obj\n<< /S /Launch /F (synthetic-external-program.exe) ` +
        `/Win << /F (synthetic-external-program.exe) >> >>\nendobj\n`,
    );
  }
  if (spec.embeddedFile) {
    const payload = "synthetic embedded payload: data, never a command";
    add(`${filespec} 0 obj\n<< /Type /Filespec /F (synthetic-payload.bin) /EF << /F ${filespecStream} 0 R >> >>\nendobj\n`);
    add(`${filespecStream} 0 obj\n<< /Length ${payload.length} >>\nstream\n${payload}\nendstream\nendobj\n`);
  }

  for (let i = 0; i < pageCount; i += 1) {
    const page = pages[i] as PdfPageSpec;
    const text =
      spec.expandContentToBytes !== undefined && i === pageCount - 1
        ? // One huge literal string: a tiny compressed stream that blows the decompression budget.
          `BT /F1 12 Tf 72 720 Td ${pdfLiteral("A".repeat(spec.expandContentToBytes))} Tj ET`
        : contentOperators(page);
    const raw = ascii(text);
    const chain = page.filters ?? (page.compressed === true ? ["FlateDecode"] : []);
    const packed = page.compressed === true || chain[0] === "FlateDecode";
    const body = packed ? await deflateZlib(raw) : raw;
    const dict = `<< /Length ${body.byteLength}${filterEntry(chain, page.filterSyntax)} >>`;
    parts.push(ascii(`${firstContent + i} 0 obj\n${dict}\nstream\n`));
    parts.push(body);
    parts.push(ascii("\nendstream\nendobj\n"));
  }

  if (spec.fillerStreams !== undefined && spec.fillerStreams > 0) {
    // Unreferenced but structurally valid FlateDecode objects: they force a scanner to walk them.
    const fillerPayload = await deflateZlib(ascii("BT ET"));
    for (let n = 0; n < spec.fillerStreams; n += 1) {
      parts.push(
        ascii(`${500 + n} 0 obj\n<< /Length ${fillerPayload.byteLength} /Filter /FlateDecode >>\nstream\n`),
      );
      parts.push(fillerPayload);
      parts.push(ascii("\nendstream\nendobj\n"));
    }
  }
  if (spec.bombStreamBytes !== undefined && spec.bombStreamBytes > 0) {
    const huge = ascii("A".repeat(spec.bombStreamBytes));
    const packed = await deflateZlib(huge);
    parts.push(ascii(`900 0 obj\n<< /Length ${packed.byteLength} /Filter /FlateDecode >>\nstream\n`));
    parts.push(packed);
    parts.push(ascii("\nendstream\nendobj\n"));
  }

  if (spec.encrypted) {
    add(
      `${encryptDict} 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 ` +
        `/O <61626364656600000000000000000000> /U <6768696a6b6c00000000000000000000> >>\nendobj\n`,
    );
    add(`trailer\n<< /Size ${encryptDict + 1} /Root 1 0 R /Encrypt ${encryptDict} 0 R >>\n`);
  } else if (spec.title !== undefined) {
    add(`${infoDict} 0 obj\n<< /Title ${pdfLiteral(spec.title)} /Producer (synthetic fixture) >>\nendobj\n`);
    add(`trailer\n<< /Size ${infoDict + 1} /Root 1 0 R /Info ${infoDict} 0 R >>\n`);
  } else {
    add(`trailer\n<< /Size ${firstContent + pageCount} /Root 1 0 R >>\n`);
  }

  if (!spec.missingEof) parts.push(ascii("startxref\n0\n%%EOF\n"));
  return concatBytes(parts);
}
