import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalCase } from "@/contracts/eval-case";
import { PLATFORM_DEFAULT_CLEARANCE, narrowClearance } from "@/contracts/provider-route";

import { loadApprovedEvalCases } from "./load-cases";
import { orderEvalCases } from "./order-cases";
import { clearanceForEvalCase, runExpertEval } from "./run";

const APPROVER = "00000000-0000-4000-8000-0000000000a2";
const APPROVED_AT = "2026-11-21T12:00:00.000Z";

function approvedCase(overrides: Partial<EvalCase> & Pick<EvalCase, "caseId">): EvalCase {
  return {
    schemaVersion: 1,
    expertKey: "uav-expert",
    status: "approved",
    origin: "expert_written",
    caseType: "answerable",
    question: "Synthetic question for F35 order tests.",
    expectedAnswerPoints: ["Names the synthetic check the fixture requires."],
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

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orderEvalCases (F35 deterministic order)", () => {
  it("sorts the same inputs into the same caseId order every time", () => {
    const cases = [
      approvedCase({ caseId: "UAV-E030" }),
      approvedCase({ caseId: "UAV-E002" }),
      approvedCase({ caseId: "UAV-E010" }),
    ];
    const first = orderEvalCases(cases).map((c) => c.caseId);
    const second = orderEvalCases([...cases].reverse()).map((c) => c.caseId);
    expect(first).toEqual(["UAV-E002", "UAV-E010", "UAV-E030"]);
    // Code-unit order: upper case sorts before lower case on every runner.
    expect(orderEvalCases([approvedCase({ caseId: "uav-a" }), approvedCase({ caseId: "UAV-B" })]).map((c) => c.caseId)).toEqual([
      "UAV-B",
      "uav-a",
    ]);
    expect(second).toEqual(first);
  });
});

describe("loadApprovedEvalCases (F35 ignores drafts)", () => {
  it("loads only approved files from the expert folder and skips drafts/", () => {
    const root = mkdtempSync(join(tmpdir(), "terraoi-evals-"));
    tempRoots.push(root);
    const expertDir = join(root, "uav-expert");
    const draftsDir = join(expertDir, "drafts");
    mkdirSync(draftsDir, { recursive: true });

    const approved = approvedCase({ caseId: "UAV-E100" });
    const drafted = {
      ...approvedCase({ caseId: "UAV-E101", status: "drafted", approvedBy: null, approvedAt: null }),
    };
    writeFileSync(join(expertDir, "UAV-E100.json"), `${JSON.stringify(approved, null, 2)}\n`);
    writeFileSync(join(draftsDir, "UAV-E101.json"), `${JSON.stringify(drafted, null, 2)}\n`);

    const loaded = loadApprovedEvalCases(root, "uav-expert");
    expect(loaded.map((c) => c.caseId)).toEqual(["UAV-E100"]);
  });

  it("refuses a drafted case placed in the approved folder instead of running it", () => {
    const root = mkdtempSync(join(tmpdir(), "terraoi-evals-"));
    tempRoots.push(root);
    const expertDir = join(root, "uav-expert");
    mkdirSync(expertDir, { recursive: true });
    const drafted = approvedCase({ caseId: "UAV-E102", status: "drafted", approvedBy: null, approvedAt: null });
    writeFileSync(join(expertDir, "UAV-E102.json"), `${JSON.stringify(drafted, null, 2)}\n`);
    expect(() => loadApprovedEvalCases(root, "uav-expert")).toThrow(/status=approved/);
  });
});

describe("runExpertEval (F35 run row binding)", () => {
  it("names expert version, chain configuration and corpus generation on the run row", () => {
    const cases = [
      approvedCase({ caseId: "UAV-E030" }),
      approvedCase({ caseId: "UAV-E002" }),
    ];
    const chainConfig = { compose: ["local_box", "workers_ai", "claude"] as const };
    const run = runExpertEval({
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig,
      corpusGeneration: "synth-corpus-2026-11-21",
      cases,
    });

    expect(run.expertKey).toBe("uav-expert");
    expect(run.expertVersion).toBe("1.0.0-test");
    expect(run.chainConfig).toEqual(chainConfig);
    expect(run.corpusGeneration).toBe("synth-corpus-2026-11-21");
    expect(run.caseOrder).toEqual(["UAV-E002", "UAV-E030"]);
    expect(run.status).toBe("completed");
  });

  it("produces the same caseOrder for the same inputs", () => {
    const cases = [
      approvedCase({ caseId: "UAV-E009" }),
      approvedCase({ caseId: "UAV-E001" }),
      approvedCase({ caseId: "UAV-E015" }),
    ];
    const input = {
      expertKey: "uav-expert" as const,
      expertVersion: "1.0.0-test",
      chainConfig: { compose: ["local_box"] as const },
      corpusGeneration: "gen-a",
      cases,
    };
    expect(runExpertEval(input).caseOrder).toEqual(runExpertEval({ ...input, cases: [...cases].reverse() }).caseOrder);
  });
});

