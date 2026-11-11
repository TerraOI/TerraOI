import { IngestionJobPayload } from "@/contracts/ingestion-job";
import type { IngestionStage, JobExecutor } from "@/contracts/ingestion-job";
import type { DataClass } from "@/contracts/data-class";
import type { FetchImpl } from "@/platform/gateway/adapters";

/**
 * The tenant box's OCR worker (plan §13 "OCR/parsing worker", F32; #134, #135, ADR-0011 Decision 5).
 *
 * Read the file as a threat model, not just a loop. This code runs **inside a customer's network**,
 * on a machine that has no database credential, no storage credential and no employee session. What
 * it holds is one worker credential — a value whose SHA-256 digest is what `job_api` matches on
 * (`scripts/worker-credential.mjs`, `job_api.worker_credentials`) — and everything else it receives
 * is a short-lived answer to a question it asked **outbound**:
 *
 * * **No inbound anything.** No listener, no socket to accept on, no tunnel-side handler. The only
 *   connections this file can open are `fetch` calls to the job API and to the object URL it was
 *   handed (F32: "That worker holds no inbound port for jobs").
 * * **No key, no minting.** The cloud worker gets a key from SQL and signs it
 *   (`workers/object-signing.ts`); the box is handed the **URL** and GETs it. It has no way to name
 *   an object, and it never learns one: the job message it works from is the contract shape, which is
 *   key-free by construction (`src/contracts/ingestion-job.ts:13-17`, `.strict()`).
 * * **No clearance of its own.** The box leases `local_box` `extract` jobs and nothing else; a row
 *   whose executor is not `local_box` is rejected here as a second line of defence, because the
 *   merged lease guard already refuses it by the credential's executor arm (#135).
 * * **One-way door, and not this box's.** Re-routing a job between executors is the cloud worker's
 *   call on its own live lease (#134); this file contains no such operation, so a box cannot put a
 *   client_confidential scan back on the cloud path.
 * * **A processor, not a store.** Bytes live in memory for the duration of one extraction and are
 *   never written to disk (plan §13: "local artifacts are deleted after upload"; here there is no
 *   local artifact to delete).
 * * **Nothing readable in a log.** The event union has no free-text field: no URL, no credential, no
 *   object path, no document words (AGENTS §4.6, §4.8). An upstream error body stops at
 *   `JobApiTransportError`, which carries a kind and nothing else — the same discipline the gateway
 *   adapters apply to a provider error.
 *
 * The HTTP surface below (`/api/jobs/*`) is the shape this client speaks, because the supervisor ruled
 * on [#152](https://github.com/TerraOI/TerraOI/issues/152) that the app Worker's `src/app/api/jobs/`
 * routes (FAQ-0005) stay the box-facing surface. Writing those handlers — and the Cloudflare service
 * binding by which they reach the mint, which lives on the separate `workers/` deployment and nowhere
 * else — is PR-3 of this packet. The box never learns that distinction: it posts to a base URL and gets
 * back a narrow answer, deliberately validated: an unusable shape is a wait, never a crash.
 */

/** The merged lease floor and ceiling (`job_api.max_lease_seconds()`); OCR is slower than a parse. */
export const DEFAULT_LEASE_SECONDS = 900;

