import { z } from "zod";

import { DataClass } from "./data-class";
import { OpaqueId, VersionTag } from "./keys";

/**
 * Answer and evidence contract (plan §12.1).
 *
 * Deterministic binding (verifier pass 1) proves the IDs and spans exist; semantic entailment
 * (pass 2) is recorded in `verificationStatus`. Provider names, model ids and signed URLs are
 * deliberately unrepresentable here: they belong to the run audit and to freshly re-authorized
 * citation access (§4.4, F24).
 */
export const ClaimType = z.enum(["source_fact", "requirement", "record_fact", "inference"]);
export type ClaimType = z.infer<typeof ClaimType>;

export const VerificationStatus = z.enum([
  "unverified",
  "binding_passed",
  "binding_failed",
  "supported",
  "partial",
  "unsupported",
  "contradicted",
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/** Character span inside a specific chunk version, used for verbatim quote checks (F21). */
const EvidenceSpan = z
  .strictObject({
    startChar: z.number().int().nonnegative(),
    endChar: z.number().int().nonnegative(),
  })
  .refine((span) => span.endChar >= span.startChar, {
    message: "endChar must not precede startChar",
  });

const ChunkEvidence = z.strictObject({
  kind: z.literal("chunk"),
  sourceVersionId: z.uuid(),
  chunkId: OpaqueId,
  span: EvidenceSpan,
  quotedText: z.string().min(1).max(4000).optional(),
});

const RecordEvidence = z.strictObject({
  kind: z.literal("record"),
  toolCallId: OpaqueId,
  recordType: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  recordId: OpaqueId,
  recordVersion: z.number().int().positive(),
  observedAt: z.iso.datetime(),
});

const FormFieldEvidence = z.strictObject({
  kind: z.literal("form_field"),
  submissionId: z.uuid(),
  fieldPath: z.string().min(1).max(256),
  templateVersion: VersionTag,
});

export const EvidenceRef = z.discriminatedUnion("kind", [
  ChunkEvidence,
  RecordEvidence,
  FormFieldEvidence,
]);
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Claim = z
  .strictObject({
    id: OpaqueId,
    text: z.string().min(1).max(8000),
    type: ClaimType,
    evidence: z.array(EvidenceRef),
    // Service-specific authority taxonomy (plan §7.1): a vendor manual is not company policy.
    authority: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    verificationStatus: VerificationStatus,
    limitations: z.array(z.string().min(1).max(1000)).default([]),
  })
  .superRefine((claim, ctx) => {
    if (claim.evidence.length === 0) {
      if (claim.type !== "inference") {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: `a ${claim.type} claim needs at least one evidence reference (§12.1)`,
        });
      } else if (claim.limitations.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["limitations"],
          message: "an inference without evidence must state its limitation (§12.1)",
        });
      }
    }
  });
export type Claim = z.infer<typeof Claim>;

export const Answer = z
  .strictObject({
    status: z.enum(["answered", "partial", "refused", "unavailable"]),
    runId: z.uuid(),
    expertVersions: z.array(z.string().min(1).max(160)),
    corpusGenerations: z.array(z.number().int().positive()),
    asOf: z.iso.datetime(),
    summary: z.string().min(1).max(8000),
    // Highest class among the answer's dependencies (§6.2); drives retention and export.
    dataClass: DataClass,
    claims: z.array(Claim),
    // Mandatory: an empty list means "we checked and there is nothing unknown" (§12.1).
    unknowns: z.array(z.string().min(1).max(1000)),
    conflicts: z.array(z.string().min(1).max(1000)).default([]),
    truncation: z.array(z.string().min(1).max(1000)).default([]),
    gateResult: z.string().min(1).max(2000).optional(),
    handoff: z.string().min(1).max(2000).optional(),
    draftId: OpaqueId.optional(),
  })
  .superRefine((answer, ctx) => {
    if (answer.status === "answered" && answer.claims.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["claims"],
        message: "status 'answered' requires at least one evidenced claim (§12.1)",
      });
    }
  });
export type Answer = z.infer<typeof Answer>;
