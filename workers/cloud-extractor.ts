import {
  mapDocxBlocksToArtifacts,
  mapPdfPagesToArtifacts,
  mapXlsxCellsToArtifacts,
  type MappedArtifact,
} from "@/platform/knowledge/artifact-mapper";
import { extractDocx } from "@/platform/knowledge/docx-extract";
import { decideExtractRoute } from "@/platform/knowledge/extract-routing";
import {
  DOCX_MEDIA,
  MAX_DECOMPRESSED_BYTES,
  XLSX_MEDIA,
  sniffSignature,
} from "@/platform/knowledge/object-validator";
import { entryText, readZipEntries } from "@/platform/knowledge/ooxml-zip";
import { extractPdfTextLayer } from "@/platform/knowledge/pdf-text-extract";
import { assessTextLayerQuality } from "@/platform/knowledge/text-layer-quality";
import { extractXlsx } from "@/platform/knowledge/xlsx-extract";

import type {
  ArtifactInput,
  ExtractorPort,
  ExtractorResult,
  RetargetReason,
} from "./ocr-pull";

/**
 * T-211 cloud `ExtractorPort` over T-212's pure extractors + mapper (#135).
 *
 * Bytes are sniffed here (the job payload carries no media type). Images and weak PDF text
 * layers retarget to the box; DOCX/XLSX/digital PDF complete in-process. No DB writes.
 */

function toArtifactInputs(mapped: readonly MappedArtifact[]): ArtifactInput[] {
  return mapped.map((row) => {
    const locatorKeys = Object.keys(row.locator);
    const notes = row.notes.filter((n): n is string => typeof n === "string" && n.length > 0);
    return {
      artifactIndex: row.artifact_index,
      bodyText: row.body_text,
      ...(locatorKeys.length > 0 ? { locator: row.locator as Record<string, unknown> } : {}),
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      ...(notes.length > 0 ? { notes } : {}),
    };
  });
}

async function resolveZipMediaType(
  bytes: Uint8Array,
): Promise<{ mediaType: string; notes: string[] } | { failed: "bomb" | "unsupported"; notes: string[] }> {
  const unzipped = await readZipEntries(bytes, MAX_DECOMPRESSED_BYTES);
  if (!unzipped.ok) {
    return {
      failed: unzipped.reason === "bomb" ? "bomb" : "unsupported",
      notes: [unzipped.reason === "bomb" ? "decompression_bomb" : "malformed_zip"],
    };
  }
  const notes: string[] = [];
  if (unzipped.entries.some((e) => /vbaProject|macros/i.test(e.name))) {
    notes.push("macro_package_present_as_data");
  }
  const typesXml = entryText(unzipped.entries, "[Content_Types].xml") ?? "";
  if (
    /wordprocessingml\.document\.main\+xml/i.test(typesXml) ||
    unzipped.entries.some((e) => e.name === "word/document.xml")
  ) {
    return { mediaType: DOCX_MEDIA, notes };
  }
  if (
    /spreadsheetml\.sheet\.main\+xml/i.test(typesXml) ||
    unzipped.entries.some((e) => e.name.startsWith("xl/"))
  ) {
    return { mediaType: XLSX_MEDIA, notes };
  }
  return { failed: "unsupported", notes: [...notes, "zip_not_ooxml"] };
}

function retarget(reason: RetargetReason, notes: readonly string[] = []): ExtractorResult {
  return { outcome: "needs_local_box", reason, ...(notes.length > 0 ? { notes: [...notes] } : {}) };
}

