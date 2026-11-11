import { IngestionJobPayload, type IngestionStage, type JobExecutor } from "@/contracts/ingestion-job";
import type { DataClass } from "@/contracts/data-class";
import { MAX_UPLOAD_BYTES } from "@/platform/knowledge/object-validator";
import type { ObjectReadResult } from "@/platform/knowledge/object-store";
import type { FetchImpl } from "@/platform/gateway/adapters";

import {
  createStorageUrlSigner,
  type ObjectUrlSigner,
  type StorageSignEnv,
  type StorageSignFailure,
} from "./object-signing";

/**
 * The **cloud executor** for `executor = cloud_worker` extraction jobs (plan §7.2 "Extraction
 * executors", §13; F12, F32; T-211 PR-2).
 *
 * The loop is the client half of `job_api` (#134, #135, #146). It owns no schema decision and
 * invents no authority: it leases one `extract` job, asks `object_ref_for_lease_v1` for the object of
 * the lease it *holds*, has the extraction deployment mint the 60-second URL
 * ([ADR-0011](../docs/decisions/0011-object-bytes-for-the-extraction-workers.md)), reads the bytes
 * under a bound, hands them to an injected extractor, and then makes exactly one mutating call —
 * complete, retarget or abort — with the lease token and the fence it was issued.
 *
 * Four things this file does **not** do:
 *
 * * **Listen.** No port, no server, no inbound path (F32). Every socket is one it dialled outbound.
 * * **Take the tenant from anywhere but the job row.** The lease response's `organisationId` is
 *   server-issued metadata; nothing here sends a tenant id *to* the API (AGENTS §4.1).
 * * **Log a capability.** The event union has no free-text field: no URL, no object key, no
 *   credential, no document words (ADR-0011 Decision 3, AGENTS §4.6, §4.8).
 * * **Reach a third-party OCR service.** The extractor is an injected port; T-212's is in-process,
 *   and a model call from inside it goes through the gateway (AGENTS §4.3). Nothing here can be
 *   pointed at a provider (ADR-0005 §8, threat-model bullet 3).
 *
 * The compare itself lives in SQL. The `JobApiPort` below is a faithful description of the merged
 * functions' arguments and *closed* answers, including the one that matters most: foreign, unknown
 * and superseded all answer the same way, so this loop can never learn that another tenant's job
 * exists.
 */

/** `job_api.max_lease_seconds()` is 1800 and the floor is 60; 300 covers one bounded parse. */
export const DEFAULT_LEASE_SECONDS = 300;

/**
 * The byte bound for one read. Deliberately the same number capture already enforced
 * (`src/platform/knowledge/object-validator.ts:31`, plan §7.5's 20 MB pilot document): an object that
 * is bigger than that is not a document this pipeline accepted, and reading it into a Worker
 * invocation is a memory problem we would rather refuse than discover.
 */
export const MAX_OBJECT_BYTES = MAX_UPLOAD_BYTES;

/** A GET that hangs must not hold the invocation open longer than the lease it belongs to. */
export const OBJECT_READ_TIMEOUT_MS = 60_000;

/** How many jobs one invocation may take. Queue/cron driven: the invocation is the unit of work. */
export const DEFAULT_MAX_JOBS_PER_INVOCATION = 4;

/**
 * Mirrors `job_api.abort_reasons()` (`20261109230000_ocr_job_leases.sql:109-114`). The SQL array is
 * the authority — a code it does not name is a refusal — and this union is a compile-time echo so a
 * caller cannot invent a reason at a call site, not a second gate.
 */
export type AbortReason =
  | "abandoned_by_worker"
  | "source_revoked"
  | "unsupported_document"
  | "object_missing"
  | "quality_failed"
  | "operator_cancel"
  | "clearance_refused";

