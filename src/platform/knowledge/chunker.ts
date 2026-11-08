import { type DataClass, maxDataClass } from "@/contracts/data-class";

/**
 * T-113 step 4 of plan §7.2: extracted text becomes stable, located chunks.
 *
 * What this file decides is deliberately small, because every other chunking knob is a retrieval
 * tuning decision the plan refuses to make globally (§7.2 step 4: "tune per service using retrieval
 * tests rather than one global character length"; T-403 does that tuning):
 *
 * 1. **A chunk id is a function of (source version, parser generation, ordinal, text).** The schema
 *    keys a chunk by `unique (organisation_id, source_version_id, chunk_index)`, so the ordinal is
 *    already unique within a version; hashing the tuple makes the *id itself* reproducible, which is
 *    what lets the same stage be re-run as a no-op instead of minting a second set of rows. The id
 *    is emitted in RFC 4122's textual layout with the version-4 and variant bits set so it is
 *    insertable into `knowledge_chunks.id` (`uuid`), but it is not random: it is derived from
 *    SHA-256, not from a UUIDv4 generator, and not literally UUIDv5 either (v5 is SHA-1).
 * 2. **Structure survives the split.** A heading trail is attached to every chunk of its section,
 *    and a markdown table's header row is repeated into every continuation chunk, because a chunk
 *    that quotes `| L12 | 1.4 m | rebar |` without its header is not quotable evidence (§7.2 step 4,
 *    F12 locators, and the verbatim span check plan §9.3 step 1 relies on).
 * 3. **Every chunk carries the highest class among its inputs** (plan §6.2, AGENTS.md §4.4). A chunk
 *    that quietly dropped to `internal` would be embeddable in an index it was never cleared for, so
 *    the raise happens here, before any downstream gate sees the row.
 *
 * Deliberately not done here: overlap (the plan's "limited overlap" is a tuning knob, untested, so
 * it stays out rather than being invented at a default); `token_count`, left to the caller because
 * the analyzer is a retrieval-profile decision (T-114); persistence, tenant scoping and the embed
 * gate, which are the next slice. A `restricted` chunk is kept and labelled here rather than dropped
 * — the embedding gate refuses it and `knowledge_chunks_data_class_ingestible_in_m1` refuses the
 * row, so the refusal is visible in two places instead of vanishing in one.
 *
 * Untrusted input: the text comes from an uploaded document. Nothing in this file interprets it as
 * instructions (AGENTS.md §4.8); markdown structure is recognised only as a splitting boundary.
 */

/** One page of extracted text, the shape `pdf-text-extract.ts` returns (`ExtractedPage`). */
export interface PageText {
  /** 1-based page number from the page tree; F12 locator. */
  page: number;
  text: string;
}

export interface ChunkerInput {
  sourceVersionId: string;
  parserGeneration: string;
  /** The source's own class; never lowered, whatever else is passed. */
  dataClass: DataClass;
  /** Other inputs the chunk is derived from (plan §6.2); the class of a chunk is the maximum. */
  inputClasses?: readonly DataClass[];
  /** Packing target, not a hard word count; see the module header for why it is configurable. */
  maxChars?: number;
  /** Whole-document text (page attribution unknown). */
  text?: string;
  /** Preferred when the extractor returned pages, because it keeps the F12 page locator. */
  pages?: readonly PageText[];
}

export interface Chunk {
  /** Deterministic id, RFC 4122 textual layout, derived as described in the module header. */
  chunkId: string;
  /** 0-based position within the source version: `knowledge_chunks.chunk_index`. */
  ordinal: number;
  /** Verbatim source text: a quoted span must match the document, so nothing is prepended here. */
  text: string;
  /** Heading trail from the document root down to this chunk's section. */
  headings: string[];
  dataClass: DataClass;
  /** Absent when the input was flat text with no page boundaries. */
  page?: number;
}

/**
 * A packing target for the skeleton. The plan (§7.2 step 4) wants token-sized chunks tuned per
 * service; until retrieval tests say otherwise a character target is the honest placeholder, and it
 * stays well under the `body_text` limit so a chunk is never rejected by the schema.
 */
export const DEFAULT_MAX_CHUNK_CHARS = 1200;

/** `knowledge_chunks.body_text` CHECK: char_length between 1 and 100000. */
const SCHEMA_BODY_TEXT_MAX_CHARS = 100_000;

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const TABLE_ROW = /^\s*\|.*\|/;

type BlockKind = "heading" | "paragraph" | "table";

interface Block {
  kind: BlockKind;
  level: number;
  title: string;
  lines: string[];
  page?: number;
}

function isTableSeparator(line: string): boolean {
  return line.includes("|") && line.includes("-") && /^[\s|:-]+$/.test(line);
}

/** Split one page's text into structure-aware blocks. Blank lines end a block. */
function blocksOfPage(source: string, page?: number): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", level: 0, title: "", lines: paragraph, page });
      paragraph = [];
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length,
        title: (heading[2] as string).trim(),
        lines: [line],
        page,
      });
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flushParagraph();
      const rows: string[] = [];
      while (i < lines.length) {
        const row = lines[i] as string;
        if (row.trim() === "" || !TABLE_ROW.test(row)) break;
        rows.push(row);
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: "table", level: 0, title: "", lines: rows, page });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

/**
 * Break an over-long block into pieces. A table repeats its header row (and the `---` separator,
 * which is what marks the header as a header) into every continuation piece; everything else packs
 * whole lines, because cutting mid-line would quote a fragment of the document (§9.3 verbatim span).
 */
