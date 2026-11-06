import type { ObjectReadResult } from "./object-store";
import {
  detectPdfFeatures,
  featureNotes,
  hasPdfEof,
  inflateBounded,
  indexOfAscii,
  looksLikePdf,
  readStream,
  scanObjects,
} from "./pdf-format";

/**
 * Capture verification (plan §7.2 steps 1–2, F09/F10; §9.2.1 `POST /api/knowledge/uploads/:id/complete`).
 *
 * Everything the client asserted about the object — its name, its extension, its declared size, the
 * hash it computed — is a *claim*. This module decides the facts: what the bytes actually are, how
 * many of them there are, and what digest they really have. The order below is the cheap-first order
 * of the pilot-inquiry handler: a missing or oversized object never costs a hash, and a file whose
 * signature is wrong never costs a decompression.
 *
 * A failure is never silent and never partial: the caller either gets a verified object it may
 * capture, or a safe reason code that says why nothing was captured (plan §7.2: "a failed parse is
 * visible, not an empty successful source").
 */

/** Plan §7.5: the pilot goal is an ordinary document up to 20 MB / 100 pages. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Plan §7.2 step 2: a real PDF inflates; a bomb explodes. The budget is finite either way. */
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
/** Structural scan cap, so a pathological object count cannot pin a Worker. */
export const MAX_STREAMS_INSPECTED = 4096;

export type UploadFailureReason =
  | "object_missing"
  | "empty_object"
  | "size_exceeded"
  | "hash_mismatch"
  | "signature_mismatch"
  | "unsupported_type"
  | "malformed_pdf"
  | "encrypted_pdf"
  | "decompression_bomb";

/**
 * What the caller does with the refusal: `quarantined` is "the bytes are hostile or unusable",
 * `failed` is "this capture cannot be trusted", and `retryable` is "nothing happened yet, the object
 * has not landed" — which must not close the session.
 */
export type CaptureOutcome = "verified" | "quarantined" | "failed" | "retryable";

export interface SignatureGuess {
  mediaType: string | null;
  family: "pdf" | "portable_executable" | "zip" | "image" | "unknown";
}

/** Types an object by its bytes. A file name is never an input here (plan §7.2 step 2). */
export function sniffSignature(bytes: Uint8Array): SignatureGuess {
  if (bytes.length === 0) return { mediaType: null, family: "unknown" };
  if (looksLikePdf(bytes)) return { mediaType: "application/pdf", family: "pdf" };
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return { mediaType: null, family: "portable_executable" };
  if (
    (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) ||
    (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x00 && bytes[3] === 0x00)
  ) {
    // ZIP: DOCX and XLSX are ZIP containers, and a ZIP is the classic decompression-bomb carrier.
    // Both are T-212's parsers; this packet refuses them rather than half-supporting them.
    return { mediaType: "application/zip", family: "zip" };
  }
  if (bytes[0] === 0x89 && indexOfAscii(bytes, "PNG", 1) === 1) return { mediaType: "image/png", family: "image" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mediaType: "image/jpeg", family: "image" };
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return { mediaType: "image/tiff", family: "image" };
  }
  if (indexOfAscii(bytes, "ftyp", 4) === 4) return { mediaType: "image/heic", family: "image" };
  return { mediaType: null, family: "unknown" };
}

async function defaultSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

export interface VerifyObjectInput {
  /** What the object store reported for the session's own key. There is no path argument. */
  read: ObjectReadResult;
  /** The session's byte bound — the same number the write path re-checks in SQL. */
  maxBytes: number;
  /** The uploader's claim; verified, never trusted. */
  expectedSha256: string;
  limits?: { maxDecompressedBytes?: number };
  hash?: (bytes: Uint8Array) => Promise<string>;
}

export interface VerifyObjectResult {
  ok: boolean;
  outcome: CaptureOutcome;
  reason: UploadFailureReason | null;
  sizeBytes: number | null;
  mediaType: string | null;
  /** The digest the server computed; this is what gets stored, not the client's claim. */
  contentSha256: string | null;
  notes: string[];
}

function refusal(
  outcome: CaptureOutcome,
  reason: UploadFailureReason,
  extra: Partial<Pick<VerifyObjectResult, "sizeBytes" | "mediaType" | "notes">> = {},
): VerifyObjectResult {
  return {
    ok: false,
    outcome,
    reason,
    sizeBytes: extra.sizeBytes ?? null,
    mediaType: extra.mediaType ?? null,
    contentSha256: null,
    notes: extra.notes ?? [],
  };
}

export async function verifyCapturedObject(input: VerifyObjectInput): Promise<VerifyObjectResult> {
  if (input.read.status === "missing") return refusal("retryable", "object_missing");
  if (input.read.status === "oversize") {
    return refusal("failed", "size_exceeded", { sizeBytes: input.read.sizeBytes });
  }

  const bytes = input.read.bytes;
  if (bytes.length === 0) return refusal("failed", "empty_object");
  if (bytes.length > input.maxBytes) return refusal("failed", "size_exceeded", { sizeBytes: bytes.length });

  const guess = sniffSignature(bytes);
  if (guess.family === "portable_executable") {
    return refusal("quarantined", "signature_mismatch", { sizeBytes: bytes.length });
  }
  if (guess.family !== "pdf") {
    return refusal("quarantined", "unsupported_type", { sizeBytes: bytes.length, mediaType: guess.mediaType });
  }

  // The digest is computed over exactly the bytes that were read, and the stored value is this one.
  const sha256 = input.hash ?? defaultSha256;
  const contentSha256 = await sha256(bytes);
  if (contentSha256 !== input.expectedSha256.toLowerCase()) {
    return refusal("failed", "hash_mismatch", { sizeBytes: bytes.length, mediaType: guess.mediaType });
  }

  if (!hasPdfEof(bytes)) {
    return refusal("quarantined", "malformed_pdf", { sizeBytes: bytes.length, mediaType: guess.mediaType });
  }

  const features = detectPdfFeatures(bytes);
  const notes = featureNotes(features);
  if (features.has("encrypted")) {
    // A password-protected or crypt-filtered PDF cannot be read without a secret, and decrypting it
    // here would put a credential inside the capture path. Quarantine it instead (plan §7.2 step 2).
    return refusal("quarantined", "encrypted_pdf", { sizeBytes: bytes.length, mediaType: guess.mediaType, notes });
  }

  // Decompression budget across every FlateDecode stream in the file (plan §7.2 step 2). This is
  // also what makes the extraction stage cheap to bound later: the object is already known to fit.
  let budget = input.limits?.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const objects = scanObjects(bytes, MAX_STREAMS_INSPECTED);
  for (const span of objects) {
    const stream = readStream(bytes, span);
    if (!stream || stream.filter !== "FlateDecode") continue;
    const inflated = await inflateBounded(stream.data, budget);
    if (!inflated.ok) {
      const reason: UploadFailureReason = inflated.reason === "budget" ? "decompression_bomb" : "malformed_pdf";
      return refusal("quarantined", reason, { sizeBytes: bytes.length, mediaType: guess.mediaType, notes });
    }
    budget -= inflated.data.byteLength;
    if (budget <= 0) {
      return refusal("quarantined", "decompression_bomb", { sizeBytes: bytes.length, mediaType: guess.mediaType, notes });
    }
  }

  return {
    ok: true,
    outcome: "verified",
    reason: null,
    sizeBytes: bytes.length,
    mediaType: guess.mediaType,
    contentSha256,
    notes,
  };
}
