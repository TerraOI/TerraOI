import { MAX_DECOMPRESSED_BYTES } from "./object-validator";
import { entryText, readZipEntries } from "./ooxml-zip";

/**
 * Bounded DOCX text extraction with section-path locators (T-212). Macros, external links and
 * instruction text inside the package are never executed — only `word/document.xml` text runs are
 * read (AGENTS.md §4.8).
 */

export type DocxExtractOutcome = "extracted" | "parse_failed" | "bomb";

export interface DocxBlock {
  /** Heading / clause path, e.g. `1.2. Pre-flight`. Empty for body paragraphs under no heading. */
  sectionPath: string;
  text: string;
}

export interface DocxExtractResult {
  outcome: DocxExtractOutcome;
  blocks: DocxBlock[];
  notes: string[];
}

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\uFFFD";
}

function stripTags(xml: string): string {
  return xml
    .replace(/<w:tab\b[^]*?\/>/g, "\t")
    .replace(/<w:br\b[^]*?\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => codePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d{1,7});/g, (_, n: string) => codePoint(Number(n)))
    // `&amp;` last, so `&amp;#60;` stays the literal text `&#60;` instead of decoding twice.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function paragraphText(pXml: string): string {
  const parts: string[] = [];
  const re = /<w:t\b[^>]*>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml)) !== null) {
    parts.push(m[1] ?? "");
  }
  return stripTags(parts.join(""));
}

function headingLevel(pXml: string): number | null {
  const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(pXml)?.[1] ?? "";
  const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(pXml)?.[1];
  if (outline !== undefined) return Number(outline) + 1;
  const m = /^Heading(\d+)$/i.exec(style) ?? /^heading\s*(\d+)$/i.exec(style);
  if (m) return Number(m[1]);
  return null;
}

export async function extractDocx(bytes: Uint8Array): Promise<DocxExtractResult> {
  const notes: string[] = [];
  const unzipped = await readZipEntries(bytes, MAX_DECOMPRESSED_BYTES);
  if (!unzipped.ok) {
    return {
      outcome: unzipped.reason === "bomb" ? "bomb" : "parse_failed",
      blocks: [],
      notes: [unzipped.reason === "bomb" ? "decompression_bomb" : "malformed_docx"],
    };
  }

  // Presence of vbaProject / macros is recorded as data, never run.
  if (unzipped.entries.some((e) => /vbaProject|macros/i.test(e.name))) {
    notes.push("macro_package_present_as_data");
  }
  if (unzipped.entries.some((e) => /externalLinks\//i.test(e.name))) {
    notes.push("external_links_present_as_data");
  }

  const documentXml = entryText(unzipped.entries, "word/document.xml");
  if (documentXml === null) {
    return { outcome: "parse_failed", blocks: [], notes: [...notes, "missing_document_xml"] };
  }

  const blocks: DocxBlock[] = [];
  const path: string[] = [];
  const paragraphs = documentXml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
  for (const p of paragraphs) {
    const text = paragraphText(p);
    if (text.length === 0) continue;
    const level = headingLevel(p);
    if (level !== null) {
      while (path.length >= level) path.pop();
      path.push(text);
      blocks.push({ sectionPath: path.join(" / "), text });
    } else {
      blocks.push({ sectionPath: path.join(" / "), text });
    }
  }

  if (blocks.length === 0) {
    return { outcome: "parse_failed", blocks: [], notes: [...notes, "no_text_runs"] };
  }
  return { outcome: "extracted", blocks, notes };
}