/** A box polls; it is never woken. Slow enough that an offline platform is not a denial of service. */
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** The same ceiling capture enforced (plan §7.5's 20 MB document); the box must not be the exception. */
export const MAX_OBJECT_BYTES = 20 * 1024 * 1024;

/** A download that hangs must not hold the box's one job open indefinitely. */
export const OBJECT_DOWNLOAD_TIMEOUT_MS = 120_000;

/** How long a handed-over URL may claim to live: ADR-0011's bound, checked on the receiving side. */
export const MAX_OBJECT_URL_SECONDS = 300;

/**
 * Mirrors `job_api.abort_reasons()` (`20261109230000_ocr_job_leases.sql:109-114`). The SQL array is
 * the authority; this union is a compile-time echo so a call site cannot invent a reason — and the
 * box names fewer of them than exist, because it owns no other decision.
 */
export type AbortReason =
  | "abandoned_by_worker"
  | "source_revoked"
  | "unsupported_document"
  | "object_missing"
  | "quality_failed"
  | "operator_cancel"
  | "clearance_refused";

export interface ArtifactInput {
  artifactIndex: number;
  bodyText: string;
  locator?: Record<string, unknown> | undefined;
  confidence?: number | undefined;
  notes?: readonly string[] | undefined;
}

export interface LeaseRow {
  jobId: string;
  organisationId: string;
  sourceVersionId: string;
  stage: IngestionStage;
  executor: JobExecutor;
  parserGeneration: string;
  indexGeneration: number;
  dataClass: DataClass;
  leaseToken: string;
  fence: number;
  attempt: number;
}

export interface LeaseHolder {
  jobId: string;
  leaseToken: string;
  fence: number;
}

export type RenewOutcome = { outcome: "renewed"; expiresAt: string; fence: number } | { outcome: "refused" };

/** What the box is handed: a URL and how long it claims to live. Never a key, never a bucket. */
export type ObjectUrlOutcome =
  | { found: true; url: string; expiresInSeconds: number | undefined }
  | { found: false };

export type CompleteOutcome =
  | { outcome: "completed"; artifactCount: number }
  | { outcome: "already_completed"; artifactCount: number }
  | { outcome: "refused" };

export type AbortOutcome = { outcome: "aborted" } | { outcome: "refused" };

/** The closed failure kinds of the transport. An upstream body is never part of one. */
export type TransportFailure =
  | "unauthorized"
  | "unavailable"
  | "malformed"
  | "network"
  | "url_refused"
  /** This box is not installed correctly: no base URL, or no credential to present. */
  | "not_configured";

export class JobApiTransportError extends Error {
  readonly kind: TransportFailure;
  constructor(kind: TransportFailure) {
    // A fixed, safe message: the job API's own error body can name a host, a pool or a job it is not
    // this box's business to hear, and none of it may travel into a box log.
    super(`job api transport: ${kind}`);
    this.name = "JobApiTransportError";
    this.kind = kind;
  }
}

/**
 * The job API as the box sees it: five outbound calls, no more. The credential is an argument
 * because it is the box's only identity, and the API side hashes it before anything is compared
 * (#134) — this file never computes or stores a digest.
 */
export interface BoxJobApiPort {
  lease(args: { credential: string; stage: IngestionStage; leaseSeconds: number }): Promise<LeaseRow | null>;
  renew(args: LeaseHolder & { credential: string; leaseSeconds: number }): Promise<RenewOutcome>;
  objectUrl(args: LeaseHolder & { credential: string }): Promise<ObjectUrlOutcome>;
  complete(args: LeaseHolder & {
    credential: string;
    sourceVersionId: string;
    stage: IngestionStage;
    indexGeneration: number;
    artifacts: readonly ArtifactInput[];
    notes: readonly string[];
    confidence: number | null;
  }): Promise<CompleteOutcome>;
  abort(args: LeaseHolder & { credential: string; reason: AbortReason }): Promise<AbortOutcome>;
}

export interface ExtractorInput {
  /** The contract message the client rebuilt from the server-issued row; the only scope an extractor gets. */
  payload: IngestionJobPayload;
  /** The short-lived URL the deployment handed over for the lease this box holds. */
  url: string;
  bytes: Uint8Array;
}

export type ExtractorResult =
  | { outcome: "extracted"; artifacts: readonly ArtifactInput[]; notes?: readonly string[] | undefined; confidence?: number | undefined }
  /**
   * The only failure the box may report: this document cannot be processed here, with a named code.
   * There is no arm that moves a job somewhere else, because that decision is not the box's (#134).
   */
  | { outcome: "unsupported"; reason: AbortReason; notes?: readonly string[] | undefined };

export interface BoxExtractorPort {
  extract(input: ExtractorInput): Promise<ExtractorResult>;
}

export type BoxObjectBytes =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "oversize"; sizeBytes: number | null }
  | { status: "missing" }
  | { status: "unavailable"; reason: "url_refused" | "network" | "http_error" };