/** Mirrors `job_api.retarget_reasons()` (`:120-126`), same note. T-212's routing decision names them. */
export type RetargetReason =
  | "no_text_layer"
  | "too_few_chars"
  | "page_coverage_low"
  | "replacement_ratio_high"
  | "over_page_count"
  | "unsupported_filter"
  | "parse_failed"
  | "quality_failed"
  | "class_not_cleared_for_cloud";

/** One located unit of extracted text; the shape `complete_parse_job_v1` validates (`:475-496`). */
export interface ArtifactInput {
  artifactIndex: number;
  bodyText: string;
  locator?: Record<string, unknown> | undefined;
  confidence?: number | undefined;
  notes?: readonly string[] | undefined;
}

/** What `lease_parse_job_v1` returns, column for column (`:297-388`). */
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

/** The proof of a lease, carried on every mutating call: token and fence, exactly as issued. */
export interface LeaseHolder {
  jobId: string;
  leaseToken: string;
  fence: number;
}

export type RenewOutcome =
  | { outcome: "renewed"; expiresAt: string; fence: number }
  | { outcome: "refused" };

/** `object_ref_for_lease_v1`: one closed answer, no existence signal either way (`:722-768`). */
export type ObjectRefOutcome =
  | { found: true; objectRef: string; dataClass: DataClass; executor: JobExecutor }
  | { found: false };

export type CompleteOutcome =
  | { outcome: "completed"; artifactCount: number }
  | { outcome: "already_completed"; artifactCount: number }
  /** Foreign, unknown, revoked, uncleared or superseded: all one answer (ADR-0005 §8). */
  | { outcome: "refused" };

export type AbortOutcome = { outcome: "aborted" } | { outcome: "refused" };
export type RetargetOutcome = { outcome: "retargeted" } | { outcome: "refused" };

/**
 * The six `job_api` functions as a port. The `credential` argument is the worker's own token, which
 * this deployment holds as a secret; **the adapter hashes it** before it reaches SQL, because the
 * merged compares match `worker_credentials.token_hash` (#134). PR-3's `JOB_DB` adapter implements
 * this against Hyperdrive as `toi_job_api`; the tests implement it in memory.
 */
export interface JobApiPort {
  lease(args: { credential: string; stage: IngestionStage; leaseSeconds: number }): Promise<LeaseRow | null>;
  renew(args: LeaseHolder & { credential: string; leaseSeconds: number }): Promise<RenewOutcome>;
  objectRefForLease(args: LeaseHolder & { credential: string }): Promise<ObjectRefOutcome>;
  complete(args:
    | LeaseHolder & {
        credential: string;
        sourceVersionId: string;
        stage: IngestionStage;
        indexGeneration: number;
        artifacts: readonly ArtifactInput[];
        notes: readonly string[];
        confidence: number | null;
      }
  ): Promise<CompleteOutcome>;
  abort(args: LeaseHolder & { credential: string; reason: AbortReason }): Promise<AbortOutcome>;
  retarget(args: LeaseHolder & { credential: string; reason: RetargetReason }): Promise<RetargetOutcome>;
}

/**
 * The extraction seam. T-212 is not merged, so this port is the whole of what the loop assumes: bytes
 * in, located text out — or an explicit statement that the document belongs to the box, or that
 * nothing should run it. A fake satisfies it in tests, and the loop never gets to choose *how* text
 * is produced, which is what keeps a third-party OCR service unreachable from here (ADR-0005 §8).
 */
export interface ExtractorInput {
  /** The validated contract message — the extractor's only authority about which object this is. */
  payload: IngestionJobPayload;
  bytes: Uint8Array;
}

export type ExtractorResult =
  | { outcome: "extracted"; artifacts: readonly ArtifactInput[]; notes?: readonly string[] | undefined; confidence?: number | undefined }
  | { outcome: "needs_local_box"; reason: RetargetReason; notes?: readonly string[] | undefined }
  | { outcome: "unsupported"; reason: AbortReason; notes?: readonly string[] | undefined };

export interface ExtractorPort {
  extract(input: ExtractorInput): Promise<ExtractorResult>;
}

