import { IngestionJobPayload } from "@/contracts/ingestion-job";
import type { DataClass } from "@/contracts/data-class";
import type { Chunk } from "@/platform/knowledge/chunker";

import type {
  AbortOutcome,
  AbortReason,
  LeaseHolder,
  LeaseRow,
  RenewOutcome,
} from "./ocr-pull";
import { DEFAULT_LEASE_SECONDS, DEFAULT_MAX_JOBS_PER_INVOCATION } from "./ocr-pull";

/**
 * Cloud **index-stage** consumer (T-113 follow-up): lease `index` → load extract artifacts →
 * chunk → embed (injected ports) → `job_api.write_chunks_v1`.
 *
 * Mirrors `ocr-pull.ts` discipline: no listener, tenant only from the leased job row, closed
 * event vocabulary, fail closed without a credential. Real embedding calls are an OWNER
 * staging concern — tests inject fixture vectors. Gateway clearance is never bypassed: the
 * embed port is expected to refuse before contacting a provider (plan §12.4).
 *
 * Publish (`publish_version_v1`) is a separate stage keyed off `index_succeeded` outbox
 * dispatch and is out of this module's loop.
 */

export type { LeaseRow, LeaseHolder, RenewOutcome, AbortOutcome };

/** One extract artifact as the index loop consumes it (shape from `extraction_artifacts`). */
export interface ArtifactRow {
  artifactIndex: number;
  bodyText: string;
  locator?: Record<string, unknown> | undefined;
}

export type ArtifactsOutcome =
  | { found: true; artifacts: readonly ArtifactRow[] }
  | { found: false };

/** One chunk payload for `job_api.write_chunks_v1` (snake keys are applied by the JOB_DB adapter). */
export interface ChunkWriteRow {
  chunkIndex: number;
  bodyText: string;
  chunkId?: string | undefined;
  locator?: Record<string, unknown> | undefined;
  dataClass?: DataClass | undefined;
  tokenCount?: number | undefined;
  embedding?: readonly number[] | undefined;
}

export type WriteChunksOutcome =
  | { outcome: "completed"; chunkCount: number; vectorCount: number; eventId: string | null }
  | { outcome: "already_completed"; chunkCount: number; vectorCount: number }
  | { outcome: "refused" };

/**
 * Job-API surface the index loop needs. `lease` is always `stage: "index"` — extract stays on
 * `ocr-pull`. Adapter hashes the credential before SQL (#134).
 */
export interface IndexJobApiPort {
  lease(args: {
    credential: string;
    stage: "index";
    leaseSeconds: number;
  }): Promise<LeaseRow | null>;
  renew(args: LeaseHolder & { credential: string; leaseSeconds: number }): Promise<RenewOutcome>;
  abort(args: LeaseHolder & { credential: string; reason: AbortReason }): Promise<AbortOutcome>;
  artifactsForLease(args: LeaseHolder & { credential: string }): Promise<ArtifactsOutcome>;
  writeChunks(
    args: LeaseHolder & {
      credential: string;
      sourceVersionId: string;
      indexGeneration: number;
      embeddingIndexId: string | null;
      chunks: readonly ChunkWriteRow[];
    },
  ): Promise<WriteChunksOutcome>;
}

export interface IndexChunkerInput {
  sourceVersionId: string;
  parserGeneration: string;
  dataClass: DataClass;
  artifacts: readonly ArtifactRow[];
}

export interface IndexChunkerPort {
  chunk(input: IndexChunkerInput): Promise<readonly Chunk[]>;
}

export type IndexEmbedResult =
  | {
      outcome: "embedded";
      embeddingIndexId: string;
      vectors: ReadonlyMap<string, readonly number[]>;
    }
  /** No active index cleared for any chunk of this version — lexical-only write is legitimate. */
  | { outcome: "lexical_only" }
  /** Pinned route down while an index is cleared for some chunk — must abort, never omit the id. */
  | { outcome: "route_unavailable" };

export interface IndexEmbedPort {
  embed(input: {
    organisationId: string;
    indexGeneration: number;
    dataClass: DataClass;
    chunks: readonly Chunk[];
  }): Promise<IndexEmbedResult>;
}

