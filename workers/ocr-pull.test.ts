import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestionJobPayload, type JobExecutor } from "@/contracts/ingestion-job";
import type { DataClass } from "@/contracts/data-class";

import {
  createCloudWorkerDeps,
  createSignedByteReader,
  MAX_OBJECT_BYTES,
  runCloudWorkerIteration,
  runCloudWorkerPull,
  type ArtifactInput,
  type CloudWorkerDeps,
  type ExtractorPort,
  type IterationOutcome,
  type JobApiPort,
  type WorkerEvent,
} from "./ocr-pull";
import { createStorageUrlSigner, type ObjectUrlSigner } from "./object-signing";

/**
 * T-211's cloud-executor acceptance box (`docs/tasks/T-211-ocr-worker.md`, #135 and #146): the loop
 * binds no port, authenticates outbound, and reaches the object through a short-lived URL rather than
 * a key or a token carried inside the job message.
 *
 * A loopback harness per COORDINATION §6a: one `listen(0)` server on `127.0.0.1`, closed in
 * `afterAll`, standing in for **both** Storage legs (the sign endpoint and the object GET), so the
 * socket evidence covers the mint and the read. The job-API leg is the injected `JobApiPort`: the
 * deployment's adapter is the `JOB_DB` connection (PR-3), so that double is in-memory, and it keeps
 * the merged compare arms — credential digest, executor, lease token, fence, status, server-side
 * expiry, revoked version (`20261109230000_ocr_job_leases.sql:351-361`, `:722-768`).
 *
 * Everything here is synthetic and low-entropy. `LEAK_MARKERS` is the leak check: none of those
 * strings may appear in an event, an artifact note or an outbox payload.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const OBJECT_REF = "knowledge/syn-tenant-0001/syn-source-0001/v1";

const WORKER_TOKEN = "synthetic-cloud-credential-0001";
const SERVICE_KEY = "synthetic-service-key-not-a-secret";
const SIGN_TOKEN = "synthetic-signed-token-0001";

const LEAK_MARKERS = [WORKER_TOKEN, SERVICE_KEY, SIGN_TOKEN, "token=", "http://", "https://", OBJECT_REF];

/** Filled in by `beforeAll`, and read **at call time** exactly like a Worker secret binding. */
const ENV = {
  TOI_SUPABASE_URL: "",
  TOI_STORAGE_SERVICE_ROLE_KEY: SERVICE_KEY,
  TOI_STORAGE_BUCKET: "syn-bucket",
  TOI_WORKER_TOKEN: WORKER_TOKEN,
};

type SeenRequest = { method?: string; url?: string; authorization?: string | undefined; body: string };

let storageServer: Server;
const signCalls: SeenRequest[] = [];
const objectCalls: SeenRequest[] = [];
let signStatus = 200;
let objectStatus = 200;
let objectBody = "%PDF-1.4 synthetic scanned page stream";
let declaredLength: number | undefined;
let chunked = false;

