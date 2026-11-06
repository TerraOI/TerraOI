import type { Claim, EvidenceRef } from "@/contracts/answer";
import type { DataClass } from "@/contracts/data-class";

/**
 * Verifier pass 1 (plan §12.1, "Deterministic binding (no model)"): prove that a citation is real —
 * the chunk was retrieved in this run, it belongs to the source version it claims, the span exists
 * in that chunk version, and a quote is verbatim. Nothing here reads meaning; that is pass 2
 * (T-215). The answer schema itself is enforced by the frozen `Answer`/`Claim` contract, so this is
 * the part a model can still get wrong on purpose (an invented `chunkId` parses perfectly).
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

export type BindingRejectReason =
  | "chunk_not_in_run"
  | "source_version_mismatch"
  | "span_out_of_range"
  | "quote_not_verbatim"
  | "evidence_kind_not_bound"
  | "no_evidence_bound";

export interface RejectedClaim {
  claimId: string;
  /** The claim with `verificationStatus: "binding_failed"`, kept for the run audit (F40). */
  claim: Claim;
  reasons: BindingRejectReason[];
}

export interface BindingResult {
  bound: Claim[];
  rejected: RejectedClaim[];
}

function refProblems(ref: EvidenceRef, evidence: Map<string, RunEvidence>): BindingRejectReason[] {
  if (ref.kind !== "chunk") {
    // Record and form-field evidence needs the read-tool layer (§10.1: no tool calls in M1). It is
    // not "wrong", it is unboundable here, so it fails closed instead of passing unverified.
    return ["evidence_kind_not_bound"];
  }
  const chunk = evidence.get(ref.chunkId);
  if (chunk === undefined) return ["chunk_not_in_run"];
  if (chunk.sourceVersionId !== ref.sourceVersionId) return ["source_version_mismatch"];

  const problems: BindingRejectReason[] = [];
  // `EvidenceRef`'s chunk variant **requires** a span, so "a citation with no locator" is not
  // representable: the frozen contract already refuses it at parse time. What pass 1 adds is the
  // check that the span and the quote agree with *this* chunk version.
  const { startChar, endChar } = ref.span;
  if (startChar > endChar || endChar > chunk.text.length) {
    problems.push("span_out_of_range");
    return problems;
  }
  if (ref.quotedText !== undefined && chunk.text.slice(startChar, endChar) !== ref.quotedText) {
    problems.push("quote_not_verbatim");
  }
  return problems;
}

export function bindClaimsToEvidence(
  claims: readonly Claim[],
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
    for (const ref of claim.evidence) {
      for (const problem of refProblems(ref, byChunkId)) reasons.add(problem);
    }

    if (reasons.size === 0) {
      bound.push({ ...claim, verificationStatus: "binding_passed" });
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
