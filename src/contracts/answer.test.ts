import { describe, expect, it } from "vitest";

import { Answer } from "./answer";

// Plan §12.1 answer/evidence contract. Every displayed claim must be bound to evidence that was
// actually retrieved in this run.
const SOURCE_VERSION_ID = "77777777-7777-4777-8777-777777777777";

const chunkEvidence = () => ({
  kind: "chunk" as const,
  sourceVersionId: SOURCE_VERSION_ID,
  chunkId: "chk_01HTZK9",
  span: { startChar: 0, endChar: 36 },
  // Required since ADR-0008: pass 1 derives `span` by locating this quote in the chunk body, so a
  // citation that quotes nothing has nothing to verify and is not representable in an `Answer`.
  quotedText: "Calibrate the unit before each line.",
});

// Fixtures are loose on purpose: negative cases pass values the parser must reject.
const validAnswer = (): Record<string, unknown> => ({
  status: "answered",
  runId: "66666666-6666-4666-8666-666666666666",
  expertVersions: ["gpr-expert@1.0.0"],
  corpusGenerations: [3],
  asOf: "2026-11-04T12:00:05Z",
  summary: "Three setup checks apply to this job.",
  dataClass: "client_confidential",
  claims: [
    {
      id: "c1",
      text: "Calibrate the unit before each line.",
      type: "requirement",
      evidence: [chunkEvidence()],
      authority: "company_sop",
      verificationStatus: "supported",
      limitations: [],
    },
  ],
  unknowns: ["Site conditions for line 2 are not in the authorized documents."],
  conflicts: [],
  truncation: [],
});

const claimWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: "c1",
  text: "A claim.",
  type: "source_fact",
  evidence: [chunkEvidence()],
  authority: "vendor_manual",
  verificationStatus: "binding_passed",
  limitations: [],
  ...overrides,
});

