import { describe, expect, it, vi } from "vitest";

import { IngestionJobPayload } from "@/contracts/ingestion-job";
import type { DataClass } from "@/contracts/data-class";
import type { Chunk } from "@/platform/knowledge/chunker";

import {
  createIndexWorkerDeps,
  runIndexWorkerIteration,
  runIndexWorkerPull,
  type ArtifactRow,
  type ChunkWriteRow,
  type IndexChunkerPort,
  type IndexEmbedPort,
  type IndexJobApiPort,
  type IndexWorkerEvent,
  type LeaseRow,
  type WriteChunksOutcome,
} from "./index-pull";

/**
 * T-113 index-stage consumer (lease → chunk → embed ports → write_chunks_v1).
 * Job API and embed/chunker ports are doubles; real Workers AI embed is OWNER staging.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const INDEX_ID = "55555555-5555-4555-8555-555555555555";
const CHUNK_ID = "66666666-6666-4666-8666-666666666666";
const WORKER_TOKEN = "synthetic-index-credential-0001";

const LEAK_MARKERS = [WORKER_TOKEN, "http://", "https://", "eyJ"];

type FakeIndexJob = {
  jobId: string;
  organisationId: string;
  sourceVersionId: string;
  stage: "index";
  executor: "cloud_worker";
  parserGeneration: string;
  indexGeneration: number;
  dataClass: DataClass;
  status: "queued" | "leased" | "succeeded" | "cancelled";
  leaseToken: string | null;
  fence: number;
  attempt: number;
  expiresAt: number;
  lastError: string | null;
  artifacts: ArtifactRow[];
};

function queuedIndex(overrides: Partial<FakeIndexJob> = {}): FakeIndexJob {
  return {
    jobId: JOB_ID,
    organisationId: ORG,
    sourceVersionId: VERSION_ID,
    stage: "index",
    executor: "cloud_worker",
    parserGeneration: "v1",
    indexGeneration: 1,
    dataClass: "internal",
    status: "queued",
    leaseToken: null,
    fence: 0,
    attempt: 0,
    expiresAt: 0,
    lastError: null,
    artifacts: [
      {
        artifactIndex: 0,
        bodyText: "Synthetic heading\n\nTrace spacing a quarter metre on page one.",
        locator: { page: 1 },
      },
    ],
    ...overrides,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

class FakeIndexJobApi implements IndexJobApiPort {
  calls: string[] = [];
  presentedDigests: string[] = [];
  written: ChunkWriteRow[][] = [];
  writeArgs: { embeddingIndexId: string | null }[] = [];
  credentialRevoked = false;
  clock: () => number = () => Date.now();

  constructor(readonly jobs: FakeIndexJob[] = [queuedIndex()]) {}

  async lease(args: { credential: string; stage: "index"; leaseSeconds: number }) {
    this.calls.push("lease");
    if (!(await this.credentialMatches(args.credential))) return null;
    if (args.stage !== "index" || args.leaseSeconds < 60 || args.leaseSeconds > 1800) return null;
    const row = this.jobs.find(
      (job) =>
        job.status === "queued" || (job.status === "leased" && job.expiresAt <= this.clock()),
    );
    if (!row) return null;
    row.status = "leased";
    row.attempt += 1;
    row.fence += 1;
    row.leaseToken = `synthetic-index-lease-${String(row.fence).padStart(2, "0")}`;
    row.expiresAt = this.clock() + args.leaseSeconds * 1000;
    return {
      jobId: row.jobId,
      organisationId: row.organisationId,
      sourceVersionId: row.sourceVersionId,
      stage: row.stage,
      executor: row.executor,
      parserGeneration: row.parserGeneration,
      indexGeneration: row.indexGeneration,
      dataClass: row.dataClass,
      leaseToken: row.leaseToken,
      fence: row.fence,
      attempt: row.attempt,
    } satisfies LeaseRow;
  }

  async renew(args: {
    credential: string;
    jobId: string;
    leaseToken: string;
    fence: number;
    leaseSeconds: number;
  }) {
    this.calls.push("renew");
    const row = await this.present(args.credential);
    if (!row || !this.holds(row, args)) return { outcome: "refused" as const };
    row.expiresAt = this.clock() + args.leaseSeconds * 1000;
    return { outcome: "renewed" as const, expiresAt: new Date(row.expiresAt).toISOString(), fence: row.fence };
  }

  async abort(args: {
    credential: string;
    jobId: string;
    leaseToken: string;
    fence: number;
    reason: string;
  }) {
    this.calls.push("abort");
    const row = await this.present(args.credential);
    if (!row || !this.holds(row, args)) return { outcome: "refused" as const };
    row.status = "cancelled";
    row.lastError = args.reason;
    row.leaseToken = null;
    row.expiresAt = 0;
    return { outcome: "aborted" as const };
  }

  async artifactsForLease(args: {
    credential: string;
    jobId: string;
    leaseToken: string;
    fence: number;
  }) {
    this.calls.push("artifactsForLease");
    const row = await this.present(args.credential);
    if (!row || !this.holds(row, args)) return { found: false as const };
    return { found: true as const, artifacts: row.artifacts };
  }

  async writeChunks(args: {
    credential: string;
    jobId: string;
    leaseToken: string;
    fence: number;
    sourceVersionId: string;
    indexGeneration: number;
    embeddingIndexId: string | null;
    chunks: readonly ChunkWriteRow[];
  }): Promise<WriteChunksOutcome> {
    this.calls.push("writeChunks");
    const row = await this.present(args.credential);
    if (!row) return { outcome: "refused" };
    if (
      !this.holds(row, args) ||
      row.sourceVersionId !== args.sourceVersionId ||
      row.indexGeneration !== args.indexGeneration
    ) {
      if (row.status === "succeeded") {
        return { outcome: "already_completed", chunkCount: this.written.flat().length, vectorCount: 0 };
      }
      return { outcome: "refused" };
    }
    row.status = "succeeded";
    row.leaseToken = null;
    row.expiresAt = 0;
    this.written.push([...args.chunks]);
    this.writeArgs.push({ embeddingIndexId: args.embeddingIndexId });
    const vectorCount = args.chunks.filter((c) => c.embedding !== undefined).length;
    return {
      outcome: "completed",
      chunkCount: args.chunks.length,
      vectorCount,
      eventId: "77777777-7777-4777-8777-777777777777",
    };
  }

  private async credentialMatches(credential: string): Promise<boolean> {
    this.presentedDigests.push(await sha256Hex(credential));
    return credential === WORKER_TOKEN && !this.credentialRevoked;
  }

  private async present(credential: string): Promise<FakeIndexJob | null> {
    if (!(await this.credentialMatches(credential))) return null;
    return this.jobs[0] ?? null;
  }

  private holds(
    row: FakeIndexJob,
    args: { jobId: string; leaseToken: string; fence: number },
  ): boolean {
    return (
      row.jobId === args.jobId &&
      row.leaseToken !== null &&
      row.leaseToken === args.leaseToken &&
      row.fence === args.fence &&
      row.status === "leased" &&
      row.expiresAt > this.clock()
    );
  }
}

const ONE_CHUNK: Chunk = {
  chunkId: CHUNK_ID,
  ordinal: 0,
  text: "Synthetic heading\n\nTrace spacing a quarter metre on page one.",
  headings: ["Synthetic heading"],
  dataClass: "internal",
  page: 1,
};

function chunkerReturning(chunks: readonly Chunk[]): IndexChunkerPort {
  return {
    async chunk() {
      return [...chunks];
    },
  };
}

function embedReturning(
  result: Awaited<ReturnType<IndexEmbedPort["embed"]>>,
): IndexEmbedPort {
  return { embed: async () => result };
}

function assertNoLeaks(events: IndexWorkerEvent[]) {
  const blob = JSON.stringify(events);
  for (const marker of LEAK_MARKERS) {
    expect(blob.includes(marker), `event log must not contain ${marker}`).toBe(false);
  }
}

describe("workers/index-pull.ts — index-stage consumer (T-113)", () => {
  it("fails closed with no credential and never dials the job API", async () => {
    const jobApi = new FakeIndexJobApi();
    const events: IndexWorkerEvent[] = [];
    const outcome = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => undefined,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({ outcome: "lexical_only" }),
        log: (e) => events.push(e),
      }),
    );
    expect(outcome).toEqual({ action: "credential_missing" });
    expect(jobApi.calls).toEqual([]);
    assertNoLeaks(events);
  });

  it("reports no_work when the index queue is empty", async () => {
    const jobApi = new FakeIndexJobApi([]);
    const outcome = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({ outcome: "lexical_only" }),
      }),
    );
    expect(outcome).toEqual({ action: "no_work" });
    expect(jobApi.calls).toEqual(["lease"]);
  });

  it("leases stage=index, validates the contract payload, and writes chunks via writeChunks", async () => {
    const jobApi = new FakeIndexJobApi();
    const events: IndexWorkerEvent[] = [];
    const outcome = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({
          outcome: "embedded",
          embeddingIndexId: INDEX_ID,
          vectors: new Map([[CHUNK_ID, Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0.001))]]),
        }),
        log: (e) => events.push(e),
      }),
    );
    expect(outcome).toEqual({ action: "completed", chunkCount: 1, vectorCount: 1 });
    expect(jobApi.calls).toEqual(["lease", "artifactsForLease", "renew", "writeChunks"]);
    expect(jobApi.writeArgs[0]?.embeddingIndexId).toBe(INDEX_ID);
    expect(jobApi.written[0]?.[0]?.chunkId).toBe(CHUNK_ID);
    expect(jobApi.written[0]?.[0]?.embedding).toHaveLength(8);
    expect(jobApi.presentedDigests[0]).toBe(await sha256Hex(WORKER_TOKEN));
    const leased = events.find((e) => e.kind === "leased");
    expect(leased?.kind).toBe("leased");
    if (leased?.kind === "leased") {
      const parsed = IngestionJobPayload.safeParse({
        jobId: leased.jobId,
        organisationId: ORG,
        sourceVersionId: VERSION_ID,
        stage: "index",
        executor: "cloud_worker",
        dataClass: "internal",
        parserGeneration: "v1",
        indexGeneration: 1,
        attempt: 1,
        leaseToken: "synthetic-index-lease-01",
        issuedAt: new Date().toISOString(),
      });
      expect(parsed.success).toBe(true);
    }
    assertNoLeaks(events);
  });

  it("writes lexical-only when the embed port says no cleared index (embeddingIndexId null)", async () => {
    const jobApi = new FakeIndexJobApi();
    const outcome = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({ outcome: "lexical_only" }),
      }),
    );
    expect(outcome).toEqual({ action: "completed", chunkCount: 1, vectorCount: 0 });
    expect(jobApi.writeArgs[0]?.embeddingIndexId).toBeNull();
    expect(jobApi.written[0]?.[0]?.embedding).toBeUndefined();
  });

  it("aborts with embedding_route_unavailable and never writes when the embed route is down", async () => {
    const jobApi = new FakeIndexJobApi();
    const embed = vi.fn(async () => ({ outcome: "route_unavailable" as const }));
    const outcome = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: { embed },
      }),
    );
    expect(outcome).toEqual({ action: "aborted", reason: "embedding_route_unavailable" });
    expect(jobApi.calls).toContain("abort");
    expect(jobApi.calls).not.toContain("writeChunks");
    expect(jobApi.jobs[0]?.status).toBe("cancelled");
    expect(jobApi.jobs[0]?.lastError).toBe("embedding_route_unavailable");
    expect(embed).toHaveBeenCalledOnce();
  });

  it("aborts quality_failed when the chunker yields an empty set", async () => {
    const jobApi = new FakeIndexJobApi();
    const outcome = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([]),
        embed: embedReturning({ outcome: "lexical_only" }),
      }),
    );
    expect(outcome).toEqual({ action: "aborted", reason: "quality_failed" });
    expect(jobApi.calls).not.toContain("writeChunks");
  });

  it("aborts when artifacts_for_lease refuses on a live lease", async () => {
    const jobApi = new FakeIndexJobApi([queuedIndex({ artifacts: [] })]);
    const original = jobApi.artifactsForLease.bind(jobApi);
    jobApi.artifactsForLease = async (args) => {
      await original(args);
      return { found: false };
    };
    const outcome = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({ outcome: "lexical_only" }),
      }),
    );
    expect(outcome).toEqual({ action: "aborted", reason: "object_missing" });
  });

  it("treats already_completed as a no-op success (at-least-once)", async () => {
    const jobApi = new FakeIndexJobApi();
    const first = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({ outcome: "lexical_only" }),
      }),
    );
    expect(first.action).toBe("completed");
    // Re-queue a duplicate delivery against the succeeded fence via a second leased attempt
    // that writeChunks answers already_completed.
    jobApi.jobs[0]!.status = "leased";
    jobApi.jobs[0]!.leaseToken = "synthetic-index-lease-99";
    jobApi.jobs[0]!.fence = 99;
    jobApi.jobs[0]!.expiresAt = Date.now() + 60_000;
    jobApi.lease = async () => ({
      jobId: JOB_ID,
      organisationId: ORG,
      sourceVersionId: VERSION_ID,
      stage: "index",
      executor: "cloud_worker",
      parserGeneration: "v1",
      indexGeneration: 1,
      dataClass: "internal",
      leaseToken: "synthetic-index-lease-99",
      fence: 99,
      attempt: 2,
    });
    const priorStatus = jobApi.jobs[0]!.status;
    jobApi.writeChunks = async () => {
      expect(priorStatus).toBe("leased");
      return { outcome: "already_completed", chunkCount: 1, vectorCount: 0 };
    };
    const second = await runIndexWorkerIteration(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({ outcome: "lexical_only" }),
      }),
    );
    expect(second).toEqual({ action: "already_completed", chunkCount: 1, vectorCount: 0 });
  });

  it("pull loop stops on no_work without spinning", async () => {
    const jobApi = new FakeIndexJobApi([]);
    const outcomes = await runIndexWorkerPull(
      createIndexWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        chunker: chunkerReturning([ONE_CHUNK]),
        embed: embedReturning({ outcome: "lexical_only" }),
      }),
      { maxJobs: 4 },
    );
    expect(outcomes).toEqual([{ action: "no_work" }]);
    expect(jobApi.calls.filter((c) => c === "lease")).toHaveLength(1);
  });
});
