/**
 * Cheap text-layer quality gate for digital PDFs (T-212 / #66). Pure: no I/O.
 *
 * A near-empty layer after extraction is treated as a scan so routing can send it to the box.
 */

export type TextLayerQuality = "ok" | "low_quality" | "missing";

export interface TextLayerQualityInput {
  /** Extraction outcome from `extractPdfTextLayer`. */
  outcome: "extracted" | "no_text_layer" | "parse_failed";
  /** Concatenated page text (may be empty). */
  text: string;
  pageCount: number;
}

/** Minimum non-whitespace characters per page before we trust the layer as digital. */
export const MIN_CHARS_PER_PAGE = 40;

export function assessTextLayerQuality(input: TextLayerQualityInput): TextLayerQuality {
  if (input.outcome === "no_text_layer") return "missing";
  if (input.outcome === "parse_failed") return "missing";
  const compact = input.text.replace(/\s+/g, "");
  if (compact.length === 0) return "missing";
  const pages = Math.max(1, input.pageCount);
  if (compact.length / pages < MIN_CHARS_PER_PAGE) return "low_quality";
  return "ok";
}
