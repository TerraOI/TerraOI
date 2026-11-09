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

/**
 * A character span inside one specific chunk version, used for verbatim quote checks (F21).
 *
 * **Unit and origin are both fixed** (ADR-0008, decided on #95): the offsets count **UTF-16 code
 * units** — exactly what JavaScript `.length` and `.slice()` count — and they count from the start
 * of that chunk version's `knowledge_chunks.body_text`. Never from a rendered evidence pack, a
 * prompt, or a citation display. This is deliberate: every M1 producer and consumer of a span is
 * JavaScript in the Worker, so a missed conversion helper cannot drift the locator, and a quote
 * crossing a non-BMP character (a surrogate pair) slices back to itself on both sides.
 *
 * SQL never computes one. A database function such as `search_corpus_v1` or `exact_lookup_v1`
 * returns text; the Worker fills this field (pass 1 derives it, see
 * `src/platform/gateway/verify-binding.ts`). A span the model authored is not representable here,
 * because the compose candidate schema carries no span at all.
 */
const EvidenceSpan = z
  .strictObject({
    startChar: z.number().int().nonnegative(),
    endChar: z.number().int().nonnegative(),
  })
  .refine((span) => span.endChar >= span.startChar, {
    message: "endChar must not precede startChar",
  });

/**
 * The span is platform-filled; `quotedText` is **required**, because after ADR-0008 it is the thing
 * being verified: pass 1 locates it verbatim in the chunk body and derives the span from the first
 * exact occurrence. A citation with a locator and no quote is no longer expressible.
 */
export const ChunkEvidence = z.strictObject({
  kind: z.literal("chunk"),
  sourceVersionId: z.uuid(),
  chunkId: OpaqueId,
  span: EvidenceSpan,
  quotedText: z.string().min(1).max(4000),
});
export type ChunkEvidence = z.infer<typeof ChunkEvidence>;

export const RecordEvidence = z.strictObject({
  kind: z.literal("record"),
  toolCallId: OpaqueId,
  recordType: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  recordId: OpaqueId,
  recordVersion: z.number().int().positive(),
  observedAt: z.iso.datetime(),
});

export const FormFieldEvidence = z.strictObject({
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
    // Issue #16 N2: an `answered` result has to be grounded in something the platform can prove.
    // `claims.length > 0` was not enough — an answer made only of unevidenced inferences parsed.
    // The claim must also not be an `inference`, because an inference is by definition the part of
    // the answer that carries no evidence (§12.1, and AGENTS.md §4.5 "no unverified factual text").
    const grounded = answer.claims.some((claim) => claim.type !== "inference" && claim.evidence.length > 0);
    if (answer.status === "answered" && !grounded) {
      ctx.addIssue({
        code: "custom",
        path: ["claims"],
        message: "status 'answered' requires at least one non-inference claim with evidence (§12.1)",
      });
    }
  });
export type Answer = z.infer<typeof Answer>;
