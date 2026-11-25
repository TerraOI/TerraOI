import { describe, expect, it } from "vitest";

import type { AttemptRecord } from "@/platform/gateway/call";
import {
  answered,
  fakeAdapter,
  FULL_COMPOSE_CHAIN,
  recordingMeter,
  registryOf,
  RUN_ID,
  syntheticContext,
  testConfiguration,
} from "@/platform/gateway/gateway-fixtures";
import { CircuitBook } from "@/platform/gateway/circuit";

import type { EvalCase } from "@/contracts/eval-case";

import {
  createEvalGatewayAsker,
  EvalGatewayAnswer,
  gatewayResultToObservation,
  providerKeysFromAttempts,
} from "./ask-case-gateway";
import { clearanceForEvalCase, runExpertEval } from "./run";

function approvedFixture(overrides: Partial<EvalCase> & Pick<EvalCase, "caseId">): EvalCase {
  return {
    schemaVersion: 1,
    expertKey: "uav-expert",
    status: "approved",
    origin: "expert_written",
    caseType: "answerable",
    question: "Synthetic gateway eval question.",
    expectedAnswerPoints: ["States the synthetic check."],
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
    approvedBy: "00000000-0000-4000-8000-0000000000a2",
    approvedAt: "2026-11-21T12:00:00.000Z",
    draftedBy: "builder-agent",
    draftedOn: "2026-11-21",
    ...overrides,
  };
}

describe("providerKeysFromAttempts", () => {
  it("lists providers in attempt order without duplicates", () => {
    const attempts: AttemptRecord[] = [
      {
        attemptId: "a1",
        providerKey: "local_box",
        chainPosition: 0,
        capabilityTier: "medium",
        outcome: "connection",
        reservedUnits: { maxInputUnits: 1, maxOutputUnits: 1 },
        reconciled: null,
        model: null,
      },
      {
        attemptId: "a2",
        providerKey: "workers_ai",
        chainPosition: 1,
        capabilityTier: "medium",
        outcome: "answered",
        reservedUnits: { maxInputUnits: 1, maxOutputUnits: 1 },
        reconciled: "settled",
        model: "hosted",
      },
      {
        attemptId: "a3",
        providerKey: "workers_ai",
        chainPosition: 1,
        capabilityTier: "medium",
        outcome: "answered",
        reservedUnits: { maxInputUnits: 1, maxOutputUnits: 1 },
        reconciled: "settled",
        model: "hosted",
      },
    ];
    expect(providerKeysFromAttempts(attempts)).toEqual(["local_box", "workers_ai"]);
  });
});

describe("gatewayResultToObservation", () => {
  it("maps unavailable gateway to infrastructure_failure", () => {
    const obs = gatewayResultToObservation({
      ok: false,
      status: "unavailable",
      reason: "all_attempts_failed",
      attempts: [
        {
          attemptId: "a1",
          providerKey: "claude",
          chainPosition: 0,
          capabilityTier: "large",
          outcome: "timeout",
          reservedUnits: { maxInputUnits: 1, maxOutputUnits: 1 },
          reconciled: "released",
          model: null,
        },
      ],
      skipped: [],
      matrixRevision: 1,
    });
    expect(obs).toEqual({ kind: "infrastructure_failure", providerKeysUsed: ["claude"] });
  });

  it("maps answered structured output to an answer observation", () => {
    const parsed = EvalGatewayAnswer.parse({ status: "refused", refusalKey: "out_of_scope" });
    const obs = gatewayResultToObservation({
      ok: true,
      providerKey: "local_box",
      model: "box",
      chainPosition: 0,
      capabilityTier: "medium",
      text: "{}",
      parsed,
      usage: null,
      attempts: [
        {
          attemptId: "a1",
          providerKey: "local_box",
          chainPosition: 0,
          capabilityTier: "medium",
          outcome: "answered",
          reservedUnits: { maxInputUnits: 1, maxOutputUnits: 1 },
          reconciled: "settled",
          model: "box",
        },
      ],
      skipped: [],
      matrixRevision: 1,
    });
    expect(obs.kind).toBe("answer");
    if (obs.kind === "answer") {
      expect(obs.status).toBe("refused");
      expect(obs.refusalKey).toBe("out_of_scope");
    }
  });
});

describe("createEvalGatewayAsker", () => {
  it("calls callModelGateway once per case and scores through runExpertEval", async () => {
    const adapter = fakeAdapter("local_box", [
      answered('{"status":"answered"}', "box"),
    ]);
    const meter = recordingMeter();
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
    const askCase = createEvalGatewayAsker({
      context: syntheticContext(),
      runId: RUN_ID,
      gatewayDeps: {
        config: testConfiguration(),
        adapters: registryOf(adapter),
        health: book,
        meter,
      },
      composeChain: FULL_COMPOSE_CHAIN,
    });

    const run = await runExpertEval({
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig: { compose: FULL_COMPOSE_CHAIN },
      corpusGeneration: "gen-gw",
      cases: [approvedFixture({ caseId: "UAV-E001" })],
      askCase,
    });

    expect(run.status).toBe("completed");
    expect(run.results[0]?.score).toBe(1);
    expect(adapter.calls).toHaveLength(1);
    expect(meter.reserveCalls).toHaveLength(1);
  });

  it("honours clearance: client_confidential cases never record deepseek/openrouter attempts", async () => {
    const local = fakeAdapter("local_box", [answered('{"status":"answered"}', "box")]);
    const deepseek = fakeAdapter("deepseek", [answered('{"status":"answered"}', "ds")]);
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
    const askCase = createEvalGatewayAsker({
      context: syntheticContext(),
      runId: RUN_ID,
      gatewayDeps: {
        config: testConfiguration(),
        adapters: registryOf(local, deepseek),
        health: book,
        meter: recordingMeter(),
      },
      composeChain: ["local_box", "deepseek"],
      tenantPolicy: {
        client_confidential: ["local_box", "claude", "deepseek", "openrouter"],
      },
    });

    const evalCase = approvedFixture({ caseId: "UAV-E050", dataClass: "client_confidential" });
    const clearance = clearanceForEvalCase({
      dataClass: evalCase.dataClass,
      tenantPolicy: { client_confidential: ["local_box", "claude", "deepseek", "openrouter"] },
    });

    const obs = await askCase({
      evalCase,
      clearance,
      corpusGeneration: "gen-a",
      expertVersion: "1.0.0",
    });

    expect(obs.providerKeysUsed).not.toContain("deepseek");
    expect(obs.providerKeysUsed).not.toContain("openrouter");
    expect(deepseek.calls).toHaveLength(0);
  });
});