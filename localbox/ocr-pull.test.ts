import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBoxWorkerDeps,
  JobApiTransportError,
  MAX_OBJECT_BYTES,
  runBoxPullIteration,
  runBoxPullLoop,
  type ArtifactInput,
  type BoxEvent,
  type BoxExtractorPort,
  type BoxWorkerDeps,
} from "./ocr-pull";

/**
 * The tenant box (plan §13 "OCR/parsing worker", F32; #135, ADR-0011 Decision 5).
 *
 * A loopback harness per COORDINATION §6a, and the claims it exists to prove are wire claims:
 *
 * * the box's worker credential travels **outbound only**, to the job API, and now;
 * * the box receives a short-lived **URL**, never an object key and never a token inside the job
 *   message, and it is the URL — not the credential — that authenticates the byte GET;
 * * the credential never rides to the object, and the URL and the key never appear in an event, an
 *   artifact note or a log line, because the box sits inside a customer's network.
 *
 * Two listeners, both `127.0.0.1` with `listen(0)`, both closed in `afterAll`: one stands in for the
 * job API (the extraction deployment, over the tunnel) and one for the object itself. They are
 * **separate origins on purpose** — the box is required to notice a deployment that streams document
 * bytes through its own job API, which ADR-0011 rejected.
 */

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const OBJECT_REF = "knowledge/syn-tenant-0001/syn-source-0001/v1";

const WORKER_TOKEN = "synthetic-box-credential-0001";
const URL_TOKEN = "synthetic-signed-token-0001";

const LEAK_MARKERS = [WORKER_TOKEN, URL_TOKEN, OBJECT_REF, "http://", "https://", "token="];

type Stub = { status?: number; body?: unknown };
type SeenRequest = { path: string; method?: string; authorization?: string | undefined; body: Record<string, unknown> };

let jobApiServer: Server;
let objectServer: Server;
let jobApiOrigin = "";
let objectOrigin = "";

const seenJobApiCalls: SeenRequest[] = [];
const seenObjectCalls: SeenRequest[] = [];
let stubs: Record<string, Stub> = {};
let objectStatus = 200;
let objectBody = "synthetic scanned page bytes";

function leaseStub(overrides: Record<string, unknown> = {}): Stub {
  return {
    status: 200,
    body: {
      found: true,
      jobId: JOB_ID,
      organisationId: ORG_A,
      sourceVersionId: VERSION_ID,
      stage: "extract",
      executor: "local_box",
      parserGeneration: "v1",
      indexGeneration: 1,
      dataClass: "client_confidential",
      leaseToken: "synthetic-lease-token-01",
      fence: 1,
      attempt: 1,
      ...overrides,
    },
  };
}

function urlStub(): Stub {
  return { status: 200, body: { found: true, url: `${objectOrigin}/bytes/${OBJECT_REF}?token=${URL_TOKEN}`, expiresInSeconds: 60 } };
}

function resetStubs(): void {
  stubs = {
    "/jobs/lease": leaseStub(),
    "/jobs/renew": { status: 200, body: { outcome: "renewed", expiresAt: new Date(Date.now() + 60_000).toISOString(), fence: 1 } },
    "/jobs/object-url": urlStub(),
    "/jobs/complete": { status: 200, body: { outcome: "completed", artifactCount: 1 } },
    "/jobs/abort": { status: 200, body: { outcome: "aborted" } },
  };
  seenJobApiCalls.length = 0;
  seenObjectCalls.length = 0;
  objectStatus = 200;
  objectBody = "synthetic scanned page bytes";
}

beforeAll(async () => {
  jobApiServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      seenJobApiCalls.push({ path, method: req.method, authorization: req.headers.authorization, body });
      const stub = stubs[path] ?? { status: 404, body: { error: "no stub for this path" } };
      res.writeHead(stub.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(stub.body ?? {}));
    });
  });

  objectServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    seenObjectCalls.push({ path, method: req.method, authorization: req.headers.authorization, body: {} });
    if (!path.includes(`token=${URL_TOKEN}`)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const payload = new TextEncoder().encode(objectBody);
    res.writeHead(objectStatus, {
      "content-type": "application/octet-stream",
      "content-length": String(payload.byteLength),
    });
    res.end(payload);
  });

  await new Promise<void>((resolve) => jobApiServer.listen(0, "127.0.0.1", resolve));
  jobApiOrigin = `http://127.0.0.1:${(jobApiServer.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => objectServer.listen(0, "127.0.0.1", resolve));
  objectOrigin = `http://127.0.0.1:${(objectServer.address() as AddressInfo).port}`;
  resetStubs();
});

