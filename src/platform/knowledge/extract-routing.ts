import type { JobExecutor } from "@/contracts/ingestion-job";

/**
 * Pure routing decision for extract (#66 / #135): capture always queues `cloud_worker`; this
 * function says whether the cloud loop should keep the job or retarget to `local_box`.
 *
 * Images, scans and failed text layers go to the box. Digital PDF / DOCX / XLSX stay on cloud.
 */

export type RoutingKind =
  | "digital_pdf"
  | "docx"
  | "xlsx"
  | "image"
  | "scanned_pdf"
  | "failed_text_layer"
  | "unsupported";

export interface RoutingInput {
  mediaType: string | null;
  /** From PDF text-layer extraction / quality check; ignored for non-PDF. */
  textLayer?: "ok" | "missing" | "failed" | "low_quality";
}

export interface RoutingDecision {
  kind: RoutingKind;
  executor: JobExecutor | null;
  /** Safe reason when unsupported; null when an executor was chosen. */
  reason: "unsupported_type" | null;
}

export function decideExtractRoute(input: RoutingInput): RoutingDecision {
  const media = input.mediaType ?? "";
  if (media === "application/pdf") {
    if (input.textLayer === "missing" || input.textLayer === "low_quality") {
      return { kind: "scanned_pdf", executor: "local_box", reason: null };
    }
    if (input.textLayer === "failed") {
      return { kind: "failed_text_layer", executor: "local_box", reason: null };
    }
    return { kind: "digital_pdf", executor: "cloud_worker", reason: null };
  }
  if (media === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return { kind: "docx", executor: "cloud_worker", reason: null };
  }
  if (media === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return { kind: "xlsx", executor: "cloud_worker", reason: null };
  }
  if (
    media === "image/png" ||
    media === "image/jpeg" ||
    media === "image/tiff" ||
    media === "image/heic"
  ) {
    return { kind: "image", executor: "local_box", reason: null };
  }
  return { kind: "unsupported", executor: null, reason: "unsupported_type" };
}
