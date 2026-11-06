import { z } from "zod";

import { SAFE_FAILURE_MESSAGE, type TenantFailureReason } from "@/platform/tenancy/resolve-tenant-context";
import type { TenantResolution } from "@/platform/tenancy/resolve-tenant-context";

import type { ObjectStoreOrUnavailable } from "./object-store";
import {
  MAX_DECOMPRESSED_BYTES,
  MAX_UPLOAD_BYTES,
  verifyCapturedObject,
  type UploadFailureReason,
  type VerifyObjectResult,
} from "./object-validator";

/**
 * Upload session and completion (plan §7.2 steps 1–2, §9.2.1; F09, F10; #13(1)/(2), FAQ-0004).
 *
 * Two calls, one employee session, one tenant host:
 *
 *   POST /api/knowledge/uploads                      → a session, and the object key **we** issue
 *   POST /api/knowledge/uploads/:uploadId/complete    → verify the bytes, then capture them
 *
 * The tenant and the uploader come from the verified request context (`resolveContext` runs the
 * host resolver and the membership check, and the scoped RPC takes `auth.uid()` from the database
 * session). Nothing in either body names a tenant, an uploader, a collection owner or an object key,
 * and the schemas are strict so a body that *tries* is a validation error rather than a field that
 * gets ignored somewhere downstream. The rules that must hold even if this module is bypassed live
 * in `supabase/migrations/20261106100000_knowledge_uploads.sql`; this file is the boundary, the
 * store port is the narrow write path (#37 decides how that port reaches Postgres, #38 how objects
 * reach storage).
 */

export const MAX_REQUEST_BODY_BYTES = 8192;

export interface UploadLimits {
  /** Ceiling for one object; the session carries it and the SQL write path re-checks it. */
  maxBytes: number;
  /** Decompression budget used while verifying the signature and structure. */
  maxDecompressedBytes: number;
  /** How long an issued key stays usable for a completion. */
  sessionTtlSeconds: number;
  /** Per-user open-session quota (plan §9.2.1: "storage quota"). */
  maxOpenSessionsPerUser: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: MAX_UPLOAD_BYTES,
  maxDecompressedBytes: MAX_DECOMPRESSED_BYTES,
  sessionTtlSeconds: 30 * 60,
  maxOpenSessionsPerUser: 10,
};

export type UploadSessionState = "awaiting_upload" | "completed" | "quarantined" | "failed" | "expired";

export interface UploadSession {
  id: string;
  organisationId: string;
  collectionId: string;
  /** The uploader, recorded by the write path from `auth.uid()` (never from a body). */
  createdBy: string;
  idempotencyKey: string;
  /** Server-issued private key; the client never names it and never chooses a path. */
  objectRef: string;
  maxBytes: number;
  state: UploadSessionState;
  reasonCode: string | null;
  expiresAt: string;
  createdAt: string;
  sourceId: string | null;
  sourceVersionId: string | null;
}

export type BeginSessionResult =
  | { status: "ok"; session: UploadSession }
  | { status: "collection_not_found" }
  | { status: "not_publishable" }
  | { status: "quota_exceeded" }
  | { status: "no_tenant_scope" };

export type RegisterRefusalReason =
  | "session_not_found"
  | "session_expired"
  | "session_closed"
  | "not_publishable"
  | "duplicate_unreadable"
  | "invalid_hash"
  | "size_exceeded"
  | "index_generation_missing";

export type RegisterResult =
  | {
      status: "ok";
      sourceId: string;
      sourceVersionId: string;
      state: "received";
      /** True only when the pre-existing copy is readable by this uploader (#13(2)). */
      alreadyUploaded: boolean;
    }
  | { status: "refused"; reason: RegisterRefusalReason };

/**
 * The narrow write path. `beginSession` issues the key; `registerVersion` writes the source, the
 * version, the outbox event and the stage row in one transaction and derives the index generation
 * from the tenant's active `corpus` index (never a client value, never a constant — an unpin
 * tenant is refused rather than given an invented generation, keeping open issue #6 out of scope).
 */
