import { describe, expect, it } from "vitest";

import type { JobApiPort, LeaseRow } from "./ocr-pull";
import {
  handleJobAbort,
  handleJobComplete,
  handleJobLease,
  handleJobObjectUrl,
  handleJobRenew,
  jobApiUnavailableResponse,
  type ObjectUrlMintBinding,
} from "./job-api-http";
import { digestWorkerCredential } from "./job-db";
import { SIGNED_URL_TTL_SECONDS } from "./mint-object-url";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
const VERSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2";

function leaseRow(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    jobId: JOB,
    organisationId: ORG,
    sourceVersionId: VERSION,
    stage: "extract",
    executor: "local_box",
    parserGeneration: "v1",
    indexGeneration: 1,
    dataClass: "internal",
    leaseToken: "lease-1",
    fence: 2,
    attempt: 1,
    ...overrides,
  };
}

function fakeApi(overrides: Partial<JobApiPort> = {}): JobApiPort {
  return {
    lease: async () => leaseRow(),
    renew: async () => ({ outcome: "renewed", expiresAt: "2026-11-21T12:00:00.000Z", fence: 3 }),
    objectRefForLease: async () => ({ found: false }),
    complete: async () => ({ outcome: "completed", artifactCount: 1 }),
    abort: async () => ({ outcome: "aborted" }),
    retarget: async () => ({ outcome: "retargeted" }),
    ...overrides,
  };
}

function post(path: string, body: unknown, auth?: string): Request {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(`https://company1.terraoi.app${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("job-api-http — box-facing /api/jobs surface (T-211 PR-3a)", () => {
  it("unbound JOB_DB answers 503 without naming hosts or pools", async () => {
    const response = jobApiUnavailableResponse();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toMatch(/postgres:\/\/|pooler|hyperdrive|JOB_DB/i);
  });

  it("missing Bearer is 401", async () => {
    const api = fakeApi();
    const response = await handleJobLease(post("/api/jobs/lease", { stage: "extract", leaseSeconds: 300 }), api);
    expect(response.status).toBe(401);
  });

  it("lease returns found:true with the camelCase row the box client parses", async () => {
    const response = await handleJobLease(
      post("/api/jobs/lease", { stage: "extract", leaseSeconds: 300 }, `Bearer ${TOKEN}`),
      fakeApi(),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      found: true,
      jobId: JOB,
      organisationId: ORG,
      sourceVersionId: VERSION,
      stage: "extract",
      executor: "local_box",
      leaseToken: "lease-1",
      fence: 2,
      attempt: 1,
    });
  });

  it("lease with no work returns found:false", async () => {
    const response = await handleJobLease(
      post("/api/jobs/lease", { stage: "extract", leaseSeconds: 300 }, `Bearer ${TOKEN}`),
      fakeApi({ lease: async () => null }),
    );
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ found: false });
  });

  it("renew / complete / abort return closed outcomes", async () => {
    const api = fakeApi({
      renew: async () => ({ outcome: "refused" }),
      complete: async () => ({ outcome: "already_completed", artifactCount: 2 }),
      abort: async () => ({ outcome: "refused" }),
    });
    const renew = await handleJobRenew(
      post("/api/jobs/renew", { jobId: JOB, leaseToken: "t", fence: 1, leaseSeconds: 300 }, `Bearer ${TOKEN}`),
      api,
    );
    expect(await bodyOf(renew)).toEqual({ outcome: "refused" });

    const complete = await handleJobComplete(
      post(
        "/api/jobs/complete",
        {
          jobId: JOB,
          leaseToken: "t",
          fence: 1,
          sourceVersionId: VERSION,
          stage: "extract",
          indexGeneration: 1,
          artifacts: [{ artifactIndex: 0, bodyText: "hi" }],
          notes: [],
          confidence: null,
        },
        `Bearer ${TOKEN}`,
      ),
      api,
    );
    expect(await bodyOf(complete)).toEqual({ outcome: "already_completed", artifactCount: 2 });

    const abort = await handleJobAbort(
      post("/api/jobs/abort", { jobId: JOB, leaseToken: "t", fence: 1, reason: "object_missing" }, `Bearer ${TOKEN}`),
      api,
    );
    expect(await bodyOf(abort)).toEqual({ outcome: "refused" });
  });

  it("malformed JSON body is 400 without echoing upstream detail", async () => {
    const response = await handleJobLease(
      new Request("https://company1.terraoi.app/api/jobs/lease", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{",
      }),
      fakeApi(),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toMatch(/SyntaxError|postgres/i);
  });
});

describe("job-api-http — object-url (#170)", () => {
  const URL_ONLY = "https://storage.example.test/object/sign/knowledge/org/key.pdf?token=abc";

  function mintStub(overrides: Partial<ObjectUrlMintBinding> = {}): ObjectUrlMintBinding {
    return {
      mintObjectUrl: async () => ({ ok: true, url: URL_ONLY }),
      ...overrides,
    };
  }

  it("forwards only the credential hash over the binding — never the raw Bearer token", async () => {
    let seen: unknown = null;
    const mint = mintStub({
      mintObjectUrl: async (args) => {
        seen = args;
        return { ok: true, url: URL_ONLY };
      },
    });
    await handleJobObjectUrl(
      post("/api/jobs/object-url", { jobId: JOB, leaseToken: "lease-1", fence: 2 }, `Bearer ${TOKEN}`),
      mint,
    );
    expect(seen).toEqual({
      tokenHash: digestWorkerCredential(TOKEN),
      jobId: JOB,
      leaseToken: "lease-1",
      fence: 2,
    });
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it("returns found:true with url and expiresInSeconds; URL appears only in the response body", async () => {
    const response = await handleJobObjectUrl(
      post("/api/jobs/object-url", { jobId: JOB, leaseToken: "lease-1", fence: 2 }, `Bearer ${TOKEN}`),
      mintStub(),
    );
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    expect(bodyText).toContain(URL_ONLY);
    expect(JSON.parse(bodyText)).toEqual({
      found: true,
      url: URL_ONLY,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
    // No side-channel: headers must not echo the URL (#170 test).
    for (const [, value] of response.headers) {
      expect(value).not.toContain(URL_ONLY);
    }
  });

  it("maps a generic mint refusal to found:false with no existence signal", async () => {
    const response = await handleJobObjectUrl(
      post("/api/jobs/object-url", { jobId: JOB, leaseToken: "lease-1", fence: 2 }, `Bearer ${TOKEN}`),
      mintStub({ mintObjectUrl: async () => ({ ok: false }) }),
    );
    expect(await bodyOf(response)).toEqual({ found: false });
  });
});
