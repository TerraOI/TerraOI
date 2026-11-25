import type { IngestionStage } from "@/contracts/ingestion-job";

import { digestWorkerCredential } from "./job-db";
import {
  SIGNED_URL_TTL_SECONDS,
  type MintObjectUrlArgs,
  type MintObjectUrlResult,
} from "./mint-object-url";
import type { AbortReason, ArtifactInput, JobApiPort } from "./ocr-pull";

/**
 * Box-facing HTTP handlers for `src/app/api/jobs/*` (FAQ-0005, #152; T-211 PR-3a/3b).
 *
 * Speaks the same JSON shapes `localbox/ocr-pull.ts` `createHttpBoxJobApi` already posts and
 * parses. Identity is the `Authorization: Bearer <token>` header — hashed before SQL (#134) or
 * before the #170 service-binding hop for `object-url`. Responses never carry postgres detail,
 * hosts, pool names, or `object_ref`.
 */

/** RPC surface the app Worker binds as `OBJECT_URL_MINT` (#170). */
export type ObjectUrlMintBinding = {
  mintObjectUrl(args: MintObjectUrlArgs): Promise<MintObjectUrlResult>;
};

const SAFE_JSON = { "content-type": "application/json", "cache-control": "no-store" } as const;

const ABORT_REASONS: readonly AbortReason[] = [
  "abandoned_by_worker",
  "source_revoked",
  "unsupported_document",
  "object_missing",
  "quality_failed",
  "operator_cancel",
  "clearance_refused",
  "embedding_route_unavailable",
];

export function jobApiUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "job_api_unavailable" } }), {
    status: 503,
    headers: SAFE_JSON,
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
    status: 401,
    headers: SAFE_JSON,
  });
}

function badRequest(): Response {
  return new Response(JSON.stringify({ error: { code: "malformed" } }), {
    status: 400,
    headers: SAFE_JSON,
  });
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: SAFE_JSON });
}

function bearerCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (match === null) return null;
  const token = match[1];
  return token !== undefined && token.length > 0 ? token : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function stringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOf(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isUuid(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isStage(value: string | null): value is IngestionStage {
  return value === "validate" || value === "extract" || value === "index" || value === "publish";
}

function isAbortReason(value: string | null): value is AbortReason {
  return value !== null && (ABORT_REASONS as readonly string[]).includes(value);
}

function parseArtifacts(value: unknown): ArtifactInput[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ArtifactInput[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (row === null) return null;
    const artifactIndex = numberOf(row, "artifactIndex");
    const bodyText = stringOf(row, "bodyText");
    if (artifactIndex === null || !Number.isInteger(artifactIndex) || bodyText === null) return null;
    const artifact: ArtifactInput = { artifactIndex, bodyText };
    const locator = row.locator;
    if (locator !== undefined) {
      const loc = asRecord(locator);
      if (loc === null) return null;
      artifact.locator = loc;
    }
    if (row.confidence !== undefined) {
      const confidence = numberOf(row, "confidence");
      if (confidence === null) return null;
      artifact.confidence = confidence;
    }
    if (row.notes !== undefined) {
      if (!Array.isArray(row.notes) || !row.notes.every((n) => typeof n === "string")) return null;
      artifact.notes = row.notes as string[];
    }
    out.push(artifact);
  }
  return out;
}

export async function handleJobLease(request: Request, api: JobApiPort): Promise<Response> {
  const credential = bearerCredential(request);
  if (credential === null) return unauthorized();
  const body = await readJson(request);
  if (body === null) return badRequest();
  const stage = stringOf(body, "stage");
  const leaseSeconds = numberOf(body, "leaseSeconds");
  if (!isStage(stage) || leaseSeconds === null || !Number.isInteger(leaseSeconds)) return badRequest();

  const row = await api.lease({ credential, stage, leaseSeconds });
  if (row === null) return ok({ found: false });
  return ok({ found: true, ...row });
}

export async function handleJobRenew(request: Request, api: JobApiPort): Promise<Response> {
  const credential = bearerCredential(request);
  if (credential === null) return unauthorized();
  const body = await readJson(request);
  if (body === null) return badRequest();
  const jobId = stringOf(body, "jobId");
  const leaseToken = stringOf(body, "leaseToken");
  const fence = numberOf(body, "fence");
  const leaseSeconds = numberOf(body, "leaseSeconds");
  if (
    !isUuid(jobId) ||
    leaseToken === null ||
    fence === null ||
    !Number.isInteger(fence) ||
    leaseSeconds === null ||
    !Number.isInteger(leaseSeconds)
  ) {
    return badRequest();
  }
  const outcome = await api.renew({ credential, jobId, leaseToken, fence, leaseSeconds });
  return ok(outcome);
}

export async function handleJobComplete(request: Request, api: JobApiPort): Promise<Response> {
  const credential = bearerCredential(request);
  if (credential === null) return unauthorized();
  const body = await readJson(request);
  if (body === null) return badRequest();
  const jobId = stringOf(body, "jobId");
  const leaseToken = stringOf(body, "leaseToken");
  const fence = numberOf(body, "fence");
  const sourceVersionId = stringOf(body, "sourceVersionId");
  const stage = stringOf(body, "stage");
  const indexGeneration = numberOf(body, "indexGeneration");
  const artifacts = parseArtifacts(body.artifacts);
  if (
    !isUuid(jobId) ||
    leaseToken === null ||
    fence === null ||
    !Number.isInteger(fence) ||
    !isUuid(sourceVersionId) ||
    !isStage(stage) ||
    indexGeneration === null ||
    !Number.isInteger(indexGeneration) ||
    artifacts === null
  ) {
    return badRequest();
  }
  const notesRaw = body.notes;
  const notes =
    notesRaw === undefined
      ? []
      : Array.isArray(notesRaw) && notesRaw.every((n) => typeof n === "string")
        ? (notesRaw as string[])
        : null;
  if (notes === null) return badRequest();
  const confidence =
    body.confidence === null || body.confidence === undefined
      ? null
      : numberOf(body, "confidence");
  if (body.confidence !== null && body.confidence !== undefined && confidence === null) return badRequest();

  const outcome = await api.complete({
    credential,
    jobId,
    leaseToken,
    fence,
    sourceVersionId,
    stage,
    indexGeneration,
    artifacts,
    notes,
    confidence,
  });
  return ok(outcome);
}

export async function handleJobAbort(request: Request, api: JobApiPort): Promise<Response> {
  const credential = bearerCredential(request);
  if (credential === null) return unauthorized();
  const body = await readJson(request);
  if (body === null) return badRequest();
  const jobId = stringOf(body, "jobId");
  const leaseToken = stringOf(body, "leaseToken");
  const fence = numberOf(body, "fence");
  const reason = stringOf(body, "reason");
  if (!isUuid(jobId) || leaseToken === null || fence === null || !Number.isInteger(fence) || !isAbortReason(reason)) {
    return badRequest();
  }
  const outcome = await api.abort({ credential, jobId, leaseToken, fence, reason });
  return ok(outcome);
}

/**
 * Box-facing object URL (#170). Hashes the Bearer token, sends only the digest + lease
 * identity over the binding, and returns `{ found, url?, expiresInSeconds? }`. The URL is
 * never logged here — the handler test asserts it appears only in the response body.
 */
export async function handleJobObjectUrl(
  request: Request,
  mint: ObjectUrlMintBinding,
): Promise<Response> {
  const credential = bearerCredential(request);
  if (credential === null) return unauthorized();
  const body = await readJson(request);
  if (body === null) return badRequest();
  const jobId = stringOf(body, "jobId");
  const leaseToken = stringOf(body, "leaseToken");
  const fence = numberOf(body, "fence");
  if (!isUuid(jobId) || leaseToken === null || fence === null || !Number.isInteger(fence)) {
    return badRequest();
  }

  const tokenHash = digestWorkerCredential(credential);
  const result = await mint.mintObjectUrl({ tokenHash, jobId, leaseToken, fence });
  if (!result.ok) return ok({ found: false });
  return ok({
    found: true,
    url: result.url,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  });
}
