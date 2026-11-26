import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createIndexJobApi, createJobApi, dispatchOutboxEvents, type JobSql } from "./job-db";

const TOKEN = "Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2";
const DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
const VERSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Call = { sql: string; values: unknown[] };

function recordingSql(handler: (call: Call) => Promise<Record<string, unknown>[]>): {
  sql: JobSql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ""), "");
    const call = { sql: text.replace(/\s+/g, " ").trim(), values };
    calls.push(call);
    return handler(call);
  }) as JobSql;
  sql.end = async () => undefined;
  return { sql, calls };
}

describe("createJobApi — JOB_DB Hyperdrive adapter (T-211 PR-3a)", () => {
  it("returns null when JOB_DB is not bound (honest unavailable)", () => {
    expect(createJobApi({})).toBeNull();
    expect(createJobApi({ binding: null })).toBeNull();
  });

  it("hashes the presented credential before SQL and never sends the clear token", async () => {
    const { sql, calls } = recordingSql(async () => [
      {
        o_found: false,
      },
    ]);
    const api = createJobApi({ openSql: () => sql })!;
    await api.lease({ credential: TOKEN, stage: "extract", leaseSeconds: 300 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("job_api.lease_parse_job_v1");
    expect(calls[0]?.values[0]).toBe(DIGEST);
    expect(calls[0]?.values).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0]?.values)).not.toContain(TOKEN);
  });

  it("maps a found lease row into the JobApiPort camelCase shape", async () => {
    const { sql } = recordingSql(async () => [
      {
        o_found: true,
        o_job_id: JOB,
        o_organisation_id: ORG,
        o_source_version_id: VERSION,
        o_stage: "extract",
        o_executor: "local_box",
        o_parser_generation: "v1",
        o_index_generation: 1,
        o_data_class: "internal",
        o_lease_token: "lease-token-1",
        o_fence: 3,
        o_attempt: 2,
      },
    ]);
    const api = createJobApi({ openSql: () => sql })!;
    await expect(api.lease({ credential: TOKEN, stage: "extract", leaseSeconds: 300 })).resolves.toEqual({
      jobId: JOB,
      organisationId: ORG,
      sourceVersionId: VERSION,
      stage: "extract",
      executor: "local_box",
      parserGeneration: "v1",
      indexGeneration: 1,
      dataClass: "internal",
      leaseToken: "lease-token-1",
      fence: 3,
      attempt: 2,
    });
  });

  it("returns null when lease reports o_found=false (no existence oracle)", async () => {
    const { sql } = recordingSql(async () => [{ o_found: false }]);
    const api = createJobApi({ openSql: () => sql })!;
    await expect(api.lease({ credential: TOKEN, stage: "extract", leaseSeconds: 300 })).resolves.toBeNull();
  });

  it("maps renew / abort / retarget closed outcomes", async () => {
    const { sql, calls } = recordingSql(async (call) => {
      if (call.sql.includes("renew_parse_lease_v1")) {
        return [{ o_outcome: "renewed", o_expires_at: new Date("2026-11-21T12:00:00.000Z"), o_fence: 4 }];
      }
      if (call.sql.includes("abort_parse_job_v1")) {
        return [{ o_outcome: "refused", o_status: null }];
      }
      if (call.sql.includes("retarget_extract_job_v1")) {
        return [{ o_outcome: "retargeted", o_executor: "local_box", o_status: "queued", o_fence: 5 }];
      }
      return [];
    });
    const api = createJobApi({ openSql: () => sql })!;
    await expect(
      api.renew({ credential: TOKEN, jobId: JOB, leaseToken: "t", fence: 3, leaseSeconds: 300 }),
    ).resolves.toEqual({ outcome: "renewed", expiresAt: "2026-11-21T12:00:00.000Z", fence: 4 });
    await expect(
      api.abort({ credential: TOKEN, jobId: JOB, leaseToken: "t", fence: 3, reason: "object_missing" }),
    ).resolves.toEqual({ outcome: "refused" });
    await expect(
      api.retarget({ credential: TOKEN, jobId: JOB, leaseToken: "t", fence: 3, reason: "no_text_layer" }),
    ).resolves.toEqual({ outcome: "retargeted" });
    expect(calls.some((c) => c.sql.includes("renew_parse_lease_v1"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("abort_parse_job_v1"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("retarget_extract_job_v1"))).toBe(true);
  });

  it("complete maps artifacts to SQL keys and returns closed outcomes", async () => {
    const { sql, calls } = recordingSql(async () => [{ o_outcome: "completed", o_artifact_count: 1, o_event_id: JOB }]);
    const api = createJobApi({ openSql: () => sql })!;
    await expect(
      api.complete({
        credential: TOKEN,
        jobId: JOB,
        leaseToken: "t",
        fence: 3,
        sourceVersionId: VERSION,
        stage: "extract",
        indexGeneration: 1,
        artifacts: [{ artifactIndex: 0, bodyText: "hello", locator: { page: 1 }, confidence: 0.9 }],
        notes: ["n1"],
        confidence: 0.8,
      }),
    ).resolves.toEqual({ outcome: "completed", artifactCount: 1 });
    // complete_parse_job_v1 types p_artifacts and p_notes as jsonb (20261120212000:454-455). A JS
    // array would be sent as a Postgres array and fail function resolution, so both go as JSON
    // text with an explicit cast, independent of driver type inference.
    const artifactsArg = calls[0]?.values[7];
    const notesArg = calls[0]?.values[8];
    expect(typeof artifactsArg).toBe("string");
    expect(typeof notesArg).toBe("string");
    expect(JSON.parse(artifactsArg as string)).toEqual([
      { artifact_index: 0, body_text: "hello", locator: { page: 1 }, confidence: 0.9 },
    ]);
    expect(JSON.parse(notesArg as string)).toEqual(["n1"]);
    expect(calls[0]?.sql).toContain("$8::jsonb");
    expect(calls[0]?.sql).toContain("$9::jsonb");
  });

  it("maps SQL 42501 to refused without leaking postgres detail", async () => {
    const err = Object.assign(new Error("job not available postgres://inner-host:5432/prod"), { code: "42501" });
    const { sql } = recordingSql(async () => {
      throw err;
    });
    const api = createJobApi({ openSql: () => sql })!;
    const outcome = await api.complete({
      credential: TOKEN,
      jobId: JOB,
      leaseToken: "t",
      fence: 3,
      sourceVersionId: VERSION,
      stage: "extract",
      indexGeneration: 1,
      artifacts: [{ artifactIndex: 0, bodyText: "x" }],
      notes: [],
      confidence: null,
    });
    expect(outcome).toEqual({ outcome: "refused" });
    expect(JSON.stringify(outcome)).not.toMatch(/postgres:\/\/|inner-host/i);
  });

  it("objectRefForLease maps found/false rows", async () => {
    const found = recordingSql(async () => [
      { o_found: true, o_object_ref: "org/key.pdf", o_data_class: "internal", o_executor: "local_box" },
    ]);
    const miss = recordingSql(async () => [{ o_found: false }]);
    const apiFound = createJobApi({ openSql: () => found.sql })!;
    const apiMiss = createJobApi({ openSql: () => miss.sql })!;
    await expect(
      apiFound.objectRefForLease({ credential: TOKEN, jobId: JOB, leaseToken: "t", fence: 1 }),
    ).resolves.toEqual({ found: true, objectRef: "org/key.pdf", dataClass: "internal", executor: "local_box" });
    await expect(
      apiMiss.objectRefForLease({ credential: TOKEN, jobId: JOB, leaseToken: "t", fence: 1 }),
    ).resolves.toEqual({ found: false });
  });

  it("dispatchOutboxEvents hashes the credential and maps counts (#99)", async () => {
    const { sql, calls } = recordingSql(async () => [
      { o_processed: 3, o_enqueued: 2, o_skipped: 1 },
    ]);
    await expect(
      dispatchOutboxEvents({ openSql: () => sql }, { credential: TOKEN, limit: 16 }),
    ).resolves.toEqual({ processed: 3, enqueued: 2, skipped: 1 });
    expect(calls[0]?.sql).toContain("job_api.dispatch_outbox_v1");
    expect(calls[0]?.values[0]).toBe(DIGEST);
    expect(calls[0]?.values[1]).toBe(16);
    expect(calls[0]?.values).not.toContain(TOKEN);
  });

  it("dispatchOutboxEvents returns null when JOB_DB is unbound", async () => {
    await expect(dispatchOutboxEvents({}, { credential: TOKEN })).resolves.toBeNull();
  });

  it("createIndexJobApi writeChunks hashes the credential and maps snake chunk keys (T-113)", async () => {
    const { sql, calls } = recordingSql(async () => [
      { o_outcome: "completed", o_chunk_count: 1, o_vector_count: 1, o_event_id: EVENT },
    ]);
    const api = createIndexJobApi({ openSql: () => sql })!;
    await expect(
      api.writeChunks({
        credential: TOKEN,
        jobId: JOB,
        leaseToken: "lease",
        fence: 2,
        sourceVersionId: VERSION,
        indexGeneration: 1,
        embeddingIndexId: "55555555-5555-4555-8555-555555555555",
        chunks: [
          {
            chunkIndex: 0,
            bodyText: "synthetic chunk",
            chunkId: "66666666-6666-4666-8666-666666666666",
            embedding: [0.1, 0.2],
          },
        ],
      }),
    ).resolves.toEqual({
      outcome: "completed",
      chunkCount: 1,
      vectorCount: 1,
      eventId: EVENT,
    });
    expect(calls[0]?.sql).toContain("job_api.write_chunks_v1");
    expect(calls[0]?.values[0]).toBe(DIGEST);
    expect(calls[0]?.values).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0]?.values)).toContain("chunk_index");
    expect(JSON.stringify(calls[0]?.values)).toContain("body_text");
  });

  it("createIndexJobApi artifactsForLease maps found rows", async () => {
    const { sql } = recordingSql(async () => [
      {
        o_found: true,
        o_artifact_index: 0,
        o_body_text: "extract text",
        o_locator: { page: 1 },
      },
    ]);
    const api = createIndexJobApi({ openSql: () => sql })!;
    await expect(
      api.artifactsForLease({ credential: TOKEN, jobId: JOB, leaseToken: "t", fence: 1 }),
    ).resolves.toEqual({
      found: true,
      artifacts: [{ artifactIndex: 0, bodyText: "extract text", locator: { page: 1 } }],
    });
  });
});