/**
 * `ObjectStore.readBounded`'s three statuses (`src/platform/knowledge/object-store.ts:14-21`) plus
 * one: a mint or transport refusal is **not** a missing object, and collapsing the two would let a
 * Storage outage cancel a job that would have succeeded on the next attempt. When the merged port
 * gains the fourth arm, this type folds into it.
 */
export type ObjectBytes =
  | ObjectReadResult
  | { status: "unavailable"; reason: StorageSignFailure | "network" | "http_error" };

export type ByteReader = (objectRef: string, maxBytes: number) => Promise<ObjectBytes>;

/** The names this deployment must be configured with; the secret half is a `wrangler secret` (T-004 §20.8). */
export interface CloudWorkerEnv extends StorageSignEnv {
  /** The value whose digest sits in `job_api.worker_credentials`. Not a storage key. */
  TOI_WORKER_TOKEN?: string | undefined;
}

export interface CloudWorkerDeps {
  jobApi: JobApiPort;
  /** Read when the call is made, so a rotation is seen by the next lease (adapter precedent). */
  credential: () => string | undefined;
  extractor: ExtractorPort;
  readObjectBytes: ByteReader;
  leaseSeconds: number;
  maxObjectBytes: number;
  /** Structured, closed-vocabulary events. Nothing else may reach a log. */
  log: (event: WorkerEvent) => void;
  /** Injectable clock, monotonic-per-iteration use only: the server owns lease time. */
  now: () => number;
}

/**
 * Every event this loop can emit. A uuid job id is safe to log (it is the worker's own job, and it is
 * not a capability); a URL, an object key, a credential or a document word is not a field here at all.
 */
export type WorkerEvent =
  | { kind: "credential_unavailable" }
  | { kind: "no_work" }
  | { kind: "leased"; jobId: string; attempt: number; executor: JobExecutor; dataClass: DataClass }
  | { kind: "lease_row_rejected"; jobId: string }
  | { kind: "lease_lost"; jobId: string }
  | { kind: "object_ref_refused"; jobId: string }
  | { kind: "bytes_unavailable"; jobId: string; reason: StorageSignFailure | "network" | "http_error" }
  | { kind: "bytes_oversize"; jobId: string; sizeBytes: number | null }
  | { kind: "bytes_missing"; jobId: string }
  | { kind: "artifact_set_rejected"; jobId: string; rule: ArtifactRejectionRule }
  | { kind: "mutation_refused"; jobId: string; call: "complete" | "abort" | "retarget" }
  | { kind: "completed"; jobId: string; artifacts: number }
  | { kind: "already_completed"; jobId: string; artifacts: number }
  | { kind: "retargeted"; jobId: string; reason: RetargetReason }
  | { kind: "aborted"; jobId: string; reason: AbortReason };

/** What one iteration decided. Returned so a caller can report it without reading a log line. */
export type IterationOutcome =
  | { action: "credential_missing" }
  | { action: "no_work" }
  | { action: "lease_row_rejected" }
  | { action: "lease_lost" }
  | { action: "storage_unavailable"; reason: StorageSignFailure | "network" | "http_error" }
  | { action: "completed"; artifactCount: number }
  | { action: "already_completed"; artifactCount: number }
  | { action: "retargeted"; reason: RetargetReason }
  | { action: "aborted"; reason: AbortReason }
  /** The platform refused a call and the lease probe says the lease is still live. */
  | { action: "refused" };

// ── the bounded read: mint, then GET, and never hold more than the bound ─────────────────────────

/**
 * The `ObjectStore` discipline over a signed URL: sign inside the read, so the URL exists only for
 * the duration of the GET, and bound the body two ways — a declared length that already breaks the
 * bound, and a stream that turns out to be longer than it said.
 */