describe("Answer (plan §12.1)", () => {
  it("parses a fully evidenced answer", () => {
    const parsed = Answer.parse(validAnswer());
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.unknowns.length).toBeGreaterThan(0);
  });

  it("requires the mandatory unknowns field and a data class (plan §6.2 propagation)", () => {
    expect(() => Answer.parse({ ...validAnswer(), unknowns: undefined })).toThrow();
    expect(() => Answer.parse({ ...validAnswer(), dataClass: undefined })).toThrow();
    expect(() => Answer.parse({ ...validAnswer(), dataClass: "secret" })).toThrow();
  });

  it("refuses a chunk citation that quotes nothing, and one with no locator (ADR-0008, #95)", () => {
    // Both halves of the pair: a locator without a quote cannot be replayed, and a quote without a
    // locator cannot be highlighted. The contract keeps both required; only pass 1 fills the span.
    const locatorOnly = { ...chunkEvidence() } as Record<string, unknown>;
    delete locatorOnly.quotedText;
    const noLocator = { ...chunkEvidence() } as Record<string, unknown>;
    delete noLocator.span;
    for (const broken of [locatorOnly, noLocator]) {
      const answer = validAnswer();
      answer.claims = [claimWith({ evidence: [broken] })];
      expect(() => Answer.parse(answer)).toThrow();
    }
  });

  it("rejects a claim with no evidence for every non-inference type", () => {
    for (const type of ["source_fact", "requirement", "record_fact"] as const) {
      const answer = validAnswer();
      answer.claims = [claimWith({ type, evidence: [] })];
      expect(() => Answer.parse(answer)).toThrow();
    }
  });

  it("allows an inference only when its limitation is stated", () => {
    const withLimitation = validAnswer();
    withLimitation.status = "partial";
    withLimitation.claims = [
      claimWith({ type: "inference", evidence: [], limitations: ["Inferred from the survey plan, not measured."] }),
    ];
    expect(() => Answer.parse(withLimitation)).not.toThrow();

    const withoutLimitation = validAnswer();
    withoutLimitation.status = "partial";
    withoutLimitation.claims = [claimWith({ type: "inference", evidence: [], limitations: [] })];
    expect(() => Answer.parse(withoutLimitation)).toThrow();
  });

  // Issue #16 N2: the message said "evidenced" but only counted claims, so an `answered` result
  // built entirely from inferences parsed. Inferences are the part of an answer the platform
  // cannot prove, so they cannot be what makes a result `answered` (§12.1, AGENTS.md §4.5).
  it("will not call an answer 'answered' on inferences alone", () => {
    const oneInference = validAnswer();
    oneInference.claims = [
      claimWith({ type: "inference", evidence: [], limitations: ["Not stated in any authorized document."] }),
    ];
    expect(() => Answer.parse(oneInference)).toThrow(/non-inference claim with evidence/);

    const twoInferences = validAnswer();
    twoInferences.claims = [
      claimWith({ id: "c1", type: "inference", evidence: [], limitations: ["Inferred."] }),
      claimWith({ id: "c2", type: "inference", evidence: [], limitations: ["Also inferred."] }),
    ];
    expect(() => Answer.parse(twoInferences)).toThrow();

    // An evidenced claim alongside inferences is fine — that is a normal grounded answer.
    const groundedPlusInference = validAnswer();
    groundedPlusInference.claims = [
      claimWith({ id: "c1", type: "source_fact" }),
      claimWith({ id: "c2", type: "inference", evidence: [], limitations: ["Inferred from c1."] }),
    ];
    expect(() => Answer.parse(groundedPlusInference)).not.toThrow();

    // A non-inference claim with an empty evidence list is refused by the claim rule itself.
    const emptyEvidence = validAnswer();
    emptyEvidence.claims = [claimWith({ id: "c1", type: "source_fact", evidence: [] })];
    expect(() => Answer.parse(emptyEvidence)).toThrow();
  });

  it("refused and unavailable answers may carry no claims; an answered one may not", () => {
    // ADR-0009 changed this line's `refused`/`unavailable` rows only in one respect: a refusal now has
    // to name the sentence it used. The claim rule it pins is untouched.
    expect(() => Answer.parse({ ...validAnswer(), status: "partial", claims: [] })).not.toThrow();
    expect(() =>
      Answer.parse({ ...validAnswer(), status: "refused", claims: [], refusalKey: "no_evidence" }),
    ).not.toThrow();
    expect(() =>
      Answer.parse({ ...validAnswer(), status: "unavailable", claims: [], refusalKey: "unavailable" }),
    ).not.toThrow();
    expect(() => Answer.parse({ ...validAnswer(), status: "answered", claims: [] })).toThrow();
  });

  // ADR-0009 (#97): every refusal sentence a user sees must be true for the code path that chose it,
  // and the run has to record which one it was. `refusalKey` is the closed set of the four templates
  // an expert definition must carry, paired with `status` in both directions.
  describe("refusalKey pairs with status (ADR-0009, #97)", () => {
    it("is allowed on a refusal and names the sentence the employee was shown", () => {
      for (const [status, refusalKey] of [
        ["refused", "no_evidence"],
        ["refused", "insufficient_support"],
        ["refused", "out_of_scope"],
        ["unavailable", "unavailable"],
      ] as const) {
        const parsed = Answer.parse({ ...validAnswer(), status, claims: [], refusalKey });
        expect(parsed.status).toBe(status);
        expect(parsed.refusalKey).toBe(refusalKey);
      }
    });

    it("is forbidden on an answer the employee actually got: answered and partial carry no refusal sentence", () => {
      for (const status of ["answered", "partial"] as const) {
        for (const refusalKey of ["no_evidence", "insufficient_support", "out_of_scope", "unavailable"] as const) {
          // Matched on the rule's own words, not on any throw: before the field existed the parser
          // rejected `refusalKey` as an unrecognized key, which would have made this pass vacuously.
          expect(() => Answer.parse({ ...validAnswer(), status, refusalKey })).toThrow(
            /refusalKey is set only when/,
          );
        }
      }
    });

    it("is required when the employee was refused: an unnamed refusal cannot be replayed, scored, or audited", () => {
      for (const status of ["refused", "unavailable"] as const) {
        expect(() => Answer.parse({ ...validAnswer(), status, claims: [] })).toThrow(
          /a refused or unavailable answer must name the sentence/,
        );
      }
    });

    it("is a closed set: an invented key, prose with the words in it, and an empty string all fail", () => {
      for (const refusalKey of ["no_docs", "insufficient support", ""] as const) {
        expect(() =>
          Answer.parse({ ...validAnswer(), status: "refused", claims: [], refusalKey }),
        ).toThrow();
      }
      expect(() =>
        Answer.parse({ ...validAnswer(), status: "refused", claims: [], refusalKey: null }),
      ).toThrow();
      expect(() =>
        Answer.parse({ ...validAnswer(), status: "refused", claims: [], refusalKey: "no_evidence" }),
      ).not.toThrow();
    });
  });

  it("validates evidence: spans are ordered and every evidence row is typed", () => {
    expect(() =>
      Answer.parse({
        ...validAnswer(),
        claims: [
          claimWith({ evidence: [{ ...chunkEvidence(), span: { startChar: 40, endChar: 12 } }] }),
        ],
      }),
    ).toThrow();
    expect(() =>
      Answer.parse({
        ...validAnswer(),
        claims: [claimWith({ evidence: [{ chunkId: "chk_1" }] })],
      }),
    ).toThrow();
  });

  it("accepts record and form-field evidence (plan §7.6, F18)", () => {
    const answer = validAnswer();
    answer.claims = [
      claimWith({
        type: "record_fact",
        evidence: [
          {
            kind: "record",
            toolCallId: "tool_01",
            recordType: "gpr_unit",
            recordId: "unit-114",
            recordVersion: 4,
            observedAt: "2026-11-04T12:00:02Z",
          },
        ],
      }),
      claimWith({
        id: "c2",
        evidence: [
          {
            kind: "form_field",
            submissionId: "88888888-8888-4888-8888-888888888888",
            fieldPath: "antenna_model",
            templateVersion: "2026-10-01",
          },
        ],
      }),
    ];
    expect(() => Answer.parse(answer)).not.toThrow();
  });

  it("keeps provider names, keys and durable URLs out of the answer contract (plan §4.4, §9.3)", () => {
    expect(() => Answer.parse({ ...validAnswer(), providerName: "claude" })).toThrow();
    expect(() => Answer.parse({ ...validAnswer(), model: "gpt-x" })).toThrow();
    expect(() =>
      Answer.parse({
        ...validAnswer(),
        claims: [claimWith({ evidence: [{ ...chunkEvidence(), url: "https://objects/…?token=…" }] })],
      }),
    ).toThrow();
  });

  it("rejects an unknown claim type or verification status", () => {
    expect(() =>
      Answer.parse({ ...validAnswer(), claims: [claimWith({ type: "guess" as never })] }),
    ).toThrow();
    expect(() =>
      Answer.parse({
        ...validAnswer(),
        claims: [claimWith({ verificationStatus: "probably_right" as never })],
      }),
    ).toThrow();
  });
});
