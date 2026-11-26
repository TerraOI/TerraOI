import { describe, expect, it } from "vitest";

import type { EvalCase } from "@/contracts/eval-case";

import type { EvalCaseScore } from "./score";
import { evaluatePublishGate, PILOT_ENTRY_THRESHOLDS } from "./thresholds";

const APPROVER = "00000000-0000-4000-8000-0000000000a2";
const APPROVED_AT = "2026-11-21T12:00:00.000Z";

function approved(overrides: Partial<EvalCase> & Pick<EvalCase, "caseId">): EvalCase {
  return {
    schemaVersion: 1,
    expertKey: "uav-expert",
    status: "approved",
    origin: "expert_written",
    caseType: "answerable",
    question: "Synthetic question.",
    expectedAnswerPoints: ["Point."],
    expectedClaimTypes: ["source_fact"],
    expectedAnswerStatus: "answered",
    citationRequired: false,
    dataClass: "internal",
    projectScope: null,
    forbiddenClaims: [],
    isolationBait: false,
    adversarialClass: null,
    expectedSource: "SYNTH-UAV-MAN-A17 page:1",
    expectedFixtures: ["SYNTH-UAV-MAN-A17"],
    expectedEvidence: [],
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    draftedBy: "builder-agent",
    draftedOn: "2026-11-21",
    ...overrides,
  };
}

function pass(caseId: string): EvalCaseScore {
  return { caseId, score: 1, failureClass: null, evidence: [], providerKeysUsed: ["local_box"] };
}

function fail(caseId: string): EvalCaseScore {
  return {
    caseId,
    score: 0,
    failureClass: "isolation_bait_not_refused",
    evidence: [],
    providerKeysUsed: ["local_box"],
  };
}

/** Build a set that meets every pilot-entry count when all results pass. */
function meetingSet(): { cases: EvalCase[]; results: EvalCaseScore[] } {
  const cases: EvalCase[] = [];
  const results: EvalCaseScore[] = [];

  for (let i = 1; i <= 25; i += 1) {
    const caseId = `UAV-A${String(i).padStart(3, "0")}`;
    cases.push(approved({ caseId, caseType: "answerable" }));
    results.push(pass(caseId));
  }
  for (let i = 1; i <= 10; i += 1) {
    const caseId = `UAV-R${String(i).padStart(3, "0")}`;
    cases.push(
      approved({
        caseId,
        caseType: i % 2 === 0 ? "must_refuse" : "needs_clarification",
        expectedAnswerStatus: "refused",
        expectedRefusalKey: "out_of_scope",
      }),
    );
    results.push(pass(caseId));
  }
  for (let i = 1; i <= 5; i += 1) {
    const caseId = `UAV-B${String(i).padStart(3, "0")}`;
    cases.push(
      approved({
        caseId,
        caseType: "must_refuse",
        expectedAnswerStatus: "refused",
        expectedRefusalKey: "out_of_scope",
        isolationBait: true,
        adversarialClass: "cross_tenant_bait",
      }),
    );
    results.push(pass(caseId));
  }
  // 25 + 10 + 5 = 40
  return { cases, results };
}

