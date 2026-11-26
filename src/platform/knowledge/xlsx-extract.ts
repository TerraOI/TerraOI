import { MAX_DECOMPRESSED_BYTES } from "./object-validator";
import { entryText, readZipEntries } from "./ooxml-zip";

/**
 * Bounded XLSX extraction with sheet/row/column + header context (T-212). Formulas are never
 * evaluated: only the cached `<v>` value is read. Macros and external links are notes, not code.
 */

export type XlsxExtractOutcome = "extracted" | "parse_failed" | "bomb";

export interface XlsxCell {
  sheet: string;
  /** 1-based row index. */
  row: number;
  /** A1-style column, e.g. `B`. */
  column: string;
  /** Header text from row 1 of the same column, when present. */
  header: string | null;
  value: string;
}

export interface XlsxExtractResult {
  outcome: XlsxExtractOutcome;
  cells: XlsxCell[];
  notes: string[];
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const items = xml.match(/<si[\s>][\s\S]*?<\/si>/g) ?? [];
  for (const si of items) {
    const texts = [...si.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((m) => m[1] ?? "");
    out.push(texts.join(""));
  }
  return out;
}

function cellRefParts(ref: string): { col: string; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return null;
  return { col: (m[1] ?? "").toUpperCase(), row: Number(m[2]) };
}

export async function extractXlsx(bytes: Uint8Array): Promise<XlsxExtractResult> {
  const notes: string[] = [];
  const unzipped = await readZipEntries(bytes, MAX_DECOMPRESSED_BYTES);
  if (!unzipped.ok) {
    return {
      outcome: unzipped.reason === "bomb" ? "bomb" : "parse_failed",
      cells: [],
      notes: [unzipped.reason === "bomb" ? "decompression_bomb" : "malformed_xlsx"],
    };
  }

  if (unzipped.entries.some((e) => /vbaProject|macros/i.test(e.name))) {
    notes.push("macro_package_present_as_data");
  }
  if (unzipped.entries.some((e) => /externalLinks\//i.test(e.name))) {
    notes.push("external_links_present_as_data");
  }

  const sharedXml = entryText(unzipped.entries, "xl/sharedStrings.xml") ?? "";
  const shared = sharedXml.length > 0 ? parseSharedStrings(sharedXml) : [];

  const sheetEntry =
    unzipped.entries.find((e) => e.name === "xl/worksheets/sheet1.xml") ??
    unzipped.entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name));
  if (!sheetEntry) {
    return { outcome: "parse_failed", cells: [], notes: [...notes, "no_worksheet"] };
  }

  const sheetName = "Sheet1";
  const sheetXml = new TextDecoder("utf-8").decode(sheetEntry.data);
  const headers = new Map<string, string>();
  const cells: XlsxCell[] = [];

  const rows = sheetXml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? [];
  for (const rowXml of rows) {
    const cellXmls = rowXml.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) ?? [];
    for (const cXml of cellXmls) {
      const ref = /r="([A-Z]+\d+)"/i.exec(cXml)?.[1];
      if (!ref) continue;
      const parts = cellRefParts(ref);
      if (!parts) continue;

      // Formula present: keep only the cached value. Never evaluate `<f>`.
      if (/<f[\s>]/.test(cXml)) {
        notes.push("formula_cached_value_only");
      }

      const t = /t="([^"]+)"/.exec(cXml)?.[1] ?? "";
      let value = "";
      const vMatch = /<v>([^<]*)<\/v>/.exec(cXml);
      if (vMatch) {
        const raw = vMatch[1] ?? "";
        if (t === "s") {
          const idx = Number(raw);
          value = Number.isFinite(idx) ? (shared[idx] ?? "") : "";
        } else {
          value = raw;
        }
      } else {
        const inline = /<is>[\s\S]*?<t\b[^>]*>([^<]*)<\/t>/.exec(cXml)?.[1];
        if (inline !== undefined) value = inline;
      }

      if (value.length === 0) continue;

      if (parts.row === 1) {
        headers.set(parts.col, value);
      }

      cells.push({
        sheet: sheetName,
        row: parts.row,
        column: parts.col,
        header: headers.get(parts.col) ?? (parts.row === 1 ? value : null),
        value,
      });
    }
  }

  if (cells.length === 0) {
    return { outcome: "parse_failed", cells: [], notes: [...notes, "no_cells"] };
  }
  return { outcome: "extracted", cells, notes: [...new Set(notes)] };
}
