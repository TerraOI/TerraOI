import { describe, expect, it } from "vitest";

import { EvidenceRef, type Claim } from "@/contracts/answer";

import {
  bindClaimsToEvidence,
  type RunEvidence,
  type UnboundClaim,
  type UnboundEvidenceRef,
} from "./verify-binding";

/**
 * Verifier pass 1 (plan §12.1, deterministic binding, no model): the answer schema is already
 * enforced by the `Answer` contract, so this is the part that proves the *citations* are real — the
 * chunk was retrieved in this run, it belongs to the version it claims, and the quote occurs
 * verbatim in that chunk version. Pass 1 then derives the span from the quote (ADR-0008, #95): a
 * citation never arrives with an offset, and every locator a bound claim carries was computed here,
 * in UTF-16 code units, from the start of the chunk body.
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

function claim(overrides: Partial<UnboundClaim> & { id: string }): UnboundClaim {
  return {
    text: "Calibration comes first.",
    type: "source_fact",
    evidence: [
      {
        kind: "chunk",
        sourceVersionId: VERSION_A,
        chunkId: "chk-0001",
        quotedText: "Calibrate ",
      },
    ],
    authority: "vendor-manual",
    verificationStatus: "unverified",
    limitations: [],
    ...overrides,
  };
}

/** The chunk citations of a bound claim, narrowed for the assertions below. */
function chunkRefs(bound: Claim[]): Extract<EvidenceRef, { kind: "chunk" }>[] {
  return bound[0]?.evidence.filter((ref) => ref.kind === "chunk") as Extract<
    EvidenceRef,
    { kind: "chunk" }
  >[];
}