export interface UploadStore {
  beginSession(cmd: {
    organisationId: string;
    userId: string;
    collectionId: string;
    idempotencyKey: string;
    filename: string;
    maxBytes: number;
    sessionTtlSeconds: number;
    maxOpenSessionsPerUser: number;
  }): Promise<BeginSessionResult>;
  findSession(cmd: { uploadId: string; organisationId: string; userId: string }): Promise<UploadSession | null>;
  registerVersion(cmd: {
    uploadId: string;
    organisationId: string;
    userId: string;
    contentHash: string;
    sizeBytes: number;
    mediaType: string;
  }): Promise<RegisterResult>;
  recordOutcome(cmd: {
    uploadId: string;
    organisationId: string;
    userId: string;
    state: "quarantined" | "failed";
    reason: UploadFailureReason;
  }): Promise<void>;
}

export interface UploadDeps {
  /** Host + verified session → TenantContext, or a safe failure reason (plan §4.1, §4.2). */
  resolveContext(request: Request): Promise<TenantResolution>;
  store: UploadStore;
  /** null until #38 decides the storage path; the route then fails closed with 503. */
  objects: ObjectStoreOrUnavailable;
  limits?: Partial<UploadLimits>;
  hash?: (bytes: Uint8Array) => Promise<string>;
}

const CreateUploadBody = z.strictObject({
  collectionId: z.uuid(),
  /**
   * Advisory label for the UI, and nothing else. It never reaches the object key, the type
   * decision or the dedup identity, and the RPC re-checks publish permission anyway.
   */
  filename: z.string().regex(/^[^\x00-\x1f/\\]{1,200}$/, "filename must be a bare name"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "idempotencyKey must be 8-64 url-safe characters"),
});

const CompleteUploadBody = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters"),
});

/** Stable, safe reason codes. Never a file name, never document content, never a Postgres message. */
export const SAFE_UPLOAD_MESSAGES: Record<string, string> = {
  invalid_request: "The request was not valid.",
  unsupported_media_type: "Send a JSON body.",
  payload_too_large: "The request was too large.",
  origin_mismatch: "This request did not come from this workspace.",
  unauthorized: SAFE_FAILURE_MESSAGE.no_session,
  forbidden: SAFE_FAILURE_MESSAGE.not_a_member,
  not_found: "The upload or its destination was not found.",
  session_not_found: "The upload or its destination was not found.",
  session_expired: "This upload has expired. Start it again.",
  session_closed: "This upload is already closed. Start it again.",
  not_publishable: "You may not publish into that collection.",
  quota_exceeded: "Too many uploads are open right now. Finish or wait for one.",
  object_missing: "The uploaded object has not arrived yet. Try again.",
  storage_unavailable: "Uploads are unavailable right now. Please try again.",
  index_generation_missing: "This workspace has no active search index yet, so the document cannot be captured.",
  invalid_hash: "The checksum did not match an acceptable form.",
  size_exceeded: "The file is larger than this upload allows.",
  empty_object: "The uploaded file was empty.",
  hash_mismatch: "The file did not match the checksum supplied for it.",
  signature_mismatch: "The file type does not match its contents.",
  unsupported_type: "That file type cannot be added yet.",
  malformed_pdf: "The PDF could not be read.",
  encrypted_pdf: "Password-protected PDFs cannot be added.",
  decompression_bomb: "The file was refused because of its compression structure.",
  internal_error: "The upload could not be completed. Please try again.",
};

const CONTEXT_STATUS: Record<TenantFailureReason, number> = {
  missing_host: 404,
  malformed_host: 404,
  too_many_labels: 404,
  preview_alias: 404,
  ip_literal: 404,
  unknown_host: 404,
  reserved_host: 404,
  tenant_not_live: 403,
  no_session: 401,
  not_a_member: 403,
  membership_not_active: 403,
  backend_failure: 503,
};

const VERIFICATION_STATUS: Partial<Record<UploadFailureReason, number>> = {
  object_missing: 409,
  size_exceeded: 413,
  empty_object: 422,
  hash_mismatch: 422,
  signature_mismatch: 422,
  unsupported_type: 415,
  malformed_pdf: 422,
  encrypted_pdf: 422,
  decompression_bomb: 422,
};

