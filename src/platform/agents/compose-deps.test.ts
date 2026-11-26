import { describe, expect, it } from "vitest";

import { Answer, type ClaimType } from "@/contracts/answer";
import type { DataClass } from "@/contracts/data-class";
import { DEFAULT_TASK_CHAIN_ORDER, PLATFORM_DEFAULT_CLEARANCE } from "@/contracts/provider-route";

import {
  answered,
  CONVERSATION_ID,
  fakeAdapter,
  FULL_COMPOSE_CHAIN,
  recordingMeter,
  registryOf,
  RUN_ID,
  syntheticContext,
  testConfiguration,
  type FakeAdapter,
} from "@/platform/gateway/gateway-fixtures";
import { CircuitBook } from "@/platform/gateway/circuit";
import type { AdapterCallOutcome } from "@/platform/gateway/adapters";
import type { UnboundClaim } from "@/platform/gateway/verify-binding";
import { pass2PayloadIsClaimSpanOnly } from "@/platform/gateway/verifier-pass2";

import { composeAnswer, type ComposeDeps, type ExpertComposePolicy, type ComposeRunInput } from "./compose";
import {
  createComposeDepsWithSemanticVerifier,
  withDefaultSemanticVerifier,
  type SemanticVerifierWireMeta,
} from "./compose-deps";

/**
 * T-215 PR-3: default-wiring `createSemanticVerifier` into compose deps so pass 2 runs without a
 * hand-injected port. Recording adapters prove the material verify path was actually dialled.
 */

const T0 = 1_730_000_000_000;
const VERSION_A = "6e1a9a3c-1c2d-4a6b-9e5f-0a1b2c3d4e01";
const VERSION_C = "6e1a9a3c-1c2d-4a6b-9e5f-0a1b2c3d4e03";

const EXPERT: ExpertComposePolicy = {
  key: "uav-doc-expert",
  version: "v3",
  riskClass: "operational",
  modelChains: {
    compose: [...FULL_COMPOSE_CHAIN],
    verify: DEFAULT_TASK_CHAIN_ORDER.verify.filter((key) => key !== "local_box"),
  },
  minVerifierTier: "large",
  limits: { evidenceChunks: 4, maxOutputTokens: 800, stageDeadlineMs: 20_000 },
  refusalTemplates: {
    no_evidence: "I could not find that in the documents you can access.",
    insufficient_support: "The documents I could access did not support a reliable answer.",
    out_of_scope: "That question is outside what this expert answers.",
    unavailable: "The assistant is unavailable right now. Please try again later.",
  },
  evaluationSetVersion: "ev-0001",
};

function chunk(chunkId: string, sourceVersionId: string, text: string, dataClass: DataClass) {
  return { chunkId, sourceVersionId, text, dataClass, authority: "vendor-manual" };
}

const CALIBRATION_CHUNK = chunk("chk-0001", VERSION_A, "Calibrate the antenna before the first pass.", "internal");
const GROUNDING_CHUNK = chunk("chk-0003", VERSION_C, "Ground the aircraft before removing the payload bay.", "internal");
const EVIDENCE = [CALIBRATION_CHUNK, GROUNDING_CHUNK];

function ref(chunkId: string, sourceVersionId: string, text: string) {
  return { kind: "chunk" as const, sourceVersionId, chunkId, quotedText: text };
}

function claimOf(
  id: string,
  type: ClaimType,
  text: string,
  evidence: ReturnType<typeof ref>[],
): UnboundClaim {
  return {
    id,
    text,
    type,
    evidence,
    authority: "vendor-manual",
    verificationStatus: "unverified",
    limitations: [],
  };
}

function candidate(claims: UnboundClaim[]): string {
  return JSON.stringify({
    summary: "Antenna calibration comes before the first pass.",
    claims: claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      type: claim.type,
      evidence: claim.evidence,
      authority: claim.authority,
      limitations: claim.limitations,
    })),
    unknowns: [],
    conflicts: [],
  });
}