afterAll(async () => {
  const close = (server: Server) =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await close(jobApiServer);
  await close(objectServer);
});

beforeEach(() => resetStubs());

// ── the extractor port: same shape as the cloud loop's, minus the door the box may not open ───────

const ONE_ARTIFACT: ArtifactInput[] = [
  { artifactIndex: 0, bodyText: "synthetic OCR text with page locator", locator: { page: 1 }, confidence: 0.84 },
];

function depsOf(options: {
  extractor?: BoxExtractorPort;
  credential?: () => string | undefined;
  log?: (event: BoxEvent) => void;
  baseUrl?: string;
  maxObjectBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  maxIterations?: number;
} = {}): BoxWorkerDeps {
  return createBoxWorkerDeps({
    env: {
      TOI_JOB_API_BASE_URL: options.baseUrl ?? jobApiOrigin,
      TOI_WORKER_TOKEN: WORKER_TOKEN,
    },
    extractor: options.extractor ?? {
      async extract() {
        return { outcome: "extracted", artifacts: ONE_ARTIFACT };
      },
    },
    ...(options.credential === undefined ? {} : { credential: options.credential }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
  });
}

const HOLDER = { jobId: JOB_ID, leaseToken: "synthetic-lease-token-01", fence: 1 };

describe("localbox/ocr-pull.ts — the tenant box (plan §13, F32, ADR-0011)", () => {
  it("has no port to bind, no key to hold and no door to retarget (F32)", () => {
    const source = readFileSync(new URL("./ocr-pull.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createServer|\.listen\s*\(|createHttpServer|serve\s*\(/);
    expect(source).not.toMatch(/from\s+["']node:(http|https|net|tls|dns|worker_threads|fs|os)["']/);
    // ADR-0011: no storage credential and no minting on the box, ever.
    expect(source).not.toMatch(/SERVICE_ROLE|createSignedUrl|object\/sign/);
    // #134: the box never retargets; the port does not even name the call.
    expect(source).not.toMatch(/retarget/i);
    // Plan §13: a processor, not a store — nothing is written to disk.
    expect(source).not.toMatch(/writeFile|appendFile|mkdir|createWriteStream/);
  });

  it("never asks for a job it is not allowed to run: stage extract, lease seconds in range", async () => {
    const outcome = await runBoxPullIteration(depsOf());
    expect(outcome.action).toBe("completed");
    const lease = seenJobApiCalls.find((call) => call.path === "/jobs/lease")!;
    expect(lease.method).toBe("POST");
    expect(lease.body["stage"]).toBe("extract");
    expect(Number(lease.body["leaseSeconds"])).toBeGreaterThanOrEqual(60);
    expect(Number(lease.body["leaseSeconds"])).toBeLessThanOrEqual(1800);
    // No tenant id, no org id, no object ref travels in the request (AGENTS §4.1).
    expect(lease.body["organisationId"]).toBeUndefined();
    expect(lease.body["objectRef"]).toBeUndefined();
    for (const call of seenJobApiCalls) expect(JSON.stringify(call.body)).not.toContain(OBJECT_REF);
  });

  it("presents its worker credential outbound to the job API, and only there", async () => {
    const outcome = await runBoxPullIteration(depsOf());
    expect(outcome.action).toBe("completed");
    expect(seenJobApiCalls.length).toBeGreaterThan(0);
    for (const call of seenJobApiCalls) {
      expect(call.authorization, `${call.path} must authenticate outbound`).toBe(`Bearer ${WORKER_TOKEN}`);
    }
    // The object leg is authenticated by the signed URL, never by the credential.
    expect(seenObjectCalls).toHaveLength(1);
    expect(seenObjectCalls[0]!.method).toBe("GET");
    expect(seenObjectCalls[0]!.authorization).toBeUndefined();
    expect(seenObjectCalls[0]!.path).toContain(`token=${URL_TOKEN}`);
  });

  it("receives a URL rather than a key or a token inside the job message", async () => {
    const seen: object[] = [];
    const extractor: BoxExtractorPort = {
      async extract(input) {
        seen.push(input);
        return { outcome: "extracted", artifacts: ONE_ARTIFACT };
      },
    };
    const outcome = await runBoxPullIteration(depsOf({ extractor }));
    expect(outcome.action).toBe("completed");

    const leaseCall = seenJobApiCalls.find((call) => call.path === "/jobs/lease")!;
    // The job message the box works from has no key and no URL: those keys are not in the shape the
    // client reads, and the contract's own `.strict()` shape is what the cloud test pins.
    const leaseBody = JSON.stringify(leaseCall.body);
    expect(leaseBody).not.toContain("token=");
    const input = seen[0] as { payload: Record<string, unknown>; url: string };
    expect(input.payload["objectRef"]).toBeUndefined();
    expect(input.payload["signedUrl"]).toBeUndefined();
    expect(JSON.stringify(input.payload)).not.toContain(OBJECT_REF);
    // The URL is a separate, short-lived hand-off.
    expect(input.url.startsWith(objectOrigin)).toBe(true);
    expect(JSON.stringify(input.payload)).not.toContain("http");
  });

  it("refuses a job API that streams the bytes through itself (ADR-0011 rejected that)", async () => {
    stubs["/jobs/object-url"] = {
      status: 200,
      body: { found: true, url: `${jobApiOrigin}/bytes/${OBJECT_REF}?token=${URL_TOKEN}`, expiresInSeconds: 60 },
    };
    const events: BoxEvent[] = [];
    const outcome = await runBoxPullIteration(depsOf({ log: (event) => events.push(event) }));
    expect(outcome.action).toBe("object_unavailable");
    expect(seenObjectCalls).toHaveLength(0);
    expect(events.some((event) => event.kind === "object_url_refused")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(URL_TOKEN);
    expect(JSON.stringify(events)).not.toContain(OBJECT_REF);
  });

  it("refuses a URL that is not a plain https-or-loopback GET target", async () => {
    for (const bad of [
      `${objectOrigin.replace("http://", "http://user:pass@")}/bytes/x?token=t`,
      "ftp://example.invalid/object",
      "not-a-url",
      `file:///tmp/${OBJECT_REF}`,
    ]) {
      stubs["/jobs/object-url"] = { status: 200, body: { found: true, url: bad, expiresInSeconds: 60 } };
      const events: BoxEvent[] = [];
      const outcome = await runBoxPullIteration(depsOf({ log: (event) => events.push(event) }));
      expect(outcome.action, `${bad} must be refused`).toBe("object_unavailable");
      expect(JSON.stringify(events)).not.toContain(bad);
    }
    expect(seenObjectCalls).toHaveLength(0);
  });

  it("refuses a URL whose claimed lifetime outlives the lease that produced it", async () => {
    stubs["/jobs/object-url"] = { status: 200, body: { found: true, url: `${objectOrigin}/bytes/x?token=${URL_TOKEN}`, expiresInSeconds: 4000 } };
    expect((await runBoxPullIteration(depsOf())).action).toBe("object_unavailable");
    expect(seenObjectCalls).toHaveLength(0);
  });

  it("a cloud_worker row is never touched by the box: the executors are separate credentials (#135)", async () => {
    stubs["/jobs/lease"] = leaseStub({ executor: "cloud_worker" });
    const outcome = await runBoxPullIteration(depsOf());
    expect(outcome.action).toBe("lease_row_rejected");
    expect(seenJobApiCalls.map((call) => call.path)).toEqual(["/jobs/lease"]);
    expect(seenObjectCalls).toHaveLength(0);
  });

  it("refuses a lease row that is not a contract message, and sends nothing else", async () => {
    stubs["/jobs/lease"] = leaseStub({ dataClass: "restricted" });
    const outcome = await runBoxPullIteration(depsOf());
    expect(outcome.action).toBe("lease_row_rejected");
    expect(seenJobApiCalls.map((call) => call.path)).toEqual(["/jobs/lease"]);
  });

  it("a revoked credential stops the loop after one call instead of hammering the job API", async () => {
    stubs["/jobs/lease"] = { status: 401, body: { error: "this body is never echoed" } };
    const outcomes = await runBoxPullLoop(depsOf(), {
      maxIterations: 5,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    expect(outcomes.map((outcome) => outcome.action)).toEqual(["credential_refused"]);
    expect(seenJobApiCalls).toHaveLength(1);
    const events: BoxEvent[] = [];
    // A transport failure names its kind and echoes nothing: the server body does not travel.
    stubs["/jobs/renew"] = { status: 401, body: { error: "an internal host and a pool name" } };
    const deps = depsOf({ log: (event) => events.push(event) });
    await expect(deps.jobApi.renew({ credential: WORKER_TOKEN, ...HOLDER, leaseSeconds: 60 })).rejects.toBeInstanceOf(JobApiTransportError);
    stubs["/jobs/renew"] = { status: 503, body: { message: "an internal host and a pool name" } };
    const error = await deps.jobApi.renew({ credential: WORKER_TOKEN, ...HOLDER, leaseSeconds: 60 }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JobApiTransportError);
    expect((error as JobApiTransportError).kind).toBe("unavailable");
    expect((error as JobApiTransportError).message).not.toContain("pool");
    expect(JSON.stringify(events)).not.toContain("pool");
  });

  it("an expired lease discards the box's completion instead of retrying it", async () => {
    stubs["/jobs/renew"] = { status: 200, body: { outcome: "refused" } };
    const outcomes = await runBoxPullLoop(depsOf(), { maxIterations: 4, pollIntervalMs: 0, sleep: async () => undefined });
    expect(outcomes.map((outcome) => outcome.action)).toEqual(["lease_lost"]);
    expect(seenJobApiCalls.map((call) => call.path)).toEqual(["/jobs/lease", "/jobs/object-url", "/jobs/renew"]);
    expect(seenJobApiCalls.some((call) => call.path === "/jobs/complete")).toBe(false);
    expect(seenObjectCalls).toHaveLength(1);
  });

  it("the object is refused under a live lease: the job aborts with a named reason, not a retry", async () => {
    stubs["/jobs/object-url"] = { status: 200, body: { found: false } };
    const outcome = await runBoxPullIteration(depsOf());
    expect(outcome).toEqual({ action: "aborted", reason: "object_missing" });
    const abort = seenJobApiCalls.find((call) => call.path === "/jobs/abort")!;
    expect(abort.body["reason"]).toBe("object_missing");
    expect(abort.body["fence"]).toBe(1);
    expect(JSON.stringify(abort.body)).not.toContain(OBJECT_REF);
  });

  it("the bytes are read under a bound and never written to disk", async () => {
    objectBody = "x".repeat(8192);
    const outcome = await runBoxPullIteration(depsOf({ maxObjectBytes: 1024 }));
    expect(outcome).toEqual({ action: "aborted", reason: "unsupported_document" });
    expect(seenJobApiCalls.some((call) => call.path === "/jobs/complete")).toBe(false);
    expect(MAX_OBJECT_BYTES).toBe(20 * 1024 * 1024);
  });

  it("a Storage outage waits for the next poll instead of cancelling the job", async () => {
    objectStatus = 503;
    const outcome = await runBoxPullIteration(depsOf());
    expect(outcome.action).toBe("object_unavailable");
    expect(seenJobApiCalls.some((call) => call.path === "/jobs/abort")).toBe(false);
    expect(seenJobApiCalls.some((call) => call.path === "/jobs/complete")).toBe(false);
  });

  it("a source revoked mid-job stops the box: no artifact travels, and the job aborts", async () => {
    stubs["/jobs/complete"] = { status: 200, body: { outcome: "refused" } };
    const outcome = await runBoxPullIteration(depsOf());
    expect(outcome).toEqual({ action: "aborted", reason: "source_revoked" });
    expect(seenJobApiCalls.filter((call) => call.path === "/jobs/abort")).toHaveLength(1);
    const complete = seenJobApiCalls.find((call) => call.path === "/jobs/complete")!;
    expect(complete.body["artifacts"]).toHaveLength(1);
    expect(complete.body["jobId"]).toBe(JOB_ID);
    expect(complete.body["fence"]).toBe(1);
    expect(complete.body["leaseToken"]).toBe("synthetic-lease-token-01");
  });

  it("the same completion delivered twice is a no-op", async () => {
    stubs["/jobs/complete"] = { status: 200, body: { outcome: "already_completed", artifactCount: 1 } };
    expect(await runBoxPullIteration(depsOf())).toEqual({ action: "already_completed", artifactCount: 1 });
    expect(seenJobApiCalls.filter((call) => call.path === "/jobs/complete")).toHaveLength(1);
    expect(seenJobApiCalls.some((call) => call.path === "/jobs/abort")).toBe(false);
  });

  it("an artifact set the artifact home would refuse never leaves the box", async () => {
    const bad: ArtifactInput[] = [
      { artifactIndex: 0, bodyText: "one" },
      { artifactIndex: 0, bodyText: "two" },
    ];
    const outcome = await runBoxPullIteration(
      depsOf({ extractor: { async extract() { return { outcome: "extracted", artifacts: bad }; } } }),
    );
    expect(outcome).toEqual({ action: "aborted", reason: "quality_failed" });
    const complete = seenJobApiCalls.find((call) => call.path === "/jobs/complete");
    expect(complete).toBeUndefined();
  });

  it("an extractor that cannot parse the document here aborts with a named reason", async () => {
    const outcome = await runBoxPullIteration(
      depsOf({ extractor: { async extract() { return { outcome: "unsupported", reason: "unsupported_document" }; } } }),
    );
    expect(outcome).toEqual({ action: "aborted", reason: "unsupported_document" });
    expect(seenJobApiCalls.some((call) => call.path === "/jobs/abort")).toBe(true);
  });

  it("nothing the box emits can carry the credential, the URL, or the object it read", async () => {
    const events: BoxEvent[] = [];
    const outcome = await runBoxPullIteration(depsOf({ log: (event) => events.push(event) }));
    expect(outcome.action).toBe("completed");
    expect(events.length).toBeGreaterThan(0);
    const line = events.map((event) => JSON.stringify(event)).join("\n");
    for (const marker of LEAK_MARKERS) {
      expect(line, `an event carried ${JSON.stringify(marker)}`).not.toContain(marker);
    }
    for (const event of events) {
      for (const [key, value] of Object.entries(event)) {
        if (typeof value !== "string" || key === "kind" || key === "jobId") continue;
        expect(value, `event field ${key}`).toMatch(/^[a-z0-9_]{1,64}$/);
      }
    }
  });

  it("the box never touches console, so a stray log line cannot leak a URL from inside a tenant", async () => {
    const logs = vi.spyOn(console, "log");
    const warns = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");
    const outcome = await runBoxPullIteration(depsOf({ log: () => undefined }));
    expect(outcome.action).toBe("completed");
    expect(logs).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("sends nothing at all when no credential is configured on the box", async () => {
    const outcome = await runBoxPullIteration(depsOf({ credential: () => undefined }));
    expect(outcome).toEqual({ action: "credential_missing" });
    expect(seenJobApiCalls).toHaveLength(0);
    expect(seenObjectCalls).toHaveLength(0);
  });

  it("a lease answer that is not the closed shape is a wait, not a crash", async () => {
    stubs["/jobs/lease"] = { status: 200, body: { found: true, jobId: 42 } };
    const events: BoxEvent[] = [];
    const outcome = await runBoxPullIteration(depsOf({ log: (event) => events.push(event) }));
    expect(outcome.action).toBe("job_api_malformed");
    expect(JSON.stringify(events)).not.toContain("42");
  });

  it("polls until it is told to stop, and never on a credential it lost", async () => {
    let polls = 0;
    stubs["/jobs/lease"] = {
      status: 200,
      body: { found: false },
    };
    const outcomes = await runBoxPullLoop(depsOf(), {
      maxIterations: 3,
      pollIntervalMs: 0,
      sleep: async () => {
        polls += 1;
      },
    });
    expect(outcomes.map((outcome) => outcome.action)).toEqual(["no_work", "no_work", "no_work"]);
    expect(polls).toBe(2);
    expect(seenJobApiCalls.filter((call) => call.path === "/jobs/lease")).toHaveLength(3);
  });
});