export type BoxByteReader = (url: string, maxBytes: number) => Promise<BoxObjectBytes>;

/** The box's own configuration: a base URL and a credential. No key for storage, and no database. */
export interface BoxWorkerEnv {
  TOI_JOB_API_BASE_URL?: string | undefined;
  TOI_WORKER_TOKEN?: string | undefined;
}

export interface BoxWorkerDeps {
  jobApi: BoxJobApiPort;
  credential: () => string | undefined;
  extractor: BoxExtractorPort;
  readObjectBytes: BoxByteReader;
  leaseSeconds: number;
  maxObjectBytes: number;
  log: (event: BoxEvent) => void;
  now: () => number;
}

/** Closed, structured events. No URL, no credential, no object path, no document words. */
export type BoxEvent =
  | { kind: "credential_unavailable" }
  /** This box has no tunnel base or no credential: an install problem, not a queue condition. */
  | { kind: "configuration_missing" }
  | { kind: "no_work" }
  | { kind: "leased"; jobId: string; attempt: number; dataClass: DataClass }
  | { kind: "lease_row_rejected"; jobId: string }
  | { kind: "lease_lost"; jobId: string }
  | { kind: "object_url_refused"; jobId: string }
  | { kind: "object_unavailable"; jobId: string; reason: "url_refused" | "network" | "http_error" }
  | { kind: "bytes_oversize"; jobId: string; sizeBytes: number | null }
  | { kind: "bytes_missing"; jobId: string }
  | { kind: "artifact_set_rejected"; jobId: string; rule: ArtifactRejectionRule }
  | { kind: "mutation_refused"; jobId: string; call: "complete" | "abort" }
  | { kind: "job_api_unavailable" }
  | { kind: "job_api_malformed" }
  | { kind: "credential_refused" }
  | { kind: "completed"; jobId: string; artifacts: number }
  | { kind: "already_completed"; jobId: string; artifacts: number }
  | { kind: "aborted"; jobId: string; reason: AbortReason };

export type IterationOutcome =
  | { action: "credential_missing" }
  /** No base URL installed, or no credential: a human must fix the box, not the queue. */
  | { action: "configuration_missing" }
  | { action: "no_work" }
  | { action: "lease_row_rejected" }
  | { action: "lease_lost" }
  | { action: "object_unavailable"; reason: "url_refused" | "network" | "http_error" }
  | { action: "completed"; artifactCount: number }
  | { action: "already_completed"; artifactCount: number }
  | { action: "aborted"; reason: AbortReason }
  | { action: "refused" }
  /** The platform refused this box's credential: a human must rotate or re-scope it. */
  | { action: "credential_refused" }
  | { action: "job_api_unavailable" }
  | { action: "job_api_malformed" };

// ── the outbound client ─────────────────────────────────────────────────────────────────────────

const STAGES: readonly IngestionStage[] = ["validate", "extract", "index", "publish"];
const EXECUTORS: readonly JobExecutor[] = ["cloud_worker", "local_box"];
const DATA_CLASSES: readonly DataClass[] = ["public", "internal", "client_confidential", "restricted"];
const RENEW_OUTCOMES = ["renewed", "refused"];
const COMPLETE_OUTCOMES = ["completed", "already_completed", "refused"];
const ABORT_OUTCOMES = ["aborted", "refused"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The URL hand-off, checked on the receiving side. ADR-0011 put the mint on the extraction
 * deployment; the box cannot audit that deployment's secret, but it can refuse a hand-off that does
 * not look like one: a URL that is not a plain GET target, one that carries credentials of its own,
 * one that claims a lifetime longer than the lease that produced it, or one that points back at the
 * job API — the byte-proxying shape ADR-0011 explicitly rejected.
 */
export function objectUrlIsUsable(raw: string, jobApiOrigin: string, expiresInSeconds: number | undefined): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (expiresInSeconds !== undefined && !(expiresInSeconds > 0 && expiresInSeconds <= MAX_OBJECT_URL_SECONDS)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (url.hash.length > 0) return false;
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopback) return false;
  if (url.origin === jobApiOrigin) return false;
  return true;
}

