import type { ChunkEvidence, Claim, EvidenceRef } from "@/contracts/answer";
import type { DataClass } from "@/contracts/data-class";

/**
 * Verifier pass 1 (plan §12.1, "Deterministic binding (no model)"): prove that a citation is real —
 * the chunk was retrieved in this run, it belongs to the source version it claims, and the quoted
 * text occurs **verbatim** in that chunk version. Pass 1 then **derives the span** from the quote
 * (ADR-0008, decided on #95): a model cites a `chunkId` and the exact text, never an offset, and the
 * platform computes the locator. Nothing here reads meaning; that is pass 2 (T-215). The answer
 * schema itself is enforced by the frozen `Answer`/`Claim` contract, so this is the part a model can
 * still get wrong on purpose (an invented `chunkId` parses perfectly).
 *
 * One reference that fails rejects the **whole claim**: a claim backed by one real and one invented
 * citation is not a mostly-true claim, it is an unverified one. The reasons are audit content (F40)
 * and never employee-visible text (§9.3) — the caller renders "some claims were withheld", not
 * these codes.
 */

/** A chunk retrieved in this run, authorized now, with the version its text belongs to. */
export interface RunEvidence {
  chunkId: string;
  sourceVersionId: string;
  text: string;
  dataClass: DataClass;
}

/**
 * What a model may cite. The chunk variant is `ChunkEvidence` with `span` removed: a model-authored
 * offset is not representable at this boundary, because "character offset" has two honest answers
 * (UTF-16 code units, as JavaScript measures `body_text`; and Postgres characters, as the database
 * counts it) and a quote taken from a rendered evidence pack matches neither. Pass 1 fills the span
 * in, so every `Claim`-typed consumer downstream sees the frozen contract's shape and nothing else.
 */
export type UnboundChunkCitation = Omit<ChunkEvidence, "span">;
export type UnboundEvidenceRef = UnboundChunkCitation | Exclude<EvidenceRef, { kind: "chunk" }>;
export type UnboundClaim = Omit<Claim, "evidence"> & { evidence: readonly UnboundEvidenceRef[] };

export type BindingRejectReason =
  | "chunk_not_in_run"
  | "source_version_mismatch"
  | "quote_not_verbatim"
  | "evidence_kind_not_bound"
  | "no_evidence_bound";
// `span_out_of_range` is gone: it had no producer left, because the only span in a bound claim is
// one pass 1 derived from text that is by construction inside the chunk. A reason no code path can
// choose is audit noise (the same rule #97 applied to the refusal vocabulary).

export interface RejectedClaim {
  claimId: string;
  /**
   * The claim exactly as it was returned, with `verificationStatus: "binding_failed"`, kept for the
   * run audit (F40): replay needs the citation the model actually made, including one that is not a
   * legal `EvidenceRef` yet.
   */
  claim: UnboundClaim & { verificationStatus: "binding_failed" };
  reasons: BindingRejectReason[];
}

export interface BindingResult {
  /** Claims that passed binding, each carrying the spans pass 1 derived (ADR-0008). */
  bound: Claim[];
  rejected: RejectedClaim[];
}

interface RefBinding {
  /** The citation with its derived span, when the reference is bindable at all. */
  ref?: EvidenceRef;
  reasons: BindingRejectReason[];
}

function bindRef(ref: UnboundEvidenceRef, evidence: Map<string, RunEvidence>): RefBinding {
  if (ref.kind !== "chunk") {
    // Record and form-field evidence needs the read-tool layer (§10.1: no tool calls in M1). It is
    // not "wrong", it is unboundable here, so it fails closed instead of passing unverified.
    return { reasons: ["evidence_kind_not_bound"] };
  }
  const chunk = evidence.get(ref.chunkId);
  if (chunk === undefined) return { reasons: ["chunk_not_in_run"] };
  if (chunk.sourceVersionId !== ref.sourceVersionId) return { reasons: ["source_version_mismatch"] };

  // `indexOf` searches the chunk body as stored: no normalization, no trimming, no case folding. A
  // quote the platform "cleaned up" first is not a verbatim quote (§4.5), and the offsets it returns
  // are UTF-16 code units — the unit `EvidenceSpan` promises, counted from the start of the body.
  const startChar = chunk.text.indexOf(ref.quotedText);
  if (startChar < 0) return { reasons: ["quote_not_verbatim"] };

  // First occurrence is a rule, not an accident: when a quote appears twice, either location shows
  // the same text, so the stored span and the highlight agree with each other either way. The
  // length is taken from the quote itself, so a quote crossing a non-BMP character (a surrogate
  // pair, which `.length` counts as 2) still slices back to exactly what was cited.
  return {
    ref: { ...ref, span: { startChar, endChar: startChar + ref.quotedText.length } },
    reasons: [],
  };
}

export function bindClaimsToEvidence(
  claims: readonly UnboundClaim[],
  evidence: readonly RunEvidence[],
): BindingResult {
  const byChunkId = new Map(evidence.map((chunk) => [chunk.chunkId, chunk]));
  const bound: Claim[] = [];
  const rejected: RejectedClaim[] = [];

  for (const claim of claims) {
    const reasons = new Set<BindingRejectReason>();
    if (claim.evidence.length === 0 && claim.type !== "inference") {
      reasons.add("no_evidence_bound");
    }
    const boundRefs: EvidenceRef[] = [];
    for (const ref of claim.evidence) {
      const binding = bindRef(ref, byChunkId);
      for (const reason of binding.reasons) reasons.add(reason);
      if (binding.ref !== undefined) boundRefs.push(binding.ref);
    }

    if (reasons.size === 0) {
      // A claim with no evidence and type `inference` binds with an empty evidence list; the frozen
      // contract allows exactly that (answer.ts superRefine).
      bound.push({ ...claim, evidence: boundRefs, verificationStatus: "binding_passed" });
    } else {
      rejected.push({
        claimId: claim.id,
        claim: { ...claim, verificationStatus: "binding_failed" },
        reasons: [...reasons],
      });
    }
  }

  return { bound, rejected };
}
