import { describe, expect, it } from "vitest";

import { EvidenceRef, type Claim } from "@/contracts/answer";

import { bindClaimsToEvidence, type RunEvidence } from "./verify-binding";

/**
 * Verifier pass 1 (plan §12.1, deterministic binding, no model): the answer schema is already
 * enforced by the `Answer` contract, so this is the part that proves the *citations* are real —
 * chunk retrieved in this run, span exists in that chunk version, quote verbatim.
 */

const VERSION_A = "6e1a9a3c-1c2d-4a6b-9e5f-0a1b2c3d4e01";
const VERSION_B = "6e1a9a3c-1c2d-4a6b-9e5f-0a1b2c3d4e02";

const EVIDENCE: RunEvidence[] = [
  {
    chunkId: "chk-0001",
    sourceVersionId: VERSION_A,
    text: "Calibrate the antenna before the first pass.",
    dataClass: "internal",
  },
  {
    chunkId: "chk-0002",
    sourceVersionId: VERSION_B,
    text: "The survey log must record the operator and the line number.",
    dataClass: "client_confidential",
  },
];

function claim(overrides: Partial<Claim> & { id: string }): Claim {
  return {
    text: "Calibration comes first.",
    type: "source_fact",
    evidence: [
      {
        kind: "chunk",
        sourceVersionId: VERSION_A,
        chunkId: "chk-0001",
        span: { startChar: 0, endChar: 10 },
        quotedText: "Calibrate ",
      },
    ],
    authority: "vendor-manual",
    verificationStatus: "unverified",
    limitations: [],
    ...overrides,
  };
}

describe("pass 1 deterministic binding (plan §12.1)", () => {
  it("accepts a claim whose chunk, version, span and verbatim quote are all real", () => {
    const result = bindClaimsToEvidence([claim({ id: "c1" })], EVIDENCE);
    expect(result.bound).toHaveLength(1);
    expect(result.bound[0]?.verificationStatus).toBe("binding_passed");
    expect(result.rejected).toEqual([]);
  });

  it("rejects a claim citing a chunk that was not retrieved in this run", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c2",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_A,
              chunkId: "chk-9999",
              span: { startChar: 0, endChar: 10 },
              quotedText: "Calibrate ",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.bound).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ claimId: "c2", reasons: ["chunk_not_in_run"] });
    expect(result.rejected[0]?.claim.verificationStatus).toBe("binding_failed");
  });

  it("rejects a chunk id that only exists under a different source version", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c3",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_B,
              chunkId: "chk-0001",
              span: { startChar: 0, endChar: 10 },
              quotedText: "Calibrate ",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.rejected[0]?.reasons).toContain("source_version_mismatch");
  });

  it("rejects a span that does not exist in that chunk version", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c4",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_A,
              chunkId: "chk-0001",
              span: { startChar: 20, endChar: 200 },
              quotedText: "Calibrate ",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.rejected[0]?.reasons).toContain("span_out_of_range");
  });

  it("rejects a quote that is not verbatim, even when the wording is close", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c5",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_A,
              chunkId: "chk-0001",
              span: { startChar: 0, endChar: 10 },
              quotedText: "calibrate the",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.rejected[0]?.reasons).toContain("quote_not_verbatim");
  });

  it("rejects a quote that exists elsewhere in the chunk but not at the cited span", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c6",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_A,
              chunkId: "chk-0001",
              span: { startChar: 0, endChar: 10 },
              quotedText: "before the",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.rejected[0]?.reasons).toContain("quote_not_verbatim");
  });

  it("a span that exists in the chunk version binds, with or without a quote", () => {
    const withQuote = bindClaimsToEvidence(
      [
        claim({
          id: "c7",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_B,
              chunkId: "chk-0002",
              span: { startChar: 20, endChar: 40 },
              quotedText: "record the operator ",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(withQuote.bound[0]?.verificationStatus).toBe("binding_passed");

    const locatorOnly = bindClaimsToEvidence(
      [
        claim({
          id: "c8",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_B,
              chunkId: "chk-0002",
              span: { startChar: 0, endChar: 44 },
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(locatorOnly.bound[0]?.verificationStatus).toBe("binding_passed");
  });

  it("the frozen contract already refuses a chunk citation with no span (§12.1)", () => {
    // Pass 1 does not need a "no locator" rule: `EvidenceRef`'s chunk variant requires the span,
    // so an unlocatable citation never reaches a claim in the first place.
    expect(() =>
      EvidenceRef.parse({ kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0001" }),
    ).toThrow();
  });

  it("an inference may stand without evidence, but a source_fact may not (§12.1)", () => {
    const result = bindClaimsToEvidence(
      [
        claim({ id: "c9", type: "inference", evidence: [], limitations: ["Inferred from the procedure order."] }),
        claim({ id: "c10", type: "source_fact", evidence: [] }),
      ],
      EVIDENCE,
    );
    // The contract itself refuses the second claim; pass 1 never sees it as a candidate.
    expect(result.bound.map((entry) => entry.id)).toEqual(["c9"]);
    expect(result.rejected.map((entry) => entry.claimId)).toEqual(["c10"]);
    expect(result.rejected[0]?.reasons).toEqual(["no_evidence_bound"]);
  });

  it("record and form-field evidence is not bound in M1: there are no read tools yet (plan §10.1)", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c11",
          type: "record_fact",
          evidence: [
            {
              kind: "record",
              toolCallId: "tool-1",
              recordType: "uav.flight",
              recordId: "rec-1",
              recordVersion: 1,
              observedAt: "2026-11-04T08:00:00Z",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.rejected[0]?.reasons).toEqual(["evidence_kind_not_bound"]);
  });

  it("one bad reference rejects the whole claim, and every reason is recorded for the audit (F40)", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c12",
          evidence: [
            {
              kind: "chunk",
              sourceVersionId: VERSION_A,
              chunkId: "chk-0001",
              span: { startChar: 0, endChar: 10 },
              quotedText: "Calibrate ",
            },
            {
              kind: "chunk",
              sourceVersionId: VERSION_A,
              chunkId: "chk-0001",
              span: { startChar: 0, endChar: 400 },
              quotedText: "Calibrate ",
            },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.bound).toEqual([]);
    expect(result.rejected[0]?.reasons).toEqual(["span_out_of_range"]);
  });
});