export type IndexWorkerEvent =
  | { kind: "credential_unavailable" }
  | { kind: "no_work" }
  | { kind: "leased"; jobId: string; attempt: number; dataClass: DataClass }
  | { kind: "lease_row_rejected"; jobId: string }
  | { kind: "lease_lost"; jobId: string }
  | { kind: "artifacts_refused"; jobId: string }
  | { kind: "chunk_set_empty"; jobId: string }
  | { kind: "mutation_refused"; jobId: string; call: "writeChunks" | "abort" }
  | { kind: "completed"; jobId: string; chunks: number; vectors: number }
  | { kind: "already_completed"; jobId: string; chunks: number; vectors: number }
  | { kind: "aborted"; jobId: string; reason: AbortReason };

export type IndexIterationOutcome =
  | { action: "credential_missing" }
  | { action: "no_work" }
  | { action: "lease_row_rejected" }
  | { action: "lease_lost" }
  | { action: "completed"; chunkCount: number; vectorCount: number }
  | { action: "already_completed"; chunkCount: number; vectorCount: number }
  | { action: "aborted"; reason: AbortReason }
  | { action: "refused" };

export interface IndexWorkerDeps {
  jobApi: IndexJobApiPort;
  credential: () => string | undefined;
  chunker: IndexChunkerPort;
  embed: IndexEmbedPort;
  leaseSeconds: number;
  log: (event: IndexWorkerEvent) => void;
  now: () => number;
}

export function createIndexWorkerDeps(options: {
  jobApi: IndexJobApiPort;
  chunker: IndexChunkerPort;
  embed: IndexEmbedPort;
  credential?: () => string | undefined;
  leaseSeconds?: number;
  log?: (event: IndexWorkerEvent) => void;
  now?: () => number;
  /** Env fallback for the worker token when `credential` is omitted. */
  env?: { TOI_WORKER_TOKEN?: string | undefined };
}): IndexWorkerDeps {
  return {
    jobApi: options.jobApi,
    chunker: options.chunker,
    embed: options.embed,
    credential:
      options.credential ?? (() => options.env?.TOI_WORKER_TOKEN),
    leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    log: options.log ?? (() => undefined),
    now: options.now ?? Date.now,
  };
}

async function leaseIsStillHeld(
  deps: IndexWorkerDeps,
  credential: string,
  holder: LeaseHolder,
): Promise<boolean> {
  const renewed = await deps.jobApi.renew({
    credential,
    ...holder,
    leaseSeconds: deps.leaseSeconds,
  });
  return renewed.outcome === "renewed";
}

function chunksToWriteRows(
  chunks: readonly Chunk[],
  vectors: ReadonlyMap<string, readonly number[]> | null,
): ChunkWriteRow[] {
  return chunks.map((chunk) => {
    const row: ChunkWriteRow = {
      chunkIndex: chunk.ordinal,
      bodyText: chunk.text,
      chunkId: chunk.chunkId,
      dataClass: chunk.dataClass,
    };
    const locator: Record<string, unknown> = {};
    if (chunk.page !== undefined) locator.page = chunk.page;
    if (chunk.headings.length > 0) locator.headings = chunk.headings;
    if (Object.keys(locator).length > 0) row.locator = locator;
    const embedding = vectors?.get(chunk.chunkId);
    if (embedding !== undefined) row.embedding = embedding;
    return row;
  });
}