function input(overrides: Partial<ComposeRunInput> = {}): ComposeRunInput {
  return {
    context: syntheticContext(),
    runId: RUN_ID,
    conversationId: CONVERSATION_ID,
    question: "Do we calibrate the antenna first?",
    questionDataClass: "internal",
    evidence: EVIDENCE,
    expert: EXPERT,
    corpusGenerations: [3],
    instruction: "Answer only from the evidence pack. Cite every claim.",
    asOf: "2026-11-05T09:00:00.000Z",
    ...overrides,
  };
}

function gatewayOf(scripts: Record<string, AdapterCallOutcome[]>): {
  adapters: FakeAdapter[];
  deps: ComposeDeps;
} {
  const adapters = Object.entries(scripts).map(([providerKey, script]) => fakeAdapter(providerKey, script));
  return {
    adapters,
    deps: {
      config: testConfiguration({ clearance: PLATFORM_DEFAULT_CLEARANCE }),
      adapters: registryOf(...adapters),
      health: new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 }),
      meter: recordingMeter(),
      clock: () => T0,
    },
  };
}

function adapterFor(adapters: FakeAdapter[], providerKey: string): FakeAdapter {
  const found = adapters.find((adapter) => adapter.providerKey === providerKey);
  if (!found) throw new Error(`missing adapter under test for ${providerKey}`);
  return found;
}

function wireMeta(overrides: Partial<SemanticVerifierWireMeta> = {}): SemanticVerifierWireMeta {
  return {
    context: syntheticContext(),
    runId: RUN_ID,
    conversationId: CONVERSATION_ID,
    dataClass: "internal",
    verifyChain: EXPERT.modelChains.verify,
    minVerifierTier: EXPERT.minVerifierTier,
    maxOutputUnits: EXPERT.limits.maxOutputTokens,
    callTimeoutMs: EXPERT.limits.stageDeadlineMs,
    stageDeadlineMs: EXPERT.limits.stageDeadlineMs,
    ...overrides,
  };
}

function supportedVerdict(claimId: string): string {
  return JSON.stringify({
    verdicts: [{ claimId, status: "supported", reason: "The cited span states it." }],
  });
}

function unsupportedVerdict(claimId: string): string {
  return JSON.stringify({
    verdicts: [{ claimId, status: "unsupported", reason: "The cited span does not state it." }],
  });
}