export function createSignedByteReader(options: {
  signer: ObjectUrlSigner;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): ByteReader {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? OBJECT_READ_TIMEOUT_MS;

  return async (objectRef: string, maxBytes: number): Promise<ObjectBytes> => {
    const signed = await options.signer(objectRef);
    if (signed.status === "unavailable") {
      // A refusal to mint is not a missing object: `not_found` is the only Storage answer that means
      // the bytes are gone, and that one arrives below as a 404 from the GET.
      if (signed.reason === "not_found") return { status: "missing" };
      return { status: "unavailable", reason: signed.reason };
    }

    let response: Response;
    try {
      response = await fetchImpl(signed.url, {
        method: "GET",
        // The signed URL is the credential. Nothing else goes on this request, and a redirect would
        // carry it somewhere the deployment did not configure.
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
        // Stop reading; the rest of a 20 MB scan is not going into this invocation's memory.
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

// ── the artifact set: refuse locally what the artifact home would refuse in SQL ──────────────────

const MAX_ARTIFACT_ROWS = 2000;
const MAX_ARTIFACT_TOTAL_CHARS = 2_000_000;
const MAX_ARTIFACT_ROW_CHARS = 100_000;
const MAX_ARTIFACT_NOTES = 50;
const MAX_ARTIFACT_NOTE_CHARS = 500;

/** The rules `complete_parse_job_v1` enforces (`:462-499`) plus the locator types it CHECKs. */
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
  // The merged guard refuses a `notes` key inside a locator; document words do not belong in one.
  if (record["notes"] !== undefined) return false;
  if (record["page"] !== undefined && typeof record["page"] !== "number") return false;
  if (record["section"] !== undefined && typeof record["section"] !== "string") return false;
  if (record["table"] !== undefined && typeof record["table"] !== "string") return false;
  return true;
}

function notesAreWellFormed(notes: readonly unknown[] | undefined): boolean {
  if (notes === undefined) return true;
  if (!Array.isArray(notes) || notes.length > MAX_ARTIFACT_NOTES) return false;
  return notes.every(
    (note) => typeof note === "string" && note.length > 0 && note.length <= MAX_ARTIFACT_NOTE_CHARS,
  );
}

/**
 * A refusal here is not a shortcut around SQL's guard: it is the difference between a named
 * `quality_failed` abort and an exception in the middle of a Worker invocation. The numbers are the
 * merged ones, and the artifact home's own CHECK remains the authority.
 */
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
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_ARTIFACT_ROW_CHARS) {
      return "row_text_bounds";
    }
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

/**
 * Wiring for the deployment: the env names live here, the secret is read inside
 * `./object-signing`, and this file never names it — which is what
 * `workers/import-boundary.test.ts` checks.
 */
export function createCloudWorkerDeps(options: {
  env: CloudWorkerEnv;
  jobApi: JobApiPort;
  extractor: ExtractorPort;
  credential?: () => string | undefined;
  log?: (event: WorkerEvent) => void;
  leaseSeconds?: number;
  maxObjectBytes?: number;
  fetchImpl?: FetchImpl;
  now?: () => number;
}): CloudWorkerDeps {
  const env = options.env;
  const signer = createStorageUrlSigner(env, options.fetchImpl);
  return {
    jobApi: options.jobApi,
    extractor: options.extractor,
    // Read at call time: a rotated credential is picked up by the next lease without a restart.
    credential: options.credential ?? (() => env.TOI_WORKER_TOKEN),
    readObjectBytes: createSignedByteReader({
      signer,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
    leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    maxObjectBytes: options.maxObjectBytes ?? MAX_OBJECT_BYTES,
    log: options.log ?? (() => undefined),
    now: options.now ?? Date.now,
  };
}

/**
 * Ask the server, once, whether this holder still holds the lease. `renew_parse_lease_v1` is the only
 * function whose whole job is that question, and its zero-row answer is a named refusal (ADR-0005
 * §3). Extending the lease in the process is a side effect the platform already permits.
 */
async function leaseIsStillHeld(deps: CloudWorkerDeps, credential: string, holder: LeaseHolder): Promise<boolean> {
  const renewed = await deps.jobApi.renew({ credential, ...holder, leaseSeconds: deps.leaseSeconds });
  return renewed.outcome === "renewed";
}

/** One job, start to finish. Never throws for a platform refusal: every refusal is an outcome. */
export async function runCloudWorkerIteration(deps: CloudWorkerDeps): Promise<IterationOutcome> {
  const credential = deps.credential();
  if (credential === undefined || credential.length === 0) {
    // Fail closed before the socket: with no credential there is nothing to present, and sending
    // nothing is also the answer that cannot be mistaken for another tenant's worker.
    deps.log({ kind: "credential_unavailable" });
    return { action: "credential_missing" };
  }

  const lease = await deps.jobApi.lease({
    credential,
    stage: "extract",
    leaseSeconds: deps.leaseSeconds,
  });
  if (lease === null) {
    deps.log({ kind: "no_work" });
    return { action: "no_work" };
  }
  deps.log({
    kind: "leased",
    jobId: lease.jobId,
    attempt: lease.attempt,
    executor: lease.executor,
    dataClass: lease.dataClass,
  });

  // #135: this loop is the cloud executor. A row whose executor is not this credential's is never
  // processed, and SQL should have made it unleaseable in the first place.
  if (lease.executor !== "cloud_worker") {
    deps.log({ kind: "lease_row_rejected", jobId: lease.jobId });
    return { action: "lease_row_rejected" };
  }

  // The contract message, rebuilt from the row the server issued and validated with the contract's
  // own `.strict()` schema. A row this loop cannot describe is not processed: the lease is simply
  // dropped, and #99's inline reclaim plus the attempt cap handle the row.
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
    deps.log({ kind: "lease_row_rejected", jobId: lease.jobId });
    return { action: "lease_row_rejected" };
  }
  const payload = parsed.data;
  const holder: LeaseHolder = { jobId: lease.jobId, leaseToken: lease.leaseToken, fence: lease.fence };

  /**
   * A platform refusal, classified by the one question the closed compare still permits: is this
   * holder's lease live? Lost → discard the work, never retry it in place. Held → the refusal came
   * from a content arm, and if the caller named one, that is the reason to record.
   */
  const refuseOrLose = async (
    call: "complete" | "abort" | "retarget",
    contentReason?: AbortReason,
  ): Promise<IterationOutcome> => {
    deps.log({ kind: "mutation_refused", jobId: holder.jobId, call });
    if (!(await leaseIsStillHeld(deps, credential, holder))) {
      deps.log({ kind: "lease_lost", jobId: holder.jobId });
      return { action: "lease_lost" };
    }
    if (contentReason !== undefined) return abortWith(contentReason);
    return { action: "refused" };
  };

  const abortWith = async (reason: AbortReason): Promise<IterationOutcome> => {
    const aborted = await deps.jobApi.abort({ credential, ...holder, reason });
    if (aborted.outcome === "aborted") {
      deps.log({ kind: "aborted", jobId: holder.jobId, reason });
      return { action: "aborted", reason };
    }
    return refuseOrLose("abort");
  };

  // The key comes from SQL, under the same compare as the write, and never from anything a caller
  // supplied. A no-row answer is closed on purpose, so the only question this loop can ask back is
  // "is my lease still live?".
  const ref = await deps.jobApi.objectRefForLease({ credential, ...holder });
  if (!ref.found) {
    deps.log({ kind: "object_ref_refused", jobId: holder.jobId });
    if (!(await leaseIsStillHeld(deps, credential, holder))) {
      deps.log({ kind: "lease_lost", jobId: holder.jobId });
      return { action: "lease_lost" };
    }
    // Live lease, no key. The merged function answers "no row" for a revoked version *and* for a
    // class this executor does not clear, and it must not distinguish them (ADR-0005 §8). The
    // least-specific true statement is that the object is not available to this worker; the box is
    // not attempted because every arm but the clearance one is executor-independent, so a box would
    // hit the same refusal.
    return abortWith("object_missing");
  }

  const read = await deps.readObjectBytes(ref.objectRef, deps.maxObjectBytes);
  if (read.status === "unavailable") {
    // Transient by construction: drop the lease and let the reclaim run. Aborting here would cancel
    // work that the next attempt would finish, and #99's cap bounds how long that can repeat.
    deps.log({ kind: "bytes_unavailable", jobId: holder.jobId, reason: read.reason });
    return { action: "storage_unavailable", reason: read.reason };
  }
  if (read.status === "oversize") {
    deps.log({ kind: "bytes_oversize", jobId: holder.jobId, sizeBytes: read.sizeBytes });
    return abortWith("unsupported_document");
  }
  if (read.status === "missing") {
    deps.log({ kind: "bytes_missing", jobId: holder.jobId });
    return abortWith("object_missing");
  }

  const extraction = await deps.extractor.extract({ payload, bytes: read.bytes });

  if (extraction.outcome === "needs_local_box") {
    // #66, #134: the cloud worker's own door, on its own live lease, one way, and the only writer of
    // `local_box` for this row. The fence bump that follows is what makes our own later write fail.
    const retargeted = await deps.jobApi.retarget({ credential, ...holder, reason: extraction.reason });
    if (retargeted.outcome === "retargeted") {
      deps.log({ kind: "retargeted", jobId: holder.jobId, reason: extraction.reason });
      return { action: "retargeted", reason: extraction.reason };
    }
    return refuseOrLose("retarget");
  }

  if (extraction.outcome === "unsupported") {
    return abortWith(extraction.reason);
  }

  const rejection = artifactSetRejection(extraction.artifacts);
  if (rejection !== undefined) {
    // The extractor produced something the artifact home would refuse. Say so with a named code and
    // write nothing, rather than sending a set that fails inside the write transaction.
    deps.log({ kind: "artifact_set_rejected", jobId: holder.jobId, rule: rejection });
    return abortWith("quality_failed");
  }

  // Re-check the lease under the server's authority immediately before the write. The fence defeats a
  // holder that was re-leased and the server-side expiry defeats an abandoned one; discovering that
  // here means a late completion is discarded instead of attempted.
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
    // At-least-once delivery: the duplicate wrote nothing (ADR-0005 §9's `already_completed`), which
    // is what keeps one artifact set and one outbox event per stage.
    deps.log({ kind: "already_completed", jobId: holder.jobId, artifacts: completed.artifactCount });
    return { action: "already_completed", artifactCount: completed.artifactCount };
  }

  // Refused. If the lease is live, the only arms left are the content ones — the version was revoked
  // (`complete_parse_job_v1` re-reads the parent state, `:518-523`) or the class stopped clearing this
  // executor. `source_revoked` is the named code for that; the abort is compare-guarded too, so a
  // race here cannot touch another holder's row.
  return refuseOrLose("complete", "source_revoked");
}

/**
 * A bounded pull, for a queue consumer or a cron invocation. It stops on the answers that mean
 * "another call right now would repeat yourself": an empty queue, a lost lease, a Storage refusal.
 * #99's inline reclaim and attempt cap are what re-queue a job this invocation dropped, so the loop
 * never needs its own retry counter — and must not have one, because that is how a poisoned document
 * becomes a hot loop.
 */
export async function runCloudWorkerPull(
  deps: CloudWorkerDeps,
  options: { maxJobs?: number } = {},
): Promise<IterationOutcome[]> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS_PER_INVOCATION;
  const outcomes: IterationOutcome[] = [];
  for (let taken = 0; taken < maxJobs; taken += 1) {
    const outcome = await runCloudWorkerIteration(deps);
    outcomes.push(outcome);
    if (
      outcome.action === "no_work" ||
      outcome.action === "credential_missing" ||
      outcome.action === "lease_row_rejected" ||
      outcome.action === "lease_lost" ||
      outcome.action === "storage_unavailable"
    ) {
      break;
    }
  }
  return outcomes;
}