/** One index job, start to finish. Platform refusals become outcomes, not throws. */
export async function runIndexWorkerIteration(
  deps: IndexWorkerDeps,
): Promise<IndexIterationOutcome> {
  const credential = deps.credential();
  if (credential === undefined || credential.length === 0) {
    deps.log({ kind: "credential_unavailable" });
    return { action: "credential_missing" };
  }

  const lease = await deps.jobApi.lease({
    credential,
    stage: "index",
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
    dataClass: lease.dataClass,
  });

  if (lease.executor !== "cloud_worker" || lease.stage !== "index") {
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
    deps.log({ kind: "lease_row_rejected", jobId: lease.jobId });
    return { action: "lease_row_rejected" };
  }
  const payload = parsed.data;
  const holder: LeaseHolder = {
    jobId: lease.jobId,
    leaseToken: lease.leaseToken,
    fence: lease.fence,
  };

  const refuseOrLose = async (
    call: "writeChunks" | "abort",
    contentReason?: AbortReason,
  ): Promise<IndexIterationOutcome> => {
    deps.log({ kind: "mutation_refused", jobId: holder.jobId, call });
    if (!(await leaseIsStillHeld(deps, credential, holder))) {
      deps.log({ kind: "lease_lost", jobId: holder.jobId });
      return { action: "lease_lost" };
    }
    if (contentReason !== undefined) return abortWith(contentReason);
    return { action: "refused" };
  };

  const abortWith = async (reason: AbortReason): Promise<IndexIterationOutcome> => {
    const aborted = await deps.jobApi.abort({ credential, ...holder, reason });
    if (aborted.outcome === "aborted") {
      deps.log({ kind: "aborted", jobId: holder.jobId, reason });
      return { action: "aborted", reason };
    }
    return refuseOrLose("abort");
  };

  const artifacts = await deps.jobApi.artifactsForLease({ credential, ...holder });
  if (!artifacts.found) {
    deps.log({ kind: "artifacts_refused", jobId: holder.jobId });
    if (!(await leaseIsStillHeld(deps, credential, holder))) {
      deps.log({ kind: "lease_lost", jobId: holder.jobId });
      return { action: "lease_lost" };
    }
    return abortWith("object_missing");
  }
  if (artifacts.artifacts.length < 1) {
    deps.log({ kind: "chunk_set_empty", jobId: holder.jobId });
    return abortWith("quality_failed");
  }

  const chunks = await deps.chunker.chunk({
    sourceVersionId: payload.sourceVersionId,
    parserGeneration: payload.parserGeneration,
    dataClass: payload.dataClass,
    artifacts: artifacts.artifacts,
  });
  if (chunks.length < 1) {
    deps.log({ kind: "chunk_set_empty", jobId: holder.jobId });
    return abortWith("quality_failed");
  }

  const embedResult = await deps.embed.embed({
    organisationId: payload.organisationId,
    indexGeneration: payload.indexGeneration,
    dataClass: payload.dataClass,
    chunks,
  });

  if (embedResult.outcome === "route_unavailable") {
    return abortWith("embedding_route_unavailable");
  }

  const embeddingIndexId =
    embedResult.outcome === "embedded" ? embedResult.embeddingIndexId : null;
  const vectors = embedResult.outcome === "embedded" ? embedResult.vectors : null;
  const writeRows = chunksToWriteRows(chunks, vectors);

  if (!(await leaseIsStillHeld(deps, credential, holder))) {
    deps.log({ kind: "lease_lost", jobId: holder.jobId });
    return { action: "lease_lost" };
  }

  const written = await deps.jobApi.writeChunks({
    credential,
    ...holder,
    sourceVersionId: payload.sourceVersionId,
    indexGeneration: payload.indexGeneration,
    embeddingIndexId,
    chunks: writeRows,
  });

  if (written.outcome === "completed") {
    deps.log({
      kind: "completed",
      jobId: holder.jobId,
      chunks: written.chunkCount,
      vectors: written.vectorCount,
    });
    return {
      action: "completed",
      chunkCount: written.chunkCount,
      vectorCount: written.vectorCount,
    };
  }
  if (written.outcome === "already_completed") {
    deps.log({
      kind: "already_completed",
      jobId: holder.jobId,
      chunks: written.chunkCount,
      vectors: written.vectorCount,
    });
    return {
      action: "already_completed",
      chunkCount: written.chunkCount,
      vectorCount: written.vectorCount,
    };
  }

  return refuseOrLose("writeChunks", "source_revoked");
}

export async function runIndexWorkerPull(
  deps: IndexWorkerDeps,
  options: { maxJobs?: number } = {},
): Promise<IndexIterationOutcome[]> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS_PER_INVOCATION;
  const outcomes: IndexIterationOutcome[] = [];
  for (let taken = 0; taken < maxJobs; taken += 1) {
    const outcome = await runIndexWorkerIteration(deps);
    outcomes.push(outcome);
    if (
      outcome.action === "no_work" ||
      outcome.action === "credential_missing" ||
      outcome.action === "lease_row_rejected" ||
      outcome.action === "lease_lost"
    ) {
      break;
    }
  }
  return outcomes;
}
