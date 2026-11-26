import type { DocxBlock } from "./docx-extract";
import type { XlsxCell } from "./xlsx-extract";

/**
 * Artifact mapper (#135): pure functions from extractor output to the JSON shape
 * `job_api.complete_parse_job_v1` expects in `p_artifacts`. No DB writes, no RPC calls.
 *
 * Locator keys stay inside the CHECK on `extraction_artifacts.locator` (page / section / table).
 * Sheet/row/column live under `table` as a single string so the SQL CHECK does not need widening.
 */

export interface MappedArtifact {
  artifact_index: number;
  locator: {
    page?: number;
    section?: string;
    table?: string;
  };
  body_text: string;
  confidence: number | null;
  notes: unknown[];
}

export function mapDocxBlocksToArtifacts(blocks: readonly DocxBlock[], notes: readonly string[] = []): MappedArtifact[] {
  return blocks.map((block, i) => ({
    artifact_index: i,
    locator: block.sectionPath.length > 0 ? { section: block.sectionPath } : {},
    body_text: block.text.slice(0, 100000),
    confidence: null,
    notes: [...notes],
  }));
}

export function mapXlsxCellsToArtifacts(cells: readonly XlsxCell[], notes: readonly string[] = []): MappedArtifact[] {
  return cells.map((cell, i) => {
    const headerBit = cell.header ? ` under header ${cell.header}` : "";
    const table = `${cell.sheet}!${cell.column}${cell.row}${headerBit}`;
    return {
      artifact_index: i,
      locator: { table },
      body_text: cell.value.slice(0, 100000),
      confidence: null,
      notes: [...notes],
    };
  });
}

export function mapPdfPagesToArtifacts(
  pages: ReadonlyArray<{ pageNumber: number; text: string }>,
  notes: readonly string[] = [],
): MappedArtifact[] {
  return pages
    .filter((p) => p.text.trim().length > 0)
    .map((p, i) => ({
      artifact_index: i,
      locator: { page: p.pageNumber },
      body_text: p.text.slice(0, 100000),
      confidence: null,
      notes: [...notes],
    }));
}
