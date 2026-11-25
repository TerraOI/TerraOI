import { z } from "zod";

import { DataClass } from "./data-class";
import { isIngestibleInM1 } from "./provider-route";

/**
 * F15 knowledge submission request payloads (plan §6.1 / §9 route table; ADR-0013; #73).
 *
 * Bodies never carry an organisation id. The server computes the stored `data_class` as
 * max(contextDataClass, cited version classes); the client does not choose the final label.
 */

export const KnowledgeSubmissionKind = z.enum(["note", "answer", "correction"]);
export type KnowledgeSubmissionKind = z.infer<typeof KnowledgeSubmissionKind>;

export const KnowledgeSubmissionState = z.enum(["submitted", "approved", "rejected", "withdrawn"]);
export type KnowledgeSubmissionState = z.infer<typeof KnowledgeSubmissionState>;

const IngestibleDataClass = DataClass.refine(isIngestibleInM1, {
  message: "restricted is not ingestible in M1",
});

export const CreateKnowledgeSubmissionRequest = z.strictObject({
  collectionId: z.uuid(),
  kind: KnowledgeSubmissionKind,
  proposedText: z.string().trim().min(1).max(200_000),
  /** Conversation / answer class floor — an input to max(), not the stored label. */
  contextDataClass: IngestibleDataClass,
  citedSourceVersionIds: z.array(z.uuid()).max(64).default([]),
  /** Opaque until T-104 / #178; provenance only. */
  agentRunId: z.uuid().optional(),
  reviewBy: z.iso.datetime().optional(),
});
export type CreateKnowledgeSubmissionRequest = z.infer<typeof CreateKnowledgeSubmissionRequest>;

export const ReviewKnowledgeSubmissionRequest = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type ReviewKnowledgeSubmissionRequest = z.infer<typeof ReviewKnowledgeSubmissionRequest>;