beforeAll(async () => {
  storageServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";

    if (url.startsWith("/storage/v1/object/sign/") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        signCalls.push({
          method: req.method,
          url,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(signStatus, { "content-type": "application/json" });
        res.end(
          signStatus === 200
            ? JSON.stringify({ signedURL: `object/sign/syn-bucket/${OBJECT_REF}?token=${SIGN_TOKEN}` })
            : JSON.stringify({ error: "refused: this body names an origin and an object key" }),
        );
      });
      return;
    }

    // The GET leg. Storage's signed URL *is* an `/object/sign/...?token=` path, so the fake serves the
    // object there too, and refuses it without the token: the URL is the only credential on this leg.
    if (url.startsWith("/storage/v1/object/sign/")) {
      objectCalls.push({ method: req.method, url, authorization: req.headers.authorization, body: "" });
      const payload = new TextEncoder().encode(objectBody);
      if (!url.includes(`token=${SIGN_TOKEN}`)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (chunked) {
        // No content-length: the only way to prove the bound is by reading, which is the case a
        // `content-length` check cannot cover.
        res.writeHead(objectStatus, { "content-type": "application/octet-stream" });
        for (let offset = 0; offset < payload.byteLength; offset += 512) {
          res.write(payload.subarray(offset, offset + 512));
        }
        res.end();
        return;
      }
      res.writeHead(objectStatus, {
        "content-type": "application/octet-stream",
        "content-length": String(declaredLength ?? payload.byteLength),
      });
      res.end(payload);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => storageServer.listen(0, "127.0.0.1", resolve));
  ENV.TOI_SUPABASE_URL = `http://127.0.0.1:${(storageServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    storageServer.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  signCalls.length = 0;
  objectCalls.length = 0;
  signStatus = 200;
  objectStatus = 200;
  objectBody = "%PDF-1.4 synthetic scanned page stream";
  declaredLength = undefined;
  chunked = false;
});

// ── the job API double ──────────────────────────────────────────────────────────────────────────

type FakeJob = {
  jobId: string;
  organisationId: string;
  sourceVersionId: string;
  stage: "extract";
  executor: JobExecutor;
  parserGeneration: string;
  indexGeneration: number;
  dataClass: DataClass;
  status: "queued" | "leased" | "succeeded" | "cancelled";
  leaseToken: string | null;
  fence: number;
  attempt: number;
  expiresAt: number;
  lastError: string | null;
  objectRef: string;
};

function queuedJob(overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    jobId: JOB_ID,
    organisationId: ORG_A,
    sourceVersionId: VERSION_ID,
    stage: "extract",
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
    objectRef: OBJECT_REF,
    ...overrides,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The compare arms, kept because the behaviours the packet asks for are *properties of the compare*:
 * a stale fence matches nothing, a revoked credential matches nothing, a duplicate completion finds
 * the row already `succeeded` and writes nothing, and `object_ref_for_lease_v1` answers no row for a
 * revoked version and for an executor the version's class does not clear. pgTAP `045` (PR-1) is the
 * authority on the SQL side; this double exists so the loop's *reaction* is testable without Docker.
 */
class FakeJobApi implements JobApiPort {
  artifactRows: { jobId: string; fence: number; producer: JobExecutor; notes: unknown }[] = [];
  outbox: { eventType: string; payload: string }[] = [];
  calls: string[] = [];
  presentedDigests: string[] = [];
  credentialRevoked = false;
  sourceRevoked = false;
  clock: () => number = () => Date.now();

  constructor(readonly jobs: FakeJob[] = [queuedJob()]) {}

  async lease(args: { credential: string; stage: string; leaseSeconds: number }) {
    this.calls.push("lease");
    if (!(await this.credentialMatches(args.credential))) return null;
    if (args.stage !== "extract" || args.leaseSeconds < 60 || args.leaseSeconds > 1800) return null;
    const row = this.jobs.find(
      (job) =>
        job.executor === "cloud_worker" &&
        job.attempt < 5 &&
        (job.status === "queued" || (job.status === "leased" && job.expiresAt <= this.clock())),
    );
    if (!row) return null;
    row.status = "leased";
    row.attempt += 1;
    row.fence += 1;
    row.leaseToken = `synthetic-lease-token-${String(row.fence).padStart(2, "0")}`;
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
    };
  }

  async renew(args: { credential: string; jobId: string; leaseToken: string; fence: number; leaseSeconds: number }) {
    this.calls.push("renew");
    const row = await this.present(args.credential);
    if (!row || !this.holds(row, args)) return { outcome: "refused" as const };
    row.expiresAt = this.clock() + args.leaseSeconds * 1000;
    return { outcome: "renewed" as const, expiresAt: new Date(row.expiresAt).toISOString(), fence: row.fence };
  }

  async objectRefForLease(args: { credential: string; jobId: string; leaseToken: string; fence: number }) {
    this.calls.push("objectRefForLease");
    const row = await this.present(args.credential);
    if (!row || !this.holds(row, args)) return { found: false as const };
    if (this.sourceRevoked) return { found: false as const };
    // `job_api.executor_clears_class` (#135, ADR-0005 §10c): cloud_worker clears public and internal.
    if (row.executor === "cloud_worker" && row.dataClass === "client_confidential") return { found: false as const };
    return { found: true as const, objectRef: row.objectRef, dataClass: row.dataClass, executor: row.executor };
  }

  async complete(args: {
    credential: string;
    jobId: string;
    leaseToken: string;
    fence: number;
    sourceVersionId: string;
    stage: string;
    indexGeneration: number;
    artifacts: readonly ArtifactInput[];
    notes: readonly string[];
    confidence: number | null;
  }) {
    this.calls.push("complete");
    const row = await this.present(args.credential);
    if (!row) return { outcome: "refused" as const };
    const lostLease = !this.holds(row, args);
    if (
      lostLease ||
      row.sourceVersionId !== args.sourceVersionId ||
      row.stage !== args.stage ||
      row.indexGeneration !== args.indexGeneration ||
      this.sourceRevoked
    ) {
      // Zero rows and the row already succeeded is the duplicate delivery: it writes nothing (#7.5).
      if (row.status === "succeeded") {
        return {
          outcome: "already_completed" as const,
          artifactCount: this.artifactRows.filter((artifact) => artifact.jobId === row.jobId).length,
        };
      }
      return { outcome: "refused" } as const;
    }
    row.status = "succeeded";
    row.leaseToken = null;
    row.expiresAt = 0;
    for (const artifact of args.artifacts) {
      this.artifactRows.push({
        jobId: row.jobId,
        fence: row.fence,
        producer: row.executor,
        notes: artifact.notes ?? args.notes,
      });
    }
    this.outbox.push({
      eventType: "knowledge.ingestion_job.extract_succeeded",
      payload: JSON.stringify({ job_id: row.jobId, artifacts: args.artifacts.length, executor: row.executor }),
    });
    return { outcome: "completed" as const, artifactCount: args.artifacts.length };
  }

  async abort(args: { credential: string; jobId: string; leaseToken: string; fence: number; reason: string }) {
    this.calls.push("abort");
    const row = await this.present(args.credential);
    if (!row || !this.holds(row, args)) return { outcome: "refused" as const };
    row.status = "cancelled";
    row.lastError = args.reason;
    row.leaseToken = null;
    row.expiresAt = 0;
    // The merged abort clears the partial output of a *different* fence; this fence wrote nothing.
    this.artifactRows = this.artifactRows.filter((artifact) => artifact.fence === args.fence);
    return { outcome: "aborted" as const };
  }

  async retarget(args: { credential: string; jobId: string; leaseToken: string; fence: number; reason: string }) {
    this.calls.push("retarget");
    const row = await this.present(args.credential);
    if (!row || !this.holds(row, args) || row.executor !== "cloud_worker") return { outcome: "refused" as const };
    row.executor = "local_box";
    row.status = "queued";
    row.leaseToken = null;
    row.expiresAt = 0;
    row.fence += 1; // #99: the abandoned holder must match zero rows afterwards.
    row.lastError = args.reason;
    return { outcome: "retargeted" as const };
  }

  /** The credential arm: the API side matches the **digest**, and a revoked row matches nothing. */
  private async credentialMatches(credential: string): Promise<boolean> {
    this.presentedDigests.push(await sha256Hex(credential));
    return credential === WORKER_TOKEN && !this.credentialRevoked;
  }

  private async present(credential: string): Promise<FakeJob | null> {
    if (!(await this.credentialMatches(credential))) return null;
    return this.jobs[0] ?? null;
  }

  private holds(row: FakeJob, args: { jobId: string; leaseToken: string; fence: number }): boolean {
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

// ── the extractor port: T-212 is not merged, and this is the whole of what the loop assumes ──────

const ONE_ARTIFACT: ArtifactInput[] = [
  { artifactIndex: 0, bodyText: "synthetic extracted text", locator: { page: 1 }, confidence: 0.91 },
];

function extractorReturning(result: Awaited<ReturnType<ExtractorPort["extract"]>>, seen: object[] = []): ExtractorPort {
  return {
    async extract(input) {
      seen.push(input);
      return result;
    },
  };
}

function depsOf(options: {
  jobApi: JobApiPort;
  extractor?: ExtractorPort;
  credential?: () => string | undefined;
  log?: (event: WorkerEvent) => void;
  leaseSeconds?: number;
  maxObjectBytes?: number;
}): CloudWorkerDeps {
  return createCloudWorkerDeps({
    env: ENV,
    extractor: options.extractor ?? extractorReturning({ outcome: "extracted", artifacts: ONE_ARTIFACT }),
    ...options,
  });
}

describe("workers/ocr-pull.ts — the cloud executor (#135, ADR-0011)", () => {
  it("binds no port: the loop and the box contain no listener at all (F32)", () => {
    // The runtime half of the claim is the harness below: every socket this loop touched was one it
    // dialled outbound. This half is static, the same shape as the boundary test: no listener API
    // exists in the file to begin with.
    for (const file of ["workers/ocr-pull.ts", "localbox/ocr-pull.ts"]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, `${file} must not create a listener`).not.toMatch(/createServer|\.listen\s*\(|createHttpServer|serve\s*\(/);
      expect(source, `${file} must not import a server or socket module`).not.toMatch(/from\s+["']node:(http|https|net|tls|dns|worker_threads)["']/);
    }
    // And no loop or signer names a platform host. The merged resolver classifies **every** other name
    // under the platform domain as a tenant (`src/platform/tenancy/host.ts:51-55`), so a hostname baked
    // into this code is infrastructure invented in a fallback — the base URL is deployment
    // configuration, and T-004 §20.8 is who owns the routes.
    for (const file of ["workers/ocr-pull.ts", "workers/object-signing.ts", "localbox/ocr-pull.ts"]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, `${file} must not name a platform host`).not.toMatch(/terraoi\.app/);
    }
  });

  it("sends nothing at all when the deployment holds no credential", async () => {
    const jobApi = new FakeJobApi();
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi, credential: () => undefined }));
    expect(outcome).toEqual({ action: "credential_missing" });
    expect(jobApi.calls).toEqual([]);
    expect(signCalls).toHaveLength(0);
    expect(objectCalls).toHaveLength(0);
  });

  it("authenticates outbound with the credential, and the job API side matches its digest", async () => {
    const jobApi = new FakeJobApi();
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(outcome.action).toBe("completed");
    expect(jobApi.presentedDigests.length).toBeGreaterThan(0);
    for (const digest of jobApi.presentedDigests) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(jobApi.presentedDigests[0]).toBe(await sha256Hex(WORKER_TOKEN));
  });

  it("the job message the extractor sees is a contract payload: strict, and no key, URL or Storage token in it", async () => {
    const jobApi = new FakeJobApi();
    const seen: object[] = [];
    const deps = depsOf({ jobApi, extractor: extractorReturning({ outcome: "extracted", artifacts: ONE_ARTIFACT }, seen) });
    await runCloudWorkerIteration(deps);

    const payload = (seen[0] as { payload: unknown }).payload;
    const parsed = IngestionJobPayload.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    // `.strict()` is the guard ADR-0011 leans on: an object key or a URL in the message is a contract
    // violation, so this list is exactly the contract's own keys and nothing else.
    expect(Object.keys(payload as object).sort()).toEqual([
      "attempt",
      "dataClass",
      "executor",
      "indexGeneration",
      "issuedAt",
      "jobId",
      "leaseToken",
      "organisationId",
      "parserGeneration",
      "sourceVersionId",
      "stage",
    ]);
  });

  it("signs the key SQL named for this lease and reads the bytes over a real socket", async () => {
    const jobApi = new FakeJobApi();
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(outcome.action).toBe("completed");

    expect(signCalls).toHaveLength(1);
    expect(signCalls[0]!.method).toBe("POST");
    expect(signCalls[0]!.url).toBe(`/storage/v1/object/sign/syn-bucket/${OBJECT_REF}`);
    expect(signCalls[0]!.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect((JSON.parse(signCalls[0]!.body) as { expiresIn?: number }).expiresIn).toBe(60);

    expect(objectCalls).toHaveLength(1);
    expect(objectCalls[0]!.method).toBe("GET");
    // Storage's signed URL is itself an `/object/sign/...?token=` download path: the token, not a
    // header, is what authenticates this leg.
    expect(objectCalls[0]!.url).toBe(`/storage/v1/object/sign/syn-bucket/${OBJECT_REF}?token=${SIGN_TOKEN}`);
    // Neither the worker credential nor the service-role key rides along on the byte GET.
    expect(objectCalls[0]!.authorization).toBeUndefined();

    expect(jobApi.artifactRows).toHaveLength(1);
    expect(jobApi.outbox).toHaveLength(1);
    const written = JSON.stringify(jobApi.artifactRows) + JSON.stringify(jobApi.outbox);
    expect(written, "a signed URL is never stored").not.toContain(SIGN_TOKEN);
    expect(written, "the object key is not an outbox field").not.toContain(OBJECT_REF);
  });

  it("maps Storage answers onto the bounded-read statuses, and refuses before the socket", async () => {
    const signer = createStorageUrlSigner(ENV);
    const reader = createSignedByteReader({ signer });

    objectStatus = 404;
    expect(await reader(OBJECT_REF, 10_000)).toEqual({ status: "missing" });

    objectStatus = 503;
    expect(await reader(OBJECT_REF, 10_000)).toEqual({ status: "unavailable", reason: "http_error" });

    objectStatus = 200;
    declaredLength = 5_000;
    expect(await reader(OBJECT_REF, 1_000)).toEqual({ status: "oversize", sizeBytes: 5_000 });

    const refusing: ObjectUrlSigner = async () => ({ status: "unavailable", reason: "not_configured" });
    expect(await createSignedByteReader({ signer: refusing })(OBJECT_REF, 1_000)).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });

    signStatus = 500;
    expect(await createSignedByteReader({ signer })(OBJECT_REF, 10_000)).toEqual({
      status: "unavailable",
      reason: "server_error",
    });
    // Exactly three GETs crossed the socket above, and a refused mint never opens one.
    expect(objectCalls).toHaveLength(3);
  });

  it("refuses an object over the bound without buffering it, and aborts with a named reason", async () => {
    const jobApi = new FakeJobApi();
    declaredLength = MAX_OBJECT_BYTES + 1;
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(outcome).toEqual({ action: "aborted", reason: "unsupported_document" });
    expect(objectCalls).toHaveLength(1);
    expect(jobApi.artifactRows).toHaveLength(0);
    expect(jobApi.jobs[0]!.lastError).toBe("unsupported_document");
  });

  it("a stream that outgrows the bound is cut off rather than swallowed", async () => {
    const jobApi = new FakeJobApi();
    chunked = true;
    objectBody = "x".repeat(8192);
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi, maxObjectBytes: 1024 }));
    expect(outcome).toEqual({ action: "aborted", reason: "unsupported_document" });
    expect(jobApi.artifactRows).toHaveLength(0);
  });

  it("a Storage outage does not cancel the job: the lease is dropped, not dead-lettered", async () => {
    const jobApi = new FakeJobApi();
    objectStatus = 503;
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(outcome).toEqual({ action: "storage_unavailable", reason: "http_error" });
    expect(jobApi.calls).not.toContain("abort");
    expect(jobApi.calls).not.toContain("complete");
    expect(jobApi.jobs[0]!.status).toBe("leased");
    expect(jobApi.artifactRows).toHaveLength(0);
  });

  it("a scan with no usable text layer retargets to the box, one way, with the fence bumped", async () => {
    const jobApi = new FakeJobApi();
    const outcome = await runCloudWorkerIteration(
      depsOf({ jobApi, extractor: extractorReturning({ outcome: "needs_local_box", reason: "no_text_layer" }) }),
    );
    expect(outcome).toEqual({ action: "retargeted", reason: "no_text_layer" });
    const row = jobApi.jobs[0]!;
    expect(row.executor).toBe("local_box");
    expect(row.status).toBe("queued");
    expect(row.leaseToken).toBeNull();
    expect(row.fence).toBe(2);
    expect(row.lastError).toBe("no_text_layer");
    expect(jobApi.artifactRows).toHaveLength(0);
  });

  it("never processes a local_box job: the executors are separate credentials with separate clearance (#135)", async () => {
    const jobApi = new FakeJobApi([queuedJob({ executor: "local_box" })]);
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(outcome).toEqual({ action: "no_work" });
    expect(jobApi.calls).not.toContain("complete");
    expect(signCalls).toHaveLength(0);
  });

  it("a completion that lost its lease mid-extraction is discarded, and the pull stops instead of retrying", async () => {
    const jobApi = new FakeJobApi();
    const extractor: ExtractorPort = {
      async extract() {
        // Partitioned holder: from here on the server-side expiry arm refuses everything it is told.
        jobApi.clock = () => Date.now() + 600_000;
        return { outcome: "extracted", artifacts: ONE_ARTIFACT };
      },
    };
    const outcomes = await runCloudWorkerPull(depsOf({ jobApi, extractor, leaseSeconds: 60 }), { maxJobs: 4 });
    expect(outcomes.map((outcome) => outcome.action)).toEqual(["lease_lost"]);
    expect(jobApi.calls.filter((call) => call === "lease")).toHaveLength(1);
    expect(jobApi.calls).toContain("renew");
    expect(jobApi.calls).not.toContain("complete");
    expect(jobApi.artifactRows).toHaveLength(0);
    expect(jobApi.outbox).toHaveLength(0);
    // The row stays for #99's inline reclaim to hand to a fresh holder at the next lease call.
    expect(jobApi.jobs[0]!.status).toBe("leased");
  });

  it("a late completion from a holder whose lease was reclaimed matches zero rows and writes nothing", async () => {
    const jobApi = new FakeJobApi();
    const held = await jobApi.lease({ credential: WORKER_TOKEN, stage: "extract", leaseSeconds: 600 });
    const row = jobApi.jobs[0]!;
    // A reclaim bumped the fence and a fresh holder got a new token: both arms now refuse the late one.
    row.fence += 1;
    row.leaseToken = "synthetic-lease-token-02";
    const late = await jobApi.complete({
      credential: WORKER_TOKEN,
      jobId: row.jobId,
      leaseToken: held!.leaseToken,
      fence: held!.fence,
      sourceVersionId: row.sourceVersionId,
      stage: "extract",
      indexGeneration: row.indexGeneration,
      artifacts: ONE_ARTIFACT,
      notes: [],
      confidence: null,
    });
    expect(late.outcome).toBe("refused");
    expect(jobApi.artifactRows).toHaveLength(0);
    expect(jobApi.outbox).toHaveLength(0);
  });

  it("the same completion delivered twice is a no-op: one artifact set, one outbox event", async () => {
    const jobApi = new FakeJobApi();
    const first = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(first.action).toBe("completed");
    const row = jobApi.jobs[0]!;
    const replay = await jobApi.complete({
      credential: WORKER_TOKEN,
      jobId: row.jobId,
      leaseToken: "synthetic-lease-token-01",
      fence: row.fence,
      sourceVersionId: row.sourceVersionId,
      stage: "extract",
      indexGeneration: row.indexGeneration,
      artifacts: ONE_ARTIFACT,
      notes: [],
      confidence: null,
    });
    expect(replay.outcome).toBe("already_completed");
    expect(jobApi.artifactRows).toHaveLength(1);
    expect(jobApi.outbox).toHaveLength(1);
  });

  it("a source revoked mid-job stops the run: no artifact, and the job aborts with source_revoked", async () => {
    const jobApi = new FakeJobApi();
    const extractor: ExtractorPort = {
      async extract() {
        jobApi.sourceRevoked = true;
        return { outcome: "extracted", artifacts: ONE_ARTIFACT };
      },
    };
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi, extractor }));
    expect(outcome).toEqual({ action: "aborted", reason: "source_revoked" });
    expect(jobApi.artifactRows).toHaveLength(0);
    expect(jobApi.outbox).toHaveLength(0);
    expect(jobApi.calls.filter((call) => call === "abort")).toEqual(["abort"]);
    expect(jobApi.jobs[0]!.status).toBe("cancelled");
    expect(jobApi.jobs[0]!.lastError).toBe("source_revoked");
  });

  it("a revoked credential leaves the loop with no work and no Storage call", async () => {
    const jobApi = new FakeJobApi();
    jobApi.credentialRevoked = true;
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(outcome.action).toBe("no_work");
    expect(jobApi.calls).toEqual(["lease"]);
    expect(signCalls).toHaveLength(0);
  });

  it("an object this executor may not see is refused under the lease, and the job is not retried in place", async () => {
    const jobApi = new FakeJobApi([queuedJob({ dataClass: "client_confidential" })]);
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi }));
    expect(outcome).toEqual({ action: "aborted", reason: "object_missing" });
    expect(signCalls).toHaveLength(0);
    expect(objectCalls).toHaveLength(0);
    expect(jobApi.artifactRows).toHaveLength(0);
  });

  it("an artifact set the artifact home would refuse never reaches the write", async () => {
    const tooManyRows: ArtifactInput[] = Array.from({ length: 2001 }, (_unused, index) => ({
      artifactIndex: index,
      bodyText: "synthetic",
    }));
    const first = new FakeJobApi();
    expect(
      await runCloudWorkerIteration(
        depsOf({ jobApi: first, extractor: extractorReturning({ outcome: "extracted", artifacts: tooManyRows }) }),
      ),
    ).toEqual({ action: "aborted", reason: "quality_failed" });
    expect(first.calls).not.toContain("complete");

    const duplicateIndex: ArtifactInput[] = [
      { artifactIndex: 0, bodyText: "one" },
      { artifactIndex: 0, bodyText: "two" },
    ];
    const second = new FakeJobApi();
    expect(
      await runCloudWorkerIteration(
        depsOf({ jobApi: second, extractor: extractorReturning({ outcome: "extracted", artifacts: duplicateIndex }) }),
      ),
    ).toEqual({ action: "aborted", reason: "quality_failed" });

    // The merged guard refuses a `notes` key inside a locator, and document words do not belong in a
    // locator either (AGENTS §4.8).
    const notesInLocator: ArtifactInput[] = [{ artifactIndex: 0, bodyText: "one", locator: { notes: ["document words"] } }];
    const third = new FakeJobApi();
    expect(
      await runCloudWorkerIteration(
        depsOf({ jobApi: third, extractor: extractorReturning({ outcome: "extracted", artifacts: notesInLocator }) }),
      ),
    ).toEqual({ action: "aborted", reason: "quality_failed" });

    for (const jobApi of [first, second, third]) expect(jobApi.artifactRows).toHaveLength(0);
  });

  it("never emits the credential, the service key, a signed URL or the object key into an event", async () => {
    const jobApi = new FakeJobApi();
    const events: WorkerEvent[] = [];
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi, log: (event) => events.push(event) }));
    expect(outcome.action).toBe("completed");
    expect(events.length).toBeGreaterThan(0);
    const line = events.map((event) => JSON.stringify(event)).join("\n");
    for (const marker of LEAK_MARKERS) {
      expect(line, `an event carried ${JSON.stringify(marker)}`).not.toContain(marker);
    }
    // The union has no free-text field at all: every string besides a kind or an id is a named code.
    for (const event of events) {
      for (const [key, value] of Object.entries(event)) {
        if (typeof value !== "string") continue;
        if (key === "kind" || key === "jobId") continue;
        expect(value, `event field ${key}`).toMatch(/^[a-z0-9_]{1,64}$/);
      }
    }
  });

  it("never touches console: the loop has no way to log a URL by accident", async () => {
    const jobApi = new FakeJobApi();
    const logs = vi.spyOn(console, "log");
    const warns = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");
    const outcome = await runCloudWorkerIteration(depsOf({ jobApi, log: () => undefined }));
    expect(outcome.action).toBe("completed");
    expect(logs).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("pulls until the queue is empty", async () => {
    const jobApi = new FakeJobApi([queuedJob()]);
    const outcomes: IterationOutcome[] = await runCloudWorkerPull(depsOf({ jobApi }), { maxJobs: 4 });
    expect(outcomes.map((outcome) => outcome.action)).toEqual(["completed", "no_work"]);
  });
});