describe("clearanceForEvalCase (never widen for a case)", () => {
  it("never widens platform clearance for client_confidential cases", () => {
    const matrix = clearanceForEvalCase({
      dataClass: "client_confidential",
      tenantPolicy: {
        // Attempted widen: DeepSeek/OpenRouter are not on the platform client_confidential list.
        client_confidential: ["local_box", "claude", "deepseek", "openrouter"],
      },
    });
    expect(matrix.client_confidential).not.toContain("deepseek");
    expect(matrix.client_confidential).not.toContain("openrouter");
    expect(matrix.client_confidential).toEqual(
      narrowClearance({ client_confidential: ["local_box", "claude", "deepseek", "openrouter"] })
        .client_confidential,
    );
    expect(matrix.client_confidential.every((p) => PLATFORM_DEFAULT_CLEARANCE.client_confidential.includes(p))).toBe(
      true,
    );
  });
});

describe("runExpertEval scoring (F35 per-case results)", () => {
  it("scores each case and binds results to the run corpus generation", () => {
    const cases = [
      approvedCase({ caseId: "UAV-E002", expectedAnswerStatus: "answered" }),
      approvedCase({
        caseId: "UAV-E009",
        caseType: "must_refuse",
        expectedAnswerStatus: "refused",
        expectedRefusalKey: "out_of_scope",
        isolationBait: true,
        adversarialClass: "cross_tenant_bait",
      }),
    ];
    const run = runExpertEval({
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig: { compose: ["local_box"] },
      corpusGeneration: "gen-bound",
      cases,
      askCase: ({ evalCase }) => {
        if (evalCase.isolationBait) {
          return {
            kind: "answer",
            status: "refused",
            refusalKey: "out_of_scope",
            providerKeysUsed: ["local_box"],
          };
        }
        return { kind: "answer", status: "answered", providerKeysUsed: ["local_box"] };
      },
    });
    expect(run.status).toBe("completed");
    expect(run.results.map((r) => r.caseId)).toEqual(["UAV-E002", "UAV-E009"]);
    expect(run.results.every((r) => r.score === 1 && r.failureClass === null)).toBe(true);
  });

  it("records provider_outage without a scored zero", () => {
    const run = runExpertEval({
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig: {},
      corpusGeneration: "gen-a",
      cases: [approvedCase({ caseId: "UAV-E001" })],
      askCase: () => ({ kind: "infrastructure_failure", providerKeysUsed: ["claude"] }),
    });
    expect(run.results[0]?.score).toBeNull();
    expect(run.results[0]?.failureClass).toBe("provider_outage");
  });

  it("discards the run when corpus generation drifts mid-run", () => {
    const run = runExpertEval({
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig: {},
      corpusGeneration: "gen-a",
      cases: [approvedCase({ caseId: "UAV-E001" }), approvedCase({ caseId: "UAV-E002" })],
      askCase: ({ evalCase }) => ({
        kind: "answer",
        status: "answered",
        providerKeysUsed: ["local_box"],
        observedCorpusGeneration: evalCase.caseId === "UAV-E002" ? "gen-b" : "gen-a",
      }),
    });
    expect(run.status).toBe("discarded");
    expect(run.results).toEqual([]);
  });

  it("a client_confidential case produces zero DeepSeek/OpenRouter calls in the mock", () => {
    const used: string[] = [];
    const confidential = approvedCase({
      caseId: "UAV-E050",
      dataClass: "client_confidential",
    });
    runExpertEval({
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig: {},
      corpusGeneration: "gen-a",
      cases: [confidential],
      tenantPolicy: {
        client_confidential: ["local_box", "claude", "deepseek", "openrouter"],
      },
      askCase: ({ clearance, evalCase }) => {
        const chain = clearance[evalCase.dataClass];
        for (const key of chain) {
          used.push(key);
        }
        // Mock only calls the first cleared provider — never DeepSeek/OpenRouter.
        const first = chain[0];
        if (!first) {
          return { kind: "infrastructure_failure", providerKeysUsed: [] };
        }
        return { kind: "answer", status: "answered", providerKeysUsed: [first] };
      },
    });
    expect(used).not.toContain("deepseek");
    expect(used).not.toContain("openrouter");
    expect(used).toEqual(["local_box", "claude"]);
  });

  it("refuses a mock that tries to call a provider outside clearance", () => {
    expect(() =>
      runExpertEval({
        expertKey: "uav-expert",
        expertVersion: "1.0.0-test",
        chainConfig: {},
        corpusGeneration: "gen-a",
        cases: [approvedCase({ caseId: "UAV-E050", dataClass: "client_confidential" })],
        askCase: () => ({
          kind: "answer",
          status: "answered",
          providerKeysUsed: ["deepseek"],
        }),
      }),
    ).toThrow(/not cleared for data class/);
  });
});

describe("clearanceForEvalCase (a platform override never widens)", () => {
  it("narrows a wider platform override against the platform default", () => {
    const wide = {
      ...PLATFORM_DEFAULT_CLEARANCE,
      client_confidential: ["local_box", "claude", "deepseek", "openrouter"],
    } as typeof PLATFORM_DEFAULT_CLEARANCE;
    const matrix = clearanceForEvalCase({ dataClass: "client_confidential", platform: wide });
    expect(matrix.client_confidential).toEqual(PLATFORM_DEFAULT_CLEARANCE.client_confidential);
  });
});