function splitBlock(block: Block, maxChars: number): string[][] {
  if (block.lines.reduce((size, line) => size + line.length + 1, 0) <= maxChars) {
    return [block.lines];
  }
  if (block.lines.length === 1) {
    const only = block.lines[0] as string;
    if (only.length > SCHEMA_BODY_TEXT_MAX_CHARS) {
      throw new Error(
        `chunkExtractedText: one extracted line is ${only.length} characters, over the schema's body_text limit of ${SCHEMA_BODY_TEXT_MAX_CHARS}; refusing to store it rather than failing in the database`,
      );
    }
    // Nothing quotable is left if we split a single run-on line, so the cap is soft here.
    return [block.lines];
  }
  const header: string[] =
    block.kind === "table"
      ? block.lines.slice(0, isTableSeparator(block.lines[1] ?? "") ? 2 : 1)
      : [];
  const pieces: string[][] = [];
  let piece: string[] = [...header];
  let size = header.reduce((total, line) => total + line.length + 1, 0);
  for (const line of block.lines.slice(header.length)) {
    if (piece.length > header.length && size + line.length + 1 > maxChars) {
      pieces.push(piece);
      piece = [...header];
      size = header.reduce((total, l) => total + l.length + 1, 0);
    }
    piece.push(line);
    size += line.length + 1;
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A deterministic uuid-shaped id (see the module header). `crypto.subtle` is available on Workers
 * and in Node's webcrypto, so the same input yields the same id in either runtime — which matters,
 * because the ingestion worker and the test runner are different processes.
 */
async function deterministicChunkId(
  sourceVersionId: string,
  parserGeneration: string,
  ordinal: number,
  text: string,
): Promise<string> {
  const name = `${sourceVersionId}\u0000${parserGeneration}\u0000${ordinal}\u0000${text}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface Draft {
  lines: string[];
  headings: string[];
  page?: number;
  size: number;
}

/**
 * The extract stage runs more than once (a retried job, a re-parse). Because the split is a pure
 * function of the input text and the options, a re-run produces the same ordinals and the same ids,
 * which is the property the packet's "a re-run of the same stage is a no-op" acceptance test needs.
 */
export async function chunkExtractedText(input: ChunkerInput): Promise<Chunk[]> {
  const sourceVersionId = input.sourceVersionId;
  if (!sourceVersionId) throw new Error("chunkExtractedText: sourceVersionId is required");
  if (!input.parserGeneration) {
    throw new Error("chunkExtractedText: parserGeneration is required (it is part of chunk identity)");
  }
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHUNK_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > SCHEMA_BODY_TEXT_MAX_CHARS) {
    throw new Error(`chunkExtractedText: maxChars must be an integer in 1..${SCHEMA_BODY_TEXT_MAX_CHARS}`);
  }

  const blocks: Block[] = [];
  if (input.pages && input.pages.length > 0) {
    for (const page of input.pages) blocks.push(...blocksOfPage(page.text, page.page));
  } else if (typeof input.text === "string" && input.text.trim() !== "") {
    blocks.push(...blocksOfPage(input.text));
  } else {
    // An empty extraction is a parser outcome, not an empty document: the extract stage reports
    // `no_text_layer`. Chunking nothing here would create a version with no chunks that still
    // claims to be indexed.
    throw new Error(
      `chunkExtractedText: no extracted text for source version ${sourceVersionId} (pass text or pages)`,
    );
  }

  const dataClass = maxDataClass([input.dataClass, ...(input.inputClasses ?? [])]);
  const chunks: Omit<Chunk, "chunkId">[] = [];
  let draft: Draft | null = null;
  const trail: { level: number; title: string }[] = [];

  const flush = (): void => {
    if (!draft) return;
    const text = draft.lines.join("\n").trim();
    if (text !== "") {
      chunks.push({
        ordinal: chunks.length,
        text,
        headings: draft.headings,
        dataClass,
        ...(draft.page === undefined ? {} : { page: draft.page }),
      });
    }
    draft = null;
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      // A section boundary ends the current chunk: a chunk never straddles two headings, so its
      // `headings` trail is exact and its locator (F12) names one section.
      while (trail.length > 0 && (trail[trail.length - 1 as number] as { level: number }).level >= block.level) {
        trail.pop();
      }
      trail.push({ level: block.level, title: block.title });
      flush();
    }
    const blockChars = block.lines.reduce((total, line) => total + line.length + 1, 0);
    if (blockChars > maxChars) {
      flush();
      for (const piece of splitBlock(block, maxChars)) {
        chunks.push({
          ordinal: chunks.length,
          text: piece.join("\n").trim(),
          headings: trail.map((entry) => entry.title),
          dataClass,
          ...(block.page === undefined ? {} : { page: block.page }),
        });
      }
      continue;
    }
    const blockText = block.lines.join("\n");
    if (draft && draft.size + blockText.length + 1 > maxChars) flush();
    if (!draft) {
      draft = {
        lines: [],
        headings: trail.map((entry) => entry.title),
        ...(block.page === undefined ? {} : { page: block.page }),
        size: 0,
      };
    }
    draft.lines.push(blockText);
    draft.size += blockText.length + 1;
  }
  flush();

  const out: Chunk[] = [];
  for (const chunk of chunks) {
    out.push({
      chunkId: await deterministicChunkId(sourceVersionId, input.parserGeneration, chunk.ordinal, chunk.text),
      ...chunk,
    });
  }
  return out;
}