describe("pass 1 deterministic binding (plan §12.1)", () => {
  it("accepts a claim whose chunk, version and verbatim quote are real", () => {
    const result = bindClaimsToEvidence([claim({ id: "c1" })], EVIDENCE);
    expect(result.bound).toHaveLength(1);
    expect(result.bound[0]?.verificationStatus).toBe("binding_passed");
    expect(result.rejected).toEqual([]);
  });

  it("derives the span from the quote, and the derived span satisfies the frozen contract (§12.1, ADR-0008)", () => {
    const result = bindClaimsToEvidence(
      [claim({ id: "c1", evidence: [{ kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0001", quotedText: "the antenna" }] })],
      EVIDENCE,
    );
    const [ref] = chunkRefs(result.bound);
    // Measured from the start of `body_text`, in UTF-16 code units: `.slice()` gives the quote back.
    expect(ref?.span).toEqual({ startChar: 10, endChar: 21 });
    const body = EVIDENCE[0]?.text ?? "";
    expect(body.slice(ref?.span.startChar ?? 0, ref?.span.endChar ?? 0)).toBe("the antenna");
    // The platform-filled reference is a legal `EvidenceRef`, so anything downstream that parses the
    // answer sees a locator it can highlight.
    expect(() => EvidenceRef.parse(ref)).not.toThrow();
  });

  it("never trusts an offset a model might still send: the candidate shape has no span at all", () => {
    // The unbound citation type is `ChunkEvidence` minus `span`; a span here is an excess property,
    // so this line is the seam the compose schema enforces at parse time.
    const citation: UnboundEvidenceRef = {
      kind: "chunk",
      sourceVersionId: VERSION_A,
      chunkId: "chk-0001",
      quotedText: "Calibrate ",
    };
    expect("span" in citation).toBe(false);
    expect(bindClaimsToEvidence([claim({ id: "c1", evidence: [citation] })], EVIDENCE).bound).toHaveLength(1);
  });

  it("a quote that sits elsewhere in the chunk binds at where it actually is, not where it was guessed", () => {
    // Before ADR-0008 this was a rejection (`quote_not_verbatim` against a model-authored span). Now
    // there is no authored span to disagree with: the platform locates the text.
    const result = bindClaimsToEvidence(
      [claim({ id: "c6", evidence: [{ kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0001", quotedText: "before the" }] })],
      EVIDENCE,
    );
    expect(result.rejected).toEqual([]);
    expect(chunkRefs(result.bound)[0]?.span.startChar).toBe(22);
  });

  it("the first occurrence wins when a quote is ambiguous, and the shown text is the same either way", () => {
    const repeated: RunEvidence[] = [
      {
        chunkId: "chk-0003",
        sourceVersionId: VERSION_A,
        text: "Mark the waypoint. Mark the waypoint again before the drop.",
        dataClass: "internal",
      },
    ];
    const result = bindClaimsToEvidence(
      [claim({ id: "c13", evidence: [{ kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0003", quotedText: "Mark the waypoint" }] })],
      repeated,
    );
    expect(chunkRefs(result.bound)[0]?.span).toEqual({ startChar: 0, endChar: 17 });
  });

  it("a span crossing a non-BMP character is UTF-16 code units, and it slices back to the quote (#95)", () => {
    // The chunk body holds a 😀 (one Postgres `char`, two UTF-16 code units). A quote that crosses it
    // must still round-trip through `.slice()`, which is what the display uses. The offsets here are
    // deliberately stated in both axes: Postgres would call the emoji 1 character, JS counts 2.
    const emoji = "😀";
    const body = `Route ${emoji} across the ridge, then descend.`;
    const nonBmp: RunEvidence[] = [
      { chunkId: "chk-0004", sourceVersionId: VERSION_A, text: body, dataClass: "internal" },
    ];
    const quote = `😀 across`;
    const result = bindClaimsToEvidence(
      [claim({ id: "c14", evidence: [{ kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0004", quotedText: quote }] })],
      nonBmp,
    );
    const [ref] = chunkRefs(result.bound);
    expect(ref?.span).toEqual({ startChar: 6, endChar: 15 });
    expect(body.slice(ref?.span.startChar ?? 0, ref?.span.endChar ?? 0)).toBe(quote);
    // The two axes differ here, and the difference is the bug this ADR closes: 15 − 6 = 9 UTF-16
    // code units, while Postgres `char_length(quote)` counts the emoji once, i.e. 8 characters. The
    // contract says code units, because that is what `.slice()` and the display use.
    expect(quote.length).toBe(9);
  });

  it("rejects a claim citing a chunk that was not retrieved in this run", () => {
    const result = bindClaimsToEvidence(
      [claim({ id: "c2", evidence: [{ kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-9999", quotedText: "Calibrate " }] })],
      EVIDENCE,
    );
    expect(result.bound).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ claimId: "c2", reasons: ["chunk_not_in_run"] });
    expect(result.rejected[0]?.claim.verificationStatus).toBe("binding_failed");
  });

  it("rejects a chunk id that only exists under a different source version", () => {
    const result = bindClaimsToEvidence(
      [claim({ id: "c3", evidence: [{ kind: "chunk", sourceVersionId: VERSION_B, chunkId: "chk-0001", quotedText: "Calibrate " }] })],
      EVIDENCE,
    );
    expect(result.rejected[0]?.reasons).toContain("source_version_mismatch");
  });

  it("rejects a quote that is not verbatim, even when the wording is close", () => {
    const result = bindClaimsToEvidence(
      [claim({ id: "c5", evidence: [{ kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0001", quotedText: "calibrate the" }] })],
      EVIDENCE,
    );
    expect(result.rejected[0]?.reasons).toContain("quote_not_verbatim");
  });

  it("rejects a quote whose whitespace was collapsed before citing (no normalization is applied)", () => {
    // The chunk body carries a double space; a citation that tidied it away is not verbatim, and
    // pass 1 must not repair it, because repairing text here would silently move the locator too.
    const spaced: RunEvidence[] = [
      {
        chunkId: "chk-0005",
        sourceVersionId: VERSION_A,
        text: "Calibrate  the antenna before the first pass.",
        dataClass: "internal",
      },
    ];
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c5b",
          evidence: [
            { kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0005", quotedText: "Calibrate the antenna" },
          ],
        }),
      ],
      spaced,
    );
    expect(result.rejected[0]?.reasons).toContain("quote_not_verbatim");
  });

  it("the frozen contract now refuses a chunk citation with no quote (ADR-0008)", () => {
    // There is no longer a "locator without a quote" case: after pass 1 the quote is the thing being
    // verified, so a citation that quotes nothing is not representable in an `Answer`.
    expect(() =>
      EvidenceRef.parse({
        kind: "chunk",
        sourceVersionId: VERSION_A,
        chunkId: "chk-0001",
        span: { startChar: 0, endChar: 10 },
      }),
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

  it("one unboundable reference rejects the whole claim, and every reason is recorded for the audit (F40)", () => {
    const result = bindClaimsToEvidence(
      [
        claim({
          id: "c12",
          evidence: [
            { kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-0001", quotedText: "Calibrate " },
            { kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-9999", quotedText: "Calibrate " },
          ],
        }),
      ],
      EVIDENCE,
    );
    expect(result.bound).toEqual([]);
    expect(result.rejected[0]?.reasons).toEqual(["chunk_not_in_run"]);
  });
});