const REGISTER_STATUS: Record<RegisterRefusalReason, number> = {
  session_not_found: 404,
  session_expired: 410,
  session_closed: 409,
  not_publishable: 403,
  duplicate_unreadable: 403,
  invalid_hash: 400,
  size_exceeded: 413,
  index_generation_missing: 409,
};

function reply(status: number, code: string, extra?: Record<string, unknown>): Response {
  const body = extra === undefined
    ? { error: { code, message: SAFE_UPLOAD_MESSAGES[code] ?? SAFE_UPLOAD_MESSAGES.internal_error } }
    : extra;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function contextFailure(reason: TenantFailureReason): Response {
  const code =
    reason === "no_session"
      ? "unauthorized"
      : reason === "backend_failure"
        ? "internal_error"
        : reason === "not_a_member" || reason === "membership_not_active" || reason === "tenant_not_live"
          ? "forbidden"
          : "not_found";
  return reply(CONTEXT_STATUS[reason], code);
}

/** Exact-origin check: state-changing requests must come from this tenant origin (§9.2, T-102 CSRF). */
function originMismatch(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!isJson(request.headers.get("content-type"))) return { ok: false, response: reply(415, "unsupported_media_type") };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) return { ok: false, response: reply(413, "payload_too_large") };
  const text = await request.text();
  if (text.length > MAX_REQUEST_BODY_BYTES) return { ok: false, response: reply(413, "payload_too_large") };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: reply(400, "invalid_request") };
  }
}

function limitsOf(deps: UploadDeps): UploadLimits {
  return { ...DEFAULT_UPLOAD_LIMITS, ...deps.limits };
}

/**
 * Operators need to tell a missing binding from a refused write, but Postgres and library messages
 * can carry an object key, a file name or document text — so only a fixed step marker is logged,
 * the same discipline as the pilot-inquiry handler.
 */
function logFailure(step: string, error: unknown): void {
  const e = error as { name?: unknown } | null;
  console.error("knowledge-upload failed", {
    step,
    name: typeof e?.name === "string" ? e.name : "unknown",
  });
}

export async function handleCreateUpload(request: Request, deps: UploadDeps): Promise<Response> {
  const resolution = await deps.resolveContext(request);
  if (!resolution.ok) return contextFailure(resolution.reason);
  if (originMismatch(request)) return reply(403, "origin_mismatch");

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = CreateUploadBody.safeParse(body.value);
  if (!parsed.success) return reply(400, "invalid_request");
  const { organisationId, userId } = resolution.context;
  const limits = limitsOf(deps);

  let started: BeginSessionResult;
  try {
    started = await deps.store.beginSession({
      organisationId,
      userId,
      collectionId: parsed.data.collectionId,
      idempotencyKey: parsed.data.idempotencyKey,
      filename: parsed.data.filename,
      maxBytes: limits.maxBytes,
      sessionTtlSeconds: limits.sessionTtlSeconds,
      maxOpenSessionsPerUser: limits.maxOpenSessionsPerUser,
    });
  } catch (error) {
    logFailure("beginSession", error);
    return reply(503, "storage_unavailable");
  }

  switch (started.status) {
    case "ok":
      return reply(201, "created", {
        uploadId: started.session.id,
        // The client is told where it may put the object; it is never asked where to put it.
        objectRef: started.session.objectRef,
        maxBytes: started.session.maxBytes,
        expiresAt: started.session.expiresAt,
        state: started.session.state,
      });
    case "collection_not_found":
      // Another tenant's collection id and an unknown one are the same answer: no existence signal.
      return reply(404, "not_found");
    case "not_publishable":
      return reply(403, "not_publishable");
    case "quota_exceeded":
      return reply(429, "quota_exceeded");
    case "no_tenant_scope":
      return reply(403, "forbidden");
  }
}

/**
 * The session id comes from the **routed URL**, which is the resource the client addressed: it is
 * never read from the body, and a body that carries an `uploadId` is a strict-schema rejection.
 */