describe("evaluatePublishGate (F36 / §14.1)", () => {
  it("allows publication when every pilot-entry threshold passes", () => {
    const { cases, results } = meetingSet();
    const verdict = evaluatePublishGate({
      approvedCases: cases,
      results,
      recallAt10: 0.9,
      unsupportedNormativeClaimsDisplayed: 0,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.previousVersionRemainsSelectable).toBe(false);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  it("refuses when approved count is short and keeps the previous version selectable", () => {
    const { cases, results } = meetingSet();
    const short = cases.slice(0, PILOT_ENTRY_THRESHOLDS.minApprovedCases - 1);
    const verdict = evaluatePublishGate({
      approvedCases: short,
      results: results.filter((r) => short.some((c) => c.caseId === r.caseId)),
      recallAt10: 0.9,
      unsupportedNormativeClaimsDisplayed: 0,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.previousVersionRemainsSelectable).toBe(true);
    expect(verdict.checks.find((c) => c.id === "approved_count")?.passed).toBe(false);
  });

  it("excludes origin=pilot from pilot-entry approved counts (#102)", () => {
    const { cases, results } = meetingSet();
    const withPilot = [
      ...cases.slice(0, 39),
      approved({ caseId: "UAV-PILOT-01", origin: "pilot" }),
    ];
    const verdict = evaluatePublishGate({
      approvedCases: withPilot,
      results: [...results.slice(0, 39), pass("UAV-PILOT-01")],
      recallAt10: 0.9,
      unsupportedNormativeClaimsDisplayed: 0,
    });
    expect(verdict.checks.find((c) => c.id === "approved_count")?.actual).toBe("39");
    expect(verdict.allowed).toBe(false);
  });

  it("fails when any isolation bait case does not refuse", () => {
    const { cases, results } = meetingSet();
    const baitId = cases.find((c) => c.isolationBait)!.caseId;
    const broken = results.map((r) => (r.caseId === baitId ? fail(baitId) : r));
    const verdict = evaluatePublishGate({
      approvedCases: cases,
      results: broken,
      recallAt10: 0.9,
      unsupportedNormativeClaimsDisplayed: 0,
    });
    expect(verdict.checks.find((c) => c.id === "isolation_bait_pass_rate")?.passed).toBe(false);
    expect(verdict.allowed).toBe(false);
    expect(verdict.previousVersionRemainsSelectable).toBe(true);
  });

  it("fails when Recall@10 is below 85% or unavailable", () => {
    const { cases, results } = meetingSet();
    const low = evaluatePublishGate({
      approvedCases: cases,
      results,
      recallAt10: 0.8,
      unsupportedNormativeClaimsDisplayed: 0,
    });
    expect(low.checks.find((c) => c.id === "recall_at_10")?.passed).toBe(false);

    const missing = evaluatePublishGate({
      approvedCases: cases,
      results,
      unsupportedNormativeClaimsDisplayed: 0,
    });
    expect(missing.checks.find((c) => c.id === "recall_at_10")?.actual).toBe("unavailable");
    expect(missing.allowed).toBe(false);
  });

  it("fails when unsupported normative claims were displayed", () => {
    const { cases, results } = meetingSet();
    const verdict = evaluatePublishGate({
      approvedCases: cases,
      results,
      recallAt10: 0.9,
      unsupportedNormativeClaimsDisplayed: 1,
    });
    expect(verdict.checks.find((c) => c.id === "unsupported_normative_claims")?.passed).toBe(false);
    expect(verdict.allowed).toBe(false);
  });

  it("counts answerable cases with no result or a null score as misses (round 1 on #244)", () => {
    const { cases, results } = meetingSet();
    // Keep only one answerable result (a pass); the other 24 answerable cases have none.
    const sparse = results.filter((r) => !r.caseId.startsWith("UAV-A") || r.caseId === "UAV-A001");
    const verdict = evaluatePublishGate({
      approvedCases: cases,
      results: sparse,
      recallAt10: 0.9,
      unsupportedNormativeClaimsDisplayed: 0,
    });
    const rate = verdict.checks.find((c) => c.id === "answerable_correct_rate");
    expect(rate?.passed).toBe(false);
    expect(rate?.actual).toBe("1/25 (4.0%)");
    expect(verdict.allowed).toBe(false);

    const nulled = results.map((r) =>
      r.caseId.startsWith("UAV-A") && r.caseId !== "UAV-A001" ? { ...r, score: null } : r,
    );
    expect(
      evaluatePublishGate({
        approvedCases: cases,
        results: nulled,
        recallAt10: 0.9,
        unsupportedNormativeClaimsDisplayed: 0,
      }).allowed,
    ).toBe(false);
  });
});
