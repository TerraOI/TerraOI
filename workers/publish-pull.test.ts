import { describe, expect, it } from "vitest";

import { IngestionJobPayload } from "@/contracts/ingestion-job";
import type { DataClass } from "@/contracts/data-class";

import {
  createPublishWorkerDeps,
  runPublishWorkerIteration,
  runPublishWorkerPull,
  type LeaseRow,
  type PublishJobApiPort,
  type PublishVersionOutcome,
  type PublishWorkerEvent,
} from "./publish-pull";

/**
 * T-113 publish-stage consumer (lease → publish_version_v1 via injected port).
 * Job API is a double; real pointer switch is OWNER staging once #219 is on the merge train.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "33333333-3333-4333-8333-333333333301";
const VERSION_ID = "44444444-4444-4444-8444-444444444401";
const SOURCE_ID = "55555555-5555-4555-8555-555555555501";
const WORKER_TOKEN = "synthetic-publish-credential-0001";

const LEAK_MARKERS = [WORKER_TOKEN, "http://", "https://", "eyJ"];

type FakePublishJob = {
  jobId: string;
  organisationId: string;
  sourceVersionId: string;
  stage: "publish";
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
  alreadyPublished: boolean;
};

function queuedPublish(overrides: Partial<FakePublishJob> = {}): FakePublishJob {
  return {
    jobId: JOB_ID,
    organisationId: ORG,
    sourceVersionId: VERSION_ID,
    stage: "publish",
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
    alreadyPublished: false,
    ...overrides,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

class FakePublishJobApi implements PublishJobApiPort {
  calls: string[] = [];
  presentedDigests: string[] = [];
  publishArgs: { sourceVersionId: string; indexGeneration: number }[] = [];
  credentialRevoked = false;
  clock: () => number = () => Date.now();
  refusePublish = false;
  parkForReview = false;

  constructor(readonly jobs: FakePublishJob[] = [queuedPublish()]) {}

  async lease(args: { credential: string; stage: "publish"; leaseSeconds: number }) {
    this.calls.push("lease");
    if (!(await this.credentialMatches(args.credential))) return null;
    if (args.stage !== "publish" || args.leaseSeconds < 60 || args.leaseSeconds > 1800) {
      return null;
    }
    const row = this.jobs.find(
      (job) =>
        job.status === "queued" || (job.status === "leased" && job.expiresAt <= this.clock()),
    );
    if (!row) return null;
    row.status = "leased";
    row.attempt += 1;
    row.fence += 1;
    row.leaseToken = `synthetic-publish-lease-${String(row.fence).padStart(2, "0")}`;
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
    return {
      outcome: "renewed" as const,
      expiresAt: new Date(row.expiresAt).toISOString(),
      fence: row.fence,
    };
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

  async publishVersion(args: {
    credential: string;
    jobId: string;
    leaseToken: string;
    fence: number;
    sourceVersionId: string;
    indexGeneration: number;
  }): Promise<PublishVersionOutcome> {
    this.calls.push("publishVersion");
    this.publishArgs.push({
      sourceVersionId: args.sourceVersionId,
      indexGeneration: args.indexGeneration,
    });
    const row = await this.present(args.credential);
    if (!row) return { outcome: "refused" };
    if (this.refusePublish) return { outcome: "refused" };
    if (this.parkForReview && this.holds(row, args)) {
      row.status = "succeeded";
      row.leaseToken = null;
      row.expiresAt = 0;
      return { outcome: "awaiting_review", sourceId: SOURCE_ID, sourceVersionId: row.sourceVersionId };
    }
    if (
      !this.holds(row, args) ||
      row.sourceVersionId !== args.sourceVersionId ||
      row.indexGeneration !== args.indexGeneration
    ) {
      if (row.alreadyPublished || row.status === "succeeded") {
        return {
          outcome: "already_published",
          sourceId: SOURCE_ID,
          sourceVersionId: row.sourceVersionId,
          previousVersionId: null,
        };
      }
      return { outcome: "refused" };
    }
    if (row.alreadyPublished) {
      row.status = "succeeded";
      row.leaseToken = null;
      row.expiresAt = 0;
      return {
        outcome: "already_published",
        sourceId: SOURCE_ID,
        sourceVersionId: row.sourceVersionId,
        previousVersionId: null,
      };
    }
    row.status = "succeeded";
    row.leaseToken = null;
    row.expiresAt = 0;
    return {
      outcome: "published",
      sourceId: SOURCE_ID,
      sourceVersionId: row.sourceVersionId,
      previousVersionId: null,
      publishedAt: new Date(this.clock()).toISOString(),
      eventId: "77777777-7777-4777-8777-777777777701",
    };
  }

  private async credentialMatches(credential: string): Promise<boolean> {
    this.presentedDigests.push(await sha256Hex(credential));
    return credential === WORKER_TOKEN && !this.credentialRevoked;
  }

  private async present(credential: string): Promise<FakePublishJob | null> {
    if (!(await this.credentialMatches(credential))) return null;
    return this.jobs[0] ?? null;
  }

  private holds(
    row: FakePublishJob,
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

function assertNoLeaks(events: PublishWorkerEvent[]) {
  const blob = JSON.stringify(events);
  for (const marker of LEAK_MARKERS) {
    expect(blob.includes(marker), `event log must not contain ${marker}`).toBe(false);
  }
}

describe("workers/publish-pull.ts — publish-stage consumer (T-113)", () => {
  it("fails closed with no credential and never dials the job API", async () => {
    const jobApi = new FakePublishJobApi();
    const events: PublishWorkerEvent[] = [];
    const outcome = await runPublishWorkerIteration(
      createPublishWorkerDeps({
        jobApi,
        credential: () => undefined,
        log: (e) => events.push(e),
      }),
    );
    expect(outcome).toEqual({ action: "credential_missing" });
    expect(jobApi.calls).toEqual([]);
    assertNoLeaks(events);
  });

  it("reports no_work when the publish queue is empty", async () => {
    const jobApi = new FakePublishJobApi([]);
    const outcome = await runPublishWorkerIteration(
      createPublishWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
      }),
    );
    expect(outcome).toEqual({ action: "no_work" });
    expect(jobApi.calls).toEqual(["lease"]);
  });

  it("leases stage=publish, validates the contract payload, and calls publishVersion", async () => {
    const jobApi = new FakePublishJobApi();
    const events: PublishWorkerEvent[] = [];
    const outcome = await runPublishWorkerIteration(
      createPublishWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        log: (e) => events.push(e),
      }),
    );
    expect(outcome).toEqual({ action: "published", sourceVersionId: VERSION_ID });
    expect(jobApi.calls).toEqual(["lease", "renew", "publishVersion"]);
    expect(jobApi.publishArgs[0]).toEqual({
      sourceVersionId: VERSION_ID,
      indexGeneration: 1,
    });
    expect(jobApi.presentedDigests[0]).toBe(await sha256Hex(WORKER_TOKEN));
    const leased = events.find((e) => e.kind === "leased");
    expect(leased?.kind).toBe("leased");
    if (leased?.kind === "leased") {
      const parsed = IngestionJobPayload.safeParse({
        jobId: leased.jobId,
        organisationId: ORG,
        sourceVersionId: VERSION_ID,
        stage: "publish",
        executor: "cloud_worker",
        dataClass: "internal",
        parserGeneration: "v1",
        indexGeneration: 1,
        attempt: 1,
        leaseToken: "synthetic-publish-lease-01",
        issuedAt: new Date().toISOString(),
      });
      expect(parsed.success).toBe(true);
    }
    assertNoLeaks(events);
  });

  it("treats already_published as a no-op success (at-least-once)", async () => {
    const jobApi = new FakePublishJobApi([queuedPublish({ alreadyPublished: true })]);
    const outcome = await runPublishWorkerIteration(
      createPublishWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
      }),
    );
    expect(outcome).toEqual({
      action: "already_published",
      sourceVersionId: VERSION_ID,
    });
    expect(jobApi.calls).toContain("publishVersion");
    expect(jobApi.calls).not.toContain("abort");
  });

  it("reports held_for_review, not published, when SQL parks the version for T-213 review (TOI-013)", async () => {
    const jobApi = new FakePublishJobApi();
    jobApi.parkForReview = true;
    const events: unknown[] = [];
    const outcome = await runPublishWorkerIteration(
      createPublishWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
        log: (event) => events.push(event),
      }),
    );
    expect(outcome).toEqual({ action: "held_for_review", sourceVersionId: VERSION_ID });
    expect(events).toContainEqual(expect.objectContaining({ kind: "held_for_review" }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "published" }));
    expect(jobApi.calls).not.toContain("abort");
  });

  it("aborts source_revoked when publishVersion refuses on a live lease", async () => {
    const jobApi = new FakePublishJobApi();
    jobApi.refusePublish = true;
    const outcome = await runPublishWorkerIteration(
      createPublishWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
      }),
    );
    expect(outcome).toEqual({ action: "aborted", reason: "source_revoked" });
    expect(jobApi.calls).toContain("abort");
    expect(jobApi.jobs[0]?.status).toBe("cancelled");
    expect(jobApi.jobs[0]?.lastError).toBe("source_revoked");
  });

  it("pull loop stops on no_work without spinning", async () => {
    const jobApi = new FakePublishJobApi([]);
    const outcomes = await runPublishWorkerPull(
      createPublishWorkerDeps({
        jobApi,
        credential: () => WORKER_TOKEN,
      }),
      { maxJobs: 4 },
    );
    expect(outcomes).toEqual([{ action: "no_work" }]);
    expect(jobApi.calls.filter((c) => c === "lease")).toHaveLength(1);
  });
});