describe("createComposeDepsWithSemanticVerifier (T-215 PR-3)", () => {
  it("default-wires pass 2: Claude verify is dialled and a supported requirement claim answers", async () => {
    const payload = candidate([
      claimOf("c1", "requirement", "Calibration is required before every survey.", [
        ref("chk-0001", VERSION_A, "Calibrate the antenna"),
      ]),
    ]);
    const h = gatewayOf({
      local_box: [answered(payload, "open-weights-alpha")],
      claude: [answered(supportedVerdict("c1"), "hosted-gamma")],
    });
    const deps = createComposeDepsWithSemanticVerifier(h.deps, wireMeta());
    const { answer, audit } = await composeAnswer(input(), deps);

    expect(audit.semanticVerification).toBe("ran");
    expect(audit.verdicts).toEqual([
      { claimId: "c1", status: "supported", reason: "The cited span states it." },
    ]);
    expect(answer.claims[0]?.verificationStatus).toBe("supported");
    expect(answer.status).toBe("answered");

    const claude = adapterFor(h.adapters, "claude");
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.task).toBe("verify");
    expect(pass2PayloadIsClaimSpanOnly(claude.calls[0]!.messages)).toBe(true);
    const blob = claude.calls[0]!.messages.map((m) => m.text).join("\n");
    expect(blob).not.toContain("Question:");
    expect(blob).not.toContain("Evidence pack:");
    expect(Answer.parse(answer)).toBeTruthy();
  });

  it("material pass-2 unsupported drops the claim via the wired verifier (recording adapters)", async () => {
    const payload = candidate([
      claimOf("c1", "requirement", "Grounding is mandatory.", [
        ref("chk-0003", VERSION_C, "Ground the aircraft"),
      ]),
    ]);
    const h = gatewayOf({
      local_box: [answered(payload, "open-weights-alpha")],
      claude: [answered(unsupportedVerdict("c1"), "hosted-gamma")],
    });
    const deps = createComposeDepsWithSemanticVerifier(h.deps, wireMeta());
    const { answer, audit } = await composeAnswer(
      input({ expert: { ...EXPERT, modelChains: { ...EXPERT.modelChains, compose: ["local_box"] } } }),
      deps,
    );

    expect(audit.semanticVerification).toBe("ran");
    expect(adapterFor(h.adapters, "claude").calls.map((c) => c.task)).toEqual(["verify"]);
    expect(audit.droppedByVerifier).toEqual(["c1"]);
    expect(answer.status).toBe("refused");
    expect(answer.refusalKey).toBe("insufficient_support");
  });

  it("compose retry after material pass-2 failure still dials verify with the live composer", async () => {
    const bad = candidate([
      claimOf("c1", "requirement", "Grounding is mandatory.", [
        ref("chk-0003", VERSION_C, "Ground the aircraft"),
      ]),
    ]);
    const good = candidate([
      claimOf("c2", "requirement", "Calibration is required before every survey.", [
        ref("chk-0001", VERSION_A, "Calibrate the antenna"),
      ]),
    ]);
    const h = gatewayOf({
      local_box: [answered(bad, "open-weights-alpha")],
      workers_ai: [answered(good, "hosted-beta")],
      claude: [
        answered(unsupportedVerdict("c1"), "hosted-gamma"),
        answered(supportedVerdict("c2"), "hosted-gamma"),
      ],
    });
    const deps = createComposeDepsWithSemanticVerifier(h.deps, wireMeta());
    const { answer, audit } = await composeAnswer(input(), deps);

    expect(audit.composeAttempts.filter((a) => a.outcome === "answered")).toHaveLength(2);
    expect(adapterFor(h.adapters, "claude").calls.map((c) => c.task)).toEqual(["verify", "verify"]);
    expect(answer.claims.map((c) => c.id)).toEqual(["c2"]);
    expect(answer.claims[0]?.verificationStatus).toBe("supported");
    expect(answer.status).toBe("answered");
  });
});

describe("withDefaultSemanticVerifier", () => {
  it("fills semanticVerifier when missing", async () => {
    const payload = candidate([
      claimOf("c1", "requirement", "Calibration is required before every survey.", [
        ref("chk-0001", VERSION_A, "Calibrate the antenna"),
      ]),
    ]);
    const h = gatewayOf({
      local_box: [answered(payload, "open-weights-alpha")],
      claude: [answered(supportedVerdict("c1"), "hosted-gamma")],
    });
    expect(h.deps.semanticVerifier).toBeUndefined();
    const deps = withDefaultSemanticVerifier(h.deps, wireMeta());
    expect(deps.semanticVerifier).toBeDefined();
    const { audit } = await composeAnswer(input(), deps);
    expect(audit.semanticVerification).toBe("ran");
  });

  it("leaves an explicit semanticVerifier alone", async () => {
    const payload = candidate([
      claimOf("c1", "requirement", "Calibration is required before every survey.", [
        ref("chk-0001", VERSION_A, "Calibrate the antenna"),
      ]),
    ]);
    const h = gatewayOf({
      local_box: [answered(payload, "open-weights-alpha")],
      claude: [answered(supportedVerdict("c1"), "hosted-gamma")],
    });
    let handInjectedCalls = 0;
    const hand: ComposeDeps = {
      ...h.deps,
      semanticVerifier: {
        async verify() {
          handInjectedCalls += 1;
          return [{ claimId: "c1", status: "supported", reason: "hand" }];
        },
      },
    };
    const deps = withDefaultSemanticVerifier(hand, wireMeta());
    expect(deps.semanticVerifier).toBe(hand.semanticVerifier);
    const { audit } = await composeAnswer(input(), deps);
    expect(handInjectedCalls).toBe(1);
    expect(audit.semanticVerification).toBe("ran");
    expect(adapterFor(h.adapters, "claude").calls).toHaveLength(0);
  });
});