function unsupported(notes: readonly string[] = []): ExtractorResult {
  return {
    outcome: "unsupported",
    reason: "unsupported_document",
    ...(notes.length > 0 ? { notes: [...notes] } : {}),
  };
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractorResult> {
  const pdf = await extractPdfTextLayer(bytes);
  const quality = assessTextLayerQuality({
    outcome: pdf.outcome,
    text: pdf.text,
    pageCount: pdf.pages.length,
  });

  const route = decideExtractRoute({
    mediaType: "application/pdf",
    textLayer:
      pdf.outcome === "parse_failed"
        ? "failed"
        : quality === "ok"
          ? "ok"
          : quality === "low_quality"
            ? "low_quality"
            : "missing",
  });

  if (route.executor === "local_box") {
    if (pdf.notes.includes("page_budget_exceeded")) {
      return retarget("over_page_count", pdf.notes);
    }
    if (quality === "low_quality") return retarget("too_few_chars", pdf.notes);
    if (pdf.outcome === "parse_failed") return retarget("parse_failed", pdf.notes);
    if (quality === "missing") return retarget("no_text_layer", pdf.notes);
    return retarget("quality_failed", pdf.notes);
  }

  if (pdf.outcome !== "extracted" || pdf.pages.length === 0) {
    return retarget("no_text_layer", pdf.notes);
  }

  const artifacts = toArtifactInputs(
    mapPdfPagesToArtifacts(
      pdf.pages.map((p) => ({ pageNumber: p.page, text: p.text })),
      pdf.notes,
    ),
  );
  if (artifacts.length === 0) return retarget("no_text_layer", pdf.notes);
  return { outcome: "extracted", artifacts, notes: pdf.notes };
}

async function extractOffice(
  bytes: Uint8Array,
  mediaType: string,
  prefixNotes: readonly string[],
): Promise<ExtractorResult> {
  if (mediaType === DOCX_MEDIA) {
    const result = await extractDocx(bytes);
    const notes = [...prefixNotes, ...result.notes];
    if (result.outcome === "bomb") {
      return unsupported([...notes, "decompression_bomb"]);
    }
    if (result.outcome !== "extracted" || result.blocks.length === 0) {
      return unsupported(notes);
    }
    const artifacts = toArtifactInputs(mapDocxBlocksToArtifacts(result.blocks, notes));
    if (artifacts.length === 0) return unsupported(notes);
    return { outcome: "extracted", artifacts, notes };
  }

  if (mediaType === XLSX_MEDIA) {
    const result = await extractXlsx(bytes);
    const notes = [...prefixNotes, ...result.notes];
    if (result.outcome === "bomb") {
      return unsupported([...notes, "decompression_bomb"]);
    }
    if (result.outcome !== "extracted" || result.cells.length === 0) {
      return unsupported(notes);
    }
    const artifacts = toArtifactInputs(mapXlsxCellsToArtifacts(result.cells, notes));
    if (artifacts.length === 0) return unsupported(notes);
    return { outcome: "extracted", artifacts, notes };
  }

  return unsupported(prefixNotes);
}

export function createCloudExtractor(): ExtractorPort {
  return {
    async extract(input): Promise<ExtractorResult> {
      const { bytes } = input;
      if (bytes.length === 0) return unsupported(["empty_object"]);

      const guess = sniffSignature(bytes);
      if (guess.family === "portable_executable") {
        return unsupported(["signature_mismatch"]);
      }

      if (guess.family === "image") {
        return retarget("unsupported_filter", ["image_requires_local_box"]);
      }

      if (guess.family === "pdf" || guess.mediaType === "application/pdf") {
        return extractPdf(bytes);
      }

      if (guess.family === "zip") {
        const ooxml = await resolveZipMediaType(bytes);
        if ("failed" in ooxml) {
          if (ooxml.failed === "bomb") return unsupported(ooxml.notes);
          return unsupported(ooxml.notes);
        }
        const route = decideExtractRoute({ mediaType: ooxml.mediaType });
        if (route.executor !== "cloud_worker") {
          return unsupported(ooxml.notes);
        }
        return extractOffice(bytes, ooxml.mediaType, ooxml.notes);
      }

      return unsupported(["unsupported_type"]);
    },
  };
}
