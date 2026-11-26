import { z } from "zod";

import { ClaimType, RefusalKey } from "./answer";
import { DataClass } from "./data-class";
import { ExpertKey, OpaqueId } from "./keys";

/**
 * Eval case file contract (plan §14.1, §6.1 Evaluation group; ADR-0010 / #84 / #137).
 *
 * Committed JSON under `evals/<expertKey>/` (approved) and `evals/<expertKey>/drafts/` (drafted)
 * is validated by this schema. F35 scores only approved files; drafts are ignored by the runner.
 */

export const CaseType = z.enum(["answerable", "needs_clarification", "must_refuse", "out_of_scope"]);
export type CaseType = z.infer<typeof CaseType>;

export const AdversarialClass = z.enum([
  "cross_tenant_bait",
  "project_restricted",
  "poisoned_instruction_in_document",
  "missing_source",
  "provider_outage_mid_run",
  "ambiguous_follow_up",
]);
export type AdversarialClass = z.infer<typeof AdversarialClass>;

export const EvalCaseStatus = z.enum(["drafted", "approved"]);
export type EvalCaseStatus = z.infer<typeof EvalCaseStatus>;

export const EvalCaseOrigin = z.enum(["agent_drafted", "expert_written", "pilot"]);
export type EvalCaseOrigin = z.infer<typeof EvalCaseOrigin>;

export const ExpectedAnswerStatus = z.enum(["answered", "partial", "refused", "unavailable"]);
export type ExpectedAnswerStatus = z.infer<typeof ExpectedAnswerStatus>;

/**
 * Approved-case citation locator. M1 document QA is `chunk` only (ADR-0010). `quotedText` is
 * deliberately absent from committed files (AGENTS.md §4.7); F35 scores against the live corpus.
 */
export const EvalChunkEvidence = z.strictObject({
  kind: z.literal("chunk"),
  sourceVersionId: z.uuid(),
  chunkId: OpaqueId,
  span: z
    .strictObject({
      startChar: z.number().int().nonnegative(),
      endChar: z.number().int().nonnegative(),
    })
    .superRefine((span, ctx) => {
      if (span.endChar < span.startChar) {
        ctx.addIssue({
          code: "custom",
          path: ["endChar"],
          message: "endChar must be >= startChar",
        });
      }
    }),
});
export type EvalChunkEvidence = z.infer<typeof EvalChunkEvidence>;

const DraftedDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "draftedOn must be YYYY-MM-DD");

const EvalCaseBase = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: z.string().min(1).max(64),
  expertKey: ExpertKey,
  status: EvalCaseStatus,
  origin: EvalCaseOrigin,
  caseType: CaseType,
  question: z.string().min(1).max(4000),
  expectedAnswerPoints: z.array(z.string().min(1).max(2000)).min(1),
  expectedClaimTypes: z.array(ClaimType).min(1),
  expectedAnswerStatus: ExpectedAnswerStatus,
  citationRequired: z.boolean(),
  dataClass: DataClass,
  projectScope: z.string().min(1).max(128).nullable(),
  forbiddenClaims: z.array(z.string().min(1).max(2000)),
  isolationBait: z.boolean(),
  adversarialClass: AdversarialClass.nullable(),
  expectedSource: z.string().min(1).max(2000),
  expectedFixtures: z.array(z.string().regex(/^SYNTH-[A-Z0-9-]+$/)).min(1),
  expectedEvidence: z.array(EvalChunkEvidence),
  /** Required exactly when expectedAnswerStatus is refused or unavailable (ADR-0010). */
  expectedRefusalKey: RefusalKey.optional(),
  approvedBy: OpaqueId.nullable(),
  approvedAt: z.iso.datetime().nullable(),
  draftedBy: z.string().min(1).max(200),
  draftedOn: DraftedDate,
});

export const EvalCase = EvalCaseBase.superRefine((caseFile, ctx) => {
  const refused =
    caseFile.expectedAnswerStatus === "refused" || caseFile.expectedAnswerStatus === "unavailable";

  if (refused && caseFile.expectedRefusalKey === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedRefusalKey"],
      message: "expectedRefusalKey is required when expectedAnswerStatus is refused or unavailable (ADR-0010)",
    });
  }
  if (!refused && caseFile.expectedRefusalKey !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedRefusalKey"],
      message: `expectedRefusalKey is set only when expectedAnswerStatus is refused or unavailable, not '${caseFile.expectedAnswerStatus}'`,
    });
  }
  if (caseFile.expectedRefusalKey !== undefined) {
    const key = caseFile.expectedRefusalKey;
    const statusOk =
      key === "unavailable"
        ? caseFile.expectedAnswerStatus === "unavailable"
        : caseFile.expectedAnswerStatus === "refused";
    if (!statusOk) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedRefusalKey"],
        message: "expectedRefusalKey does not match expectedAnswerStatus (ADR-0010)",
      });
    }
  }

  if (
    (caseFile.expectedAnswerStatus === "refused" || caseFile.expectedAnswerStatus === "unavailable") &&
    caseFile.citationRequired
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["citationRequired"],
      message: "citationRequired must be false when the expected answer is refused or unavailable",
    });
  }

  if (caseFile.status === "drafted") {
    if (caseFile.expectedEvidence.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedEvidence"],
        message: "drafted cases carry expectedEvidence: [] (ADR-0010)",
      });
    }
    if (caseFile.approvedBy !== null || caseFile.approvedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "drafted cases must leave approvedBy and approvedAt null",
      });
    }
  }

  if (caseFile.status === "approved") {
    if (caseFile.approvedBy === null || caseFile.approvedAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "approved cases must record approvedBy and approvedAt",
      });
    }
    if (caseFile.citationRequired && caseFile.expectedEvidence.length < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedEvidence"],
        message: "approved cases with citationRequired need at least one expectedEvidence entry (ADR-0010)",
      });
    }
    for (const [i, entry] of caseFile.expectedEvidence.entries()) {
      if (entry.kind !== "chunk") {
        ctx.addIssue({
          code: "custom",
          path: ["expectedEvidence", i, "kind"],
          message: "M1 document-QA expectedEvidence is chunk only (ADR-0010)",
        });
      }
    }
  }

  const uniqueClaims = new Set(caseFile.expectedClaimTypes);
  if (uniqueClaims.size !== caseFile.expectedClaimTypes.length) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedClaimTypes"],
      message: "expectedClaimTypes must be unique",
    });
  }
});
export type EvalCase = z.infer<typeof EvalCase>;
