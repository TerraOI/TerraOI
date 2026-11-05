import { describe, expect, it } from "vitest";

import { IngestionJobPayload, IngestionStage, isIngestibleInM1 } from "./ingestion-job";

// Plan §7.2, §11 F12/F32, §13: a job message carries server-issued scope that the job API
// re-validates against the job row. Nothing in the payload is authority on its own.
const validJob = () => ({
  jobId: "99999999-9999-4999-8999-999999999999",
  organisationId: "11111111-1111-4111-8111-111111111111",
  sourceVersionId: "77777777-7777-4777-8777-777777777777",
  stage: "extract" as const,
  executor: "local_box" as const,
  dataClass: "client_confidential" as const,
  parserGeneration: "ocr-2026-10",
  indexGeneration: 1,
  attempt: 1,
  issuedAt: "2026-11-04T12:00:00Z",
});

describe("IngestionJobPayload (plan §7.2, §13)", () => {
  it("parses an OCR extraction job", () => {
    expect(IngestionJobPayload.parse(validJob()).stage).toBe("extract");
  });

  it("rejects unknown keys, so credentials or object URLs cannot ride in the message", () => {
    for (const extra of [
      { signedUrl: "https://supabase/…?token=…" },
      { serviceRoleKey: "eyJ…" },
      { uploadToken: "abc" },
      { organisationSlug: "company1" },
    ]) {
      expect(() => IngestionJobPayload.parse({ ...validJob(), ...extra })).toThrow();
    }
  });

  it("keeps the local box to extraction only (plan §13: separate processes)", () => {
    for (const stage of ["validate", "index", "publish"] as const) {
      expect(() => IngestionJobPayload.parse({ ...validJob(), stage, executor: "local_box" })).toThrow();
    }
    expect(IngestionJobPayload.parse({ ...validJob(), stage: "extract", executor: "cloud_worker" }))
      .toBeDefined();
  });

  it("requires a positive attempt and generation for idempotency keys (plan §7.5)", () => {
    expect(() => IngestionJobPayload.parse({ ...validJob(), attempt: 0 })).toThrow();
    expect(() => IngestionJobPayload.parse({ ...validJob(), indexGeneration: -3 })).toThrow();
  });

  it("refuses to enqueue a restricted source in M1 (plan §12.4: not ingested at all)", () => {
    expect(() => IngestionJobPayload.parse({ ...validJob(), dataClass: "restricted" })).toThrow();
    expect(isIngestibleInM1("restricted")).toBe(false);
    expect(isIngestibleInM1("public")).toBe(true);
    expect(isIngestibleInM1("client_confidential")).toBe(true);
  });

  it("lists only the pipeline stages a worker may be asked to run", () => {
    for (const stage of ["validate", "extract", "index", "publish"] as const) {
      expect(IngestionStage.parse(stage)).toBe(stage);
    }
    // Terminal/visible states are database state, not something a job asks a worker to do.
    expect(() => IngestionStage.parse("revoked")).toThrow();
    expect(() => IngestionStage.parse("deleted")).toThrow();
  });
});