/**
 * A bounded GET of the handed-over URL. The URL **is** the credential on this leg: nothing else is
 * sent, no redirect is followed, and a body that outgrows the bound is cancelled mid-stream rather
 * than buffered.
 */
export function createBoxByteReader(options: { fetchImpl?: FetchImpl; timeoutMs?: number }): BoxByteReader {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? OBJECT_DOWNLOAD_TIMEOUT_MS;

  return async (url: string, maxBytes: number): Promise<BoxObjectBytes> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/octet-stream" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { status: "unavailable", reason: "network" };
    }
    if (response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      return { status: "missing" };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { status: "unavailable", reason: "http_error" };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      return { status: "oversize", sizeBytes: declared };
    }
    const body = response.body;
    if (body === null) return { status: "ok", bytes: new Uint8Array(0) };

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { status: "oversize", sizeBytes: null };
      }
      chunks.push(next.value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: "ok", bytes: merged };
  };
}

/**
 * The five job-API calls over plain `fetch`. camelCase on the wire like every other contract in this
 * repository; the deployment maps the artifact fields into the jsonb key names SQL reads
 * (`body_text`, `artifact_index`, …), so a SQL detail never lands inside a tenant's machine.
 */
export function createHttpBoxJobApi(options: {
  baseUrl: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): BoxJobApiPort {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = options.baseUrl.replace(/\/+$/, "");
  let jobApiOrigin = "";
  try {
    jobApiOrigin = new URL(base).origin;
  } catch {
    jobApiOrigin = "";
  }

  async function post(path: string, credential: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (base.length === 0 || credential.length === 0) {
      // **No default host, on purpose.** The tunnel base is a per-install setting (plan §13), and no
      // merged decision owns a platform API hostname: the host resolver classifies *every* other name
      // under the platform domain as a tenant (`src/platform/tenancy/host.ts:51-55`), so an
      // `api`-prefixed fallback would be routed as a workspace called "api" and answer "not available
      // at this address". A default here would invent infrastructure and then hide it, which is how a
      // box becomes "broken" three months out. An uninstalled box says so instead — before any socket,
      // and before any credential moves.
      throw new JobApiTransportError("not_configured");
    }
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          // Outbound only, to the deployment that issued the lease. This header is the box's whole
          // identity; the value is read per call, never stored, never logged.
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new JobApiTransportError("network");
    }
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      throw new JobApiTransportError("unauthorized");
    }
    if (response.status === 429 || response.status >= 500) {
      void response.body?.cancel().catch(() => undefined);
      throw new JobApiTransportError("unavailable");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new JobApiTransportError("malformed");
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new JobApiTransportError("malformed");
    }
    const record = asRecord(parsed);
    if (record === undefined) throw new JobApiTransportError("malformed");
    return record;
  }

  return {
    async lease({ credential, stage, leaseSeconds }) {
      const answer = await post("/api/jobs/lease", credential, { stage, leaseSeconds });
      if (answer["found"] === false) return null;
      if (answer["found"] !== true) throw new JobApiTransportError("malformed");

      const jobId = stringOf(answer, "jobId");
      const organisationId = stringOf(answer, "organisationId");
      const sourceVersionId = stringOf(answer, "sourceVersionId");
      const leaseToken = stringOf(answer, "leaseToken");
      const parserGeneration = stringOf(answer, "parserGeneration");
      const stageValue = stringOf(answer, "stage");
      const executor = stringOf(answer, "executor");
      const dataClass = stringOf(answer, "dataClass");
      const fence = numberOf(answer, "fence");
      const indexGeneration = numberOf(answer, "indexGeneration");
      const attempt = numberOf(answer, "attempt");
      if (
        !isUuid(jobId) ||
        !isUuid(organisationId) ||
        !isUuid(sourceVersionId) ||
        leaseToken === undefined ||
        parserGeneration === undefined ||
        stageValue === undefined ||
        !STAGES.includes(stageValue as IngestionStage) ||
        executor === undefined ||
        !EXECUTORS.includes(executor as JobExecutor) ||
        dataClass === undefined ||
        !DATA_CLASSES.includes(dataClass as DataClass) ||
        fence === undefined ||
        !Number.isInteger(fence) ||
        indexGeneration === undefined ||
        !Number.isInteger(indexGeneration) ||
        attempt === undefined ||
        !Number.isInteger(attempt)
      ) {
        // An unusable answer is a wait, not a crash and not a guess: nothing about this shape may be
        // carried forward, so no id from it reaches an event either.
        throw new JobApiTransportError("malformed");
      }
      return {
        jobId,
        organisationId,
        sourceVersionId,
        stage: stageValue as IngestionStage,
        executor: executor as JobExecutor,
        parserGeneration,
        indexGeneration,
        dataClass: dataClass as DataClass,
        leaseToken,
        fence,
        attempt,
      };
    },

    async renew({ credential, jobId, leaseToken, fence, leaseSeconds }) {
      const answer = await post("/api/jobs/renew", credential, { jobId, leaseToken, fence, leaseSeconds });
      const outcome = stringOf(answer, "outcome");
      if (outcome === undefined || !RENEW_OUTCOMES.includes(outcome)) throw new JobApiTransportError("malformed");
      if (outcome === "refused") return { outcome: "refused" };
      const expiresAt = stringOf(answer, "expiresAt");
      const newFence = numberOf(answer, "fence");
      if (expiresAt === undefined || newFence === undefined) throw new JobApiTransportError("malformed");
      return { outcome: "renewed", expiresAt, fence: newFence };
    },

    async objectUrl({ credential, jobId, leaseToken, fence }) {
      const answer = await post("/api/jobs/object-url", credential, { jobId, leaseToken, fence });
      if (answer["found"] === false) return { found: false };
      if (answer["found"] !== true) throw new JobApiTransportError("malformed");
      const url = stringOf(answer, "url");
      if (url === undefined) throw new JobApiTransportError("malformed");
      const expiresInSeconds = numberOf(answer, "expiresInSeconds");
      if (!objectUrlIsUsable(url, jobApiOrigin, expiresInSeconds)) {
        // Refused locally, and the kind is all anyone may say about it: the detail *is* the URL.
        throw new JobApiTransportError("url_refused");
      }
      return { found: true, url, expiresInSeconds };
    },

    async complete({ credential, jobId, leaseToken, fence, sourceVersionId, stage, indexGeneration, artifacts, notes, confidence }) {
      const answer = await post("/api/jobs/complete", credential, {
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
      const outcome = stringOf(answer, "outcome");
      if (outcome === undefined || !COMPLETE_OUTCOMES.includes(outcome)) throw new JobApiTransportError("malformed");
      if (outcome === "refused") return { outcome: "refused" };
      const artifactCount = numberOf(answer, "artifactCount");
      if (artifactCount === undefined) throw new JobApiTransportError("malformed");
      if (outcome === "completed") return { outcome: "completed", artifactCount };
      return { outcome: "already_completed", artifactCount };
    },

    async abort({ credential, jobId, leaseToken, fence, reason }) {
      const answer = await post("/api/jobs/abort", credential, { jobId, leaseToken, fence, reason });
      const outcome = stringOf(answer, "outcome");
      if (outcome === undefined || !ABORT_OUTCOMES.includes(outcome)) throw new JobApiTransportError("malformed");
      if (outcome === "aborted") return { outcome: "aborted" };
      return { outcome: "refused" };
    },
  };
}

// ── the artifact set: refuse locally what the artifact home would refuse in SQL ──────────────────

const MAX_ARTIFACT_ROWS = 2000;
const MAX_ARTIFACT_TOTAL_CHARS = 2_000_000;
const MAX_ARTIFACT_ROW_CHARS = 100_000;
const MAX_ARTIFACT_NOTES = 50;
const MAX_ARTIFACT_NOTE_CHARS = 500;

export type ArtifactRejectionRule =
  | "empty_set"
  | "too_many_rows"
  | "index_bounds"
  | "duplicate_index"
  | "row_text_bounds"
  | "total_text_bounds"
  | "locator_shape"
  | "confidence_bounds"
  | "notes_shape";

function locatorIsWellFormed(locator: unknown): boolean {
  if (locator === undefined) return true;
  if (typeof locator !== "object" || locator === null || Array.isArray(locator)) return false;
  const record = locator as Record<string, unknown>;
  if (record["notes"] !== undefined) return false;
  if (record["page"] !== undefined && typeof record["page"] !== "number") return false;
  if (record["section"] !== undefined && typeof record["section"] !== "string") return false;
  if (record["table"] !== undefined && typeof record["table"] !== "string") return false;
  return true;
}

function notesAreWellFormed(notes: readonly unknown[] | undefined): boolean {
  if (notes === undefined) return true;
  if (!Array.isArray(notes) || notes.length > MAX_ARTIFACT_NOTES) return false;
  return notes.every((note) => typeof note === "string" && note.length > 0 && note.length <= MAX_ARTIFACT_NOTE_CHARS);
}

export function artifactSetRejection(artifacts: readonly ArtifactInput[]): ArtifactRejectionRule | undefined {
  if (artifacts.length < 1) return "empty_set";
  if (artifacts.length > MAX_ARTIFACT_ROWS) return "too_many_rows";
  const indices = new Set<number>();
  let total = 0;
  for (const artifact of artifacts) {
    if (!Number.isInteger(artifact.artifactIndex) || artifact.artifactIndex < 0) return "index_bounds";
    if (indices.has(artifact.artifactIndex)) return "duplicate_index";
    indices.add(artifact.artifactIndex);
    const text = artifact.bodyText;
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_ARTIFACT_ROW_CHARS) return "row_text_bounds";
    total += text.length;
    if (total > MAX_ARTIFACT_TOTAL_CHARS) return "total_text_bounds";
    if (!locatorIsWellFormed(artifact.locator)) return "locator_shape";
    if (!notesAreWellFormed(artifact.notes)) return "notes_shape";
    const confidence = artifact.confidence;
    if (confidence !== undefined && !(typeof confidence === "number" && confidence >= 0 && confidence <= 1)) {
      return "confidence_bounds";
    }
  }
  return undefined;
}