function uploadIdFromUrl(request: Request): string | null {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const at = segments.indexOf("uploads");
  if (at < 0 || segments[at + 2] !== "complete") return null;
  return segments[at + 1] ?? null;
}

export async function handleCompleteUpload(request: Request, deps: UploadDeps): Promise<Response> {
  const resolution = await deps.resolveContext(request);
  if (!resolution.ok) return contextFailure(resolution.reason);
  if (originMismatch(request)) return reply(403, "origin_mismatch");
  const uploadId = uploadIdFromUrl(request);
  if (uploadId === null || !z.uuid().safeParse(uploadId).success) return reply(404, "session_not_found");

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = CompleteUploadBody.safeParse(body.value);
  if (!parsed.success) return reply(400, "invalid_request");

  const { organisationId, userId } = resolution.context;
  const limits = limitsOf(deps);

  let session: UploadSession | null;
  try {
    // Scoped by the caller's tenant *and* uploader: a session created on another host is simply
    // not found here, and a colleague's session is not yours to complete.
    session = await deps.store.findSession({ uploadId, organisationId, userId });
  } catch (error) {
    logFailure("findSession", error);
    return reply(503, "storage_unavailable");
  }
  if (session === null) return reply(404, "session_not_found");

  if (session.state === "completed" && session.sourceVersionId !== null) {
    // Replay: the same answer as the first time, with no write of any kind.
    return reply(200, "received", {
      sourceId: session.sourceId,
      sourceVersionId: session.sourceVersionId,
      state: "received",
      alreadyUploaded: true,
    });
  }
  if (session.state === "expired" || Date.parse(session.expiresAt) <= Date.now()) {
    return reply(410, "session_expired");
  }
  if (session.state === "quarantined" || session.state === "failed") return reply(409, "session_closed");
  if (deps.objects === null) return reply(503, "storage_unavailable");

  const bound = Math.min(session.maxBytes, limits.maxBytes);
  let verified: VerifyObjectResult;
  try {
    const read = await deps.objects.readBounded(session.objectRef, bound);
    verified = await verifyCapturedObject({
      read,
      maxBytes: bound,
      expectedSha256: parsed.data.sha256,
      limits: { maxDecompressedBytes: limits.maxDecompressedBytes },
      ...(deps.hash === undefined ? {} : { hash: deps.hash }),
    });
  } catch (error) {
    logFailure("verifyObject", error);
    return reply(503, "storage_unavailable");
  }

  if (!verified.ok) {
    const reason = verified.reason as UploadFailureReason;
    if (reason !== "object_missing") {
      try {
        await deps.store.recordOutcome({
          uploadId,
          organisationId,
          userId,
          state: verified.outcome === "quarantined" ? "quarantined" : "failed",
          reason,
        });
      } catch (error) {
        logFailure("recordOutcome", error);
        return reply(503, "storage_unavailable");
      }
    }
    return reply(VERIFICATION_STATUS[reason] ?? 422, reason);
  }

  let registered: RegisterResult;
  try {
    registered = await deps.store.registerVersion({
      uploadId,
      organisationId,
      userId,
      // The digest the server computed over the bytes it read, never the uploader's claim.
      contentHash: verified.contentSha256 as string,
      sizeBytes: verified.sizeBytes as number,
      mediaType: verified.mediaType ?? "application/pdf",
    });
  } catch (error) {
    logFailure("registerVersion", error);
    return reply(503, "storage_unavailable");
  }

  if (registered.status === "refused") {
    // `duplicate_unreadable` deliberately answers `not_publishable`: a copy someone may not read is
    // never signalled as existing (#13(2)).
    const code = registered.reason === "duplicate_unreadable" ? "not_publishable" : registered.reason;
    return reply(REGISTER_STATUS[registered.reason], code);
  }
  return reply(200, "received", {
    sourceId: registered.sourceId,
    sourceVersionId: registered.sourceVersionId,
    state: registered.state,
    alreadyUploaded: registered.alreadyUploaded,
  });
}
