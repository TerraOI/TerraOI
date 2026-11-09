import { z } from "zod";

import { DataClass } from "./data-class";
import { isIngestibleInM1 } from "./provider-route";

// Re-exported so an ingestion implementer gets the M1 cut rule from one import (plan §12.4,
// §15.0: `restricted` is not ingested in M1 at all).
export { M1_MAX_INGESTION_CLASS, isIngestibleInM1 } from "./provider-route";

/**
 * Ingestion job payload (plan §7.2, §7.5, §13; F12, F32).
 *
 * The payload carries server-issued scope, not authority. Every worker call re-reads the job row
 * and re-checks tenant, source version, expected stage and lease (F32), so a replayed, forged or
 * stale message cannot process another tenant's object or resurrect a revoked source. Object
 * access comes from a short-lived signed URL issued by the job API, never from this message.
 */
export const IngestionStage = z.enum(["validate", "extract", "index", "publish"]);
export type IngestionStage = z.infer<typeof IngestionStage>;

export const JobExecutor = z.enum(["cloud_worker", "local_box"]);
export type JobExecutor = z.infer<typeof JobExecutor>;

export const IngestionJobPayload = z
  .strictObject({
    jobId: z.uuid(),
    organisationId: z.uuid(),
    sourceVersionId: z.uuid(),
    stage: IngestionStage,
    executor: JobExecutor,
    // Decides which executor may run and which providers may be called (§7.2, §12.4).
    dataClass: DataClass,
    parserGeneration: z.string().min(1).max(64),
    indexGeneration: z.number().int().positive(),
    // **Not** part of the stage idempotency key, which is (org, source, version, stage,
    // generation) (§7.5): a fresh key for every retry would defeat deduplication and re-enqueue
    // a stage that already ran. The attempt number is consumer bookkeeping — leases, backoff and
    // observability — and the unique stage key on `ingestion_jobs`
    // (`20261105070000_knowledge_core.sql:398`) leaves it out.
    attempt: z.number().int().positive(),
    leaseToken: z.string().min(8).max(128).optional(),
    issuedAt: z.iso.datetime(),
  })
  .superRefine((job, ctx) => {
    if (job.executor === "local_box" && job.stage !== "extract") {
      ctx.addIssue({
        code: "custom",
        path: ["executor"],
        message: "the local box only runs extraction (§13: OCR and inference are separate)",
      });
    }
    if (!isIngestibleInM1(job.dataClass)) {
      ctx.addIssue({
        code: "custom",
        path: ["dataClass"],
        message: "restricted content is not ingested in M1 (§12.4); lifting this needs an ADR",
      });
    }
  });
export type IngestionJobPayload = z.infer<typeof IngestionJobPayload>;
