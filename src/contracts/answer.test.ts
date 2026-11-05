import { describe, expect, it } from "vitest";

import { Answer } from "./answer";

// Plan §12.1 answer/evidence contract. Every displayed claim must be bound to evidence that was
// actually retrieved in this run.
const SOURCE_VERSION_ID = "77777777-7777-4777-8777-777777777777";

const chunkEvidence = () => ({
  kind: "chunk" as const,
  sourceVersionId: SOURCE_VERSION_ID,
  chunkId: "chk_01HTZK9",
  span: { startChar: 0, endChar: 38 },
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

  it("rejects a claim with no evidence for every non-inference type", () => {
    for (const type of ["source_fact", "requirement", "record_fact"] as const) {
      const answer = validAnswer();
      answer.claims = [claimWith({ type, evidence: [] })];
      expect(() => Answer.parse(answer)).toThrow();
    }
  });

  it("allows an inference only when its limitation is stated", () => {
    const withLimitation = validAnswer();
    withLimitation.claims = [
      claimWith({ type: "inference", evidence: [], limitations: ["Inferred from the survey plan, not measured."] }),
    ];
    expect(() => Answer.parse(withLimitation)).not.toThrow();

    const withoutLimitation = validAnswer();
    withoutLimitation.claims = [claimWith({ type: "inference", evidence: [], limitations: [] })];
    expect(() => Answer.parse(withoutLimitation)).toThrow();
  });

  it("refused and unavailable answers may carry no claims; an answered one may not", () => {
    for (const status of ["refused", "unavailable", "partial"] as const) {
      expect(() => Answer.parse({ ...validAnswer(), status, claims: [] })).not.toThrow();
    }
    expect(() => Answer.parse({ ...validAnswer(), status: "answered", claims: [] })).toThrow();
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