// ── the loop ────────────────────────────────────────────────────────────────────────────────────

export function createBoxWorkerDeps(options: {
  env: BoxWorkerEnv;
  extractor: BoxExtractorPort;
  credential?: () => string | undefined;
  log?: (event: BoxEvent) => void;
  leaseSeconds?: number;
  maxObjectBytes?: number;
  fetchImpl?: FetchImpl;
  now?: () => number;
}): BoxWorkerDeps {
  const env = options.env;
  const baseUrl = env.TOI_JOB_API_BASE_URL ?? "";
  return {
    // The tunnel base is deployment configuration, set once at install time — never per job, never
    // from a response. An empty base makes every call fail as `network` before any credential moves.
    jobApi: createHttpBoxJobApi({
      baseUrl,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
    credential: options.credential ?? (() => env.TOI_WORKER_TOKEN),
    extractor: options.extractor,
    readObjectBytes: createBoxByteReader(
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    ),
    leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    maxObjectBytes: options.maxObjectBytes ?? MAX_OBJECT_BYTES,
    log: options.log ?? (() => undefined),
    now: options.now ?? Date.now,
  };
}

/** Ask the server, once, whether this box still holds the lease. A lost lease is a stop, not a retry. */
async function leaseIsStillHeld(deps: BoxWorkerDeps, credential: string, holder: LeaseHolder): Promise<boolean> {
  const renewed = await deps.jobApi.renew({ credential, ...holder, leaseSeconds: deps.leaseSeconds });
  return renewed.outcome === "renewed";
}

export async function runBoxPullIteration(deps: BoxWorkerDeps): Promise<IterationOutcome> {
  const credential = deps.credential();
  if (credential === undefined || credential.length === 0) {
    // Nothing to present, so nothing is sent: an unauthenticated probe would be a signal to the
    // platform and a risk to the box's credential budget.
    deps.log({ kind: "credential_unavailable" });
    return { action: "credential_missing" };
  }

  try {
    const lease = await deps.jobApi.lease({ credential, stage: "extract", leaseSeconds: deps.leaseSeconds });
    if (lease === null) {
      deps.log({ kind: "no_work" });
      return { action: "no_work" };
    }
    // #135, belt on top of braces: the SQL lease guard already ties this credential to one executor.
    if (lease.executor !== "local_box" || lease.stage !== "extract") {
      deps.log({ kind: "lease_row_rejected", jobId: lease.jobId });
      return { action: "lease_row_rejected" };
    }

    const parsed = IngestionJobPayload.safeParse({
      jobId: lease.jobId,
      organisationId: lease.organisationId,
      sourceVersionId: lease.sourceVersionId,
      stage: lease.stage,
      executor: lease.executor,
      dataClass: lease.dataClass,
      parserGeneration: lease.parserGeneration,
      indexGeneration: lease.indexGeneration,
      attempt: lease.attempt,
      leaseToken: lease.leaseToken,
      issuedAt: new Date(deps.now()).toISOString(),
    });
    if (!parsed.success) {
      // A row this box cannot describe is not processed. It is left to #99's inline reclaim and the
      // attempt cap, which are the only places retry arithmetic lives.
      deps.log({ kind: "lease_row_rejected", jobId: lease.jobId });
      return { action: "lease_row_rejected" };
    }
    const payload = parsed.data;
    const holder: LeaseHolder = { jobId: lease.jobId, leaseToken: lease.leaseToken, fence: lease.fence };
    deps.log({ kind: "leased", jobId: holder.jobId, attempt: lease.attempt, dataClass: lease.dataClass });

    const abortWith = async (reason: AbortReason): Promise<IterationOutcome> => {
      const aborted = await deps.jobApi.abort({ credential, ...holder, reason });
      if (aborted.outcome === "aborted") {
        deps.log({ kind: "aborted", jobId: holder.jobId, reason });
        return { action: "aborted", reason };
      }
      deps.log({ kind: "mutation_refused", jobId: holder.jobId, call: "abort" });
      if (await leaseIsStillHeld(deps, credential, holder)) return { action: "refused" };
      deps.log({ kind: "lease_lost", jobId: holder.jobId });
      return { action: "lease_lost" };
    };

    // The hand-off is the one response this client re-validates at the call site rather than in the
    // transport: a URL the box must not follow is a fact about this job, and saying so needs the id.
    let ref: ObjectUrlOutcome;
    try {
      ref = await deps.jobApi.objectUrl({ credential, ...holder });
    } catch (cause) {
      if (cause instanceof JobApiTransportError && cause.kind === "url_refused") {
        deps.log({ kind: "object_url_refused", jobId: holder.jobId });
        return { action: "object_unavailable", reason: "url_refused" };
      }
      throw cause;
    }
    if (!ref.found) {
      // The closed no-row answer: the version may have been revoked, or the lease moved on. The only
      // question left that the API can answer is whether this box still holds the lease.
      if (!(await leaseIsStillHeld(deps, credential, holder))) {
        deps.log({ kind: "lease_lost", jobId: holder.jobId });
        return { action: "lease_lost" };
      }
      return abortWith("object_missing");
    }

    const read = await deps.readObjectBytes(ref.url, deps.maxObjectBytes);
    if (read.status === "unavailable") {
      // Transient: leave the lease to expire. Cancelling here would destroy work the next poll would
      // finish, and #99's cap bounds how long that can repeat.
      deps.log({ kind: "object_unavailable", jobId: holder.jobId, reason: read.reason });
      return { action: "object_unavailable", reason: read.reason };
    }
    if (read.status === "oversize") {
      deps.log({ kind: "bytes_oversize", jobId: holder.jobId, sizeBytes: read.sizeBytes });
      return abortWith("unsupported_document");
    }
    if (read.status === "missing") {
      deps.log({ kind: "bytes_missing", jobId: holder.jobId });
      return abortWith("object_missing");
    }

    const extraction = await deps.extractor.extract({ payload, url: ref.url, bytes: read.bytes });
    if (extraction.outcome === "unsupported") {
      return abortWith(extraction.reason);
    }

    const rejection = artifactSetRejection(extraction.artifacts);
    if (rejection !== undefined) {
      deps.log({ kind: "artifact_set_rejected", jobId: holder.jobId, rule: rejection });
      return abortWith("quality_failed");
    }

    // Re-check under the server's authority immediately before the write. A box is the participant
    // whose clock is least trustworthy (ADR-0005 §3), so this is where a late completion is dropped.
    if (!(await leaseIsStillHeld(deps, credential, holder))) {
      deps.log({ kind: "lease_lost", jobId: holder.jobId });
      return { action: "lease_lost" };
    }

    const completed = await deps.jobApi.complete({
      credential,
      ...holder,
      sourceVersionId: payload.sourceVersionId,
      stage: payload.stage,
      indexGeneration: payload.indexGeneration,
      artifacts: extraction.artifacts,
      notes: extraction.notes ?? [],
      confidence: extraction.confidence ?? null,
    });
    if (completed.outcome === "completed") {
      deps.log({ kind: "completed", jobId: holder.jobId, artifacts: completed.artifactCount });
      return { action: "completed", artifactCount: completed.artifactCount };
    }
    if (completed.outcome === "already_completed") {
      deps.log({ kind: "already_completed", jobId: holder.jobId, artifacts: completed.artifactCount });
      return { action: "already_completed", artifactCount: completed.artifactCount };
    }

    deps.log({ kind: "mutation_refused", jobId: holder.jobId, call: "complete" });
    if (!(await leaseIsStillHeld(deps, credential, holder))) {
      deps.log({ kind: "lease_lost", jobId: holder.jobId });
      return { action: "lease_lost" };
    }
    // A live lease and a refused write: the version stopped being available to anyone.
    return abortWith("source_revoked");
  } catch (cause) {
    if (cause instanceof JobApiTransportError) {
      if (cause.kind === "not_configured") {
        // A box with no tunnel base or no credential does not poll: it stops and says which. This is
        // the fail-closed answer to an uninstalled worker — no default host is reachable from here.
        deps.log({ kind: "configuration_missing" });
        return { action: "configuration_missing" };
      }
      if (cause.kind === "unauthorized") {
        // Revoked or mis-scoped credential: stop, and let whoever issued it act. Polling on a
        // rejected credential is how a box becomes a denial of service against its own platform.
        deps.log({ kind: "credential_refused" });
        return { action: "credential_refused" };
      }
      if (cause.kind === "malformed") {
        deps.log({ kind: "job_api_malformed" });
        return { action: "job_api_malformed" };
      }
      deps.log({ kind: "job_api_unavailable" });
      return { action: "job_api_unavailable" };
    }
    throw cause;
  }
}

/**
 * The box's outer loop: poll, work one job, wait. It stops only on the answers a poll cannot fix —
 * a credential the platform refused, or a lease this box lost mid-job. A lost tunnel is the ordinary
 * case (plan §7.2 "queued for OCR"): the loop waits, the job stays `extracting`, and nothing here
 * sends the document anywhere else.
 */
export async function runBoxPullLoop(
  deps: BoxWorkerDeps,
  options: {
    maxIterations?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    stop?: () => boolean;
  } = {},
): Promise<IterationOutcome[]> {
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const outcomes: IterationOutcome[] = [];

  for (let taken = 0; taken < maxIterations; taken += 1) {
    if (options.stop?.() === true) break;
    const outcome = await runBoxPullIteration(deps);
    outcomes.push(outcome);
    if (
      outcome.action === "credential_refused" ||
      outcome.action === "lease_lost" ||
      outcome.action === "configuration_missing"
    ) {
      break;
    }
    if (taken + 1 < maxIterations) await sleep(pollIntervalMs);
  }
  return outcomes;
}
