import { describe, expect, it } from "vitest";

import { Answer, type Claim, type ClaimType, type EvidenceRef } from "@/contracts/answer";
import type { DataClass } from "@/contracts/data-class";
import { DEFAULT_TASK_CHAIN_ORDER, PLATFORM_DEFAULT_CLEARANCE } from "@/contracts/provider-route";

import {
  answered,
  CONVERSATION_ID,
  failed,
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

import {
  composeAnswer,
  type ComposeDeps,
  type ComposeOutcome,
  type ComposeRunInput,
  type ExpertComposePolicy,
  type SemanticVerifierPort,
} from "./compose";

/**
 * F20 + F21 pass 1 on top of the gateway (plan §12.1, §12.4). Every provider is a recorded mock,
 * so "this provider never saw that payload" is a call-count assertion, not a prose claim.
 */

const T0 = 1_730_000_000_000;
const VERSION_A = "6e1a9a3c-1c2d-4a6b-9e5f-0a1b2c3d4e01";
const VERSION_B = "6e1a9a3c-1c2d-4a6b-9e5f-0a1b2c3d4e02";
const VERSION_C = "6e1a9a3c-1c2d-4a6b-9e5f-0a1b2c3d4e03";

const EXPERT: ExpertComposePolicy = {
  key: "uav-doc-expert",
  version: "v3",
  riskClass: "operational",
  // M1: the `verify` chain drops `local_box` (issue #9). Configuration, not a code branch.
  modelChains: {
    compose: [...FULL_COMPOSE_CHAIN],
    verify: DEFAULT_TASK_CHAIN_ORDER.verify.filter((key) => key !== "local_box"),
  },
  minVerifierTier: "large",
  limits: { evidenceChunks: 4, maxOutputTokens: 800, stageDeadlineMs: 20_000 },
  refusalTemplates: {
    no_evidence: "I could not find that in the documents you can access.",
    out_of_scope: "That question is outside what this expert answers.",
    unavailable: "The assistant is unavailable right now. Please try again later.",
  },
  evaluationSetVersion: "ev-0001",
};

function chunk(chunkId: string, sourceVersionId: string, text: string, dataClass: DataClass) {
  return { chunkId, sourceVersionId, text, dataClass, authority: "vendor-manual" };
}

const CALIBRATION_CHUNK = chunk("chk-0001", VERSION_A, "Calibrate the antenna before the first pass.", "internal");
const SURVEY_CHUNK = chunk("chk-0002", VERSION_B, "The survey log must record the operator and the line number.", "internal");
const GROUNDING_CHUNK = chunk("chk-0003", VERSION_C, "Ground the aircraft before removing the payload bay.", "internal");

const EVIDENCE = [CALIBRATION_CHUNK, SURVEY_CHUNK, GROUNDING_CHUNK];

/** The same chunk as `chk-0002`, filed under a `client_confidential` collection (§6.2 test). */
const CONFIDENTIAL_PACK = [{ ...SURVEY_CHUNK, dataClass: "client_confidential" as const }];

function ref(chunkId: string, sourceVersionId: string, text: string): EvidenceRef {
  const haystack = EVIDENCE.find((entry) => entry.chunkId === chunkId)?.text ?? "";
  const startChar = haystack.indexOf(text);
  return {
    kind: "chunk",
    sourceVersionId,
    chunkId,
    span: { startChar, endChar: startChar + text.length },
    quotedText: text,
  };
}

function claimOf(id: string, type: ClaimType, text: string, evidence: EvidenceRef[]): Claim {
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

function candidate(claims: Claim[], extra: Record<string, unknown> = {}): string {
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
    ...extra,
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

function depsOf(
  scripts: Record<string, AdapterCallOutcome[]>,
  options: {
    book?: CircuitBook;
    clearance?: typeof PLATFORM_DEFAULT_CLEARANCE;
    semanticVerifier?: SemanticVerifierPort;
  } = {},
): { adapters: FakeAdapter[]; meter: ReturnType<typeof recordingMeter>; deps: ComposeDeps } {
  const adapters = Object.entries(scripts).map(([providerKey, script]) => fakeAdapter(providerKey, script));
  const meter = recordingMeter();
  const book = options.book ?? new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
  return {
    adapters,
    meter,
    deps: {
      config: testConfiguration({ clearance: options.clearance ?? PLATFORM_DEFAULT_CLEARANCE }),
      adapters: registryOf(...adapters),
      health: book,
      meter,
      // A fixed clock: circuit state is recorded in the book at T0, and a real `Date.now()` would
      // be years past the cooldown and hide an open circuit.
      clock: () => T0,
      semanticVerifier: options.semanticVerifier,
    },
  };
}

function adapterFor(h: { adapters: FakeAdapter[] }, providerKey: string): FakeAdapter {
  const found = h.adapters.find((adapter) => adapter.providerKey === providerKey);
  if (!found) throw new Error(`missing adapter under test for ${providerKey}`);
  return found;
}

/**
 * §9.3 at the boundary that matters most: everything the employee can read. The gateway's audit
 * fields (`attempts[]`, skip reasons) and provider/model names must never become a string inside an
 * `Answer` — and because `Answer` is a `strictObject`, an extra field is a parse failure, so this
 * test pins both halves.
 */
const INTERNAL_LEAKS =
  /local_box|workers_ai|claude|deepseek|openrouter|open-weights|hosted-|no_endpoint|no_adapter|composer_unknown|composed_the_answer|verifier_not_evaluated|all_attempts_failed|no_eligible_provider|budget_authority_unavailable|below_tier|not_cleared|chain_order|circuit_open|quota_exhausted|task_unsupported|provider_unavailable|unhealthy/i;

function assertNothingInternalLeaks(answer: Answer, where: string): void {
  expect(JSON.stringify(answer), where).not.toMatch(INTERNAL_LEAKS);
  for (const key of ["attempts", "skipped", "providerKey", "model", "matrixRevision"]) {
    expect(Object.keys(answer), `${where}: ${key} reached the employee surface}`).not.toContain(key);
  }
}

function routeOf(audit: ComposeOutcome["audit"]): NonNullable<ComposeOutcome["audit"]["verifierRoute"]> {
  if (audit.verifierRoute === null) throw new Error("expected a verifier route for a composed answer");
  return audit.verifierRoute;
}

describe("compose on the gateway (plan §12.4, §12.1)", () => {
  it("answers from the local box and returns a contract Answer with bound claims", async () => {
    const good = answered(
      candidate([claimOf("c1", "source_fact", "Calibrate the antenna first.", [ref("chk-0001", VERSION_A, "Calibrate the antenna")])]),
      "open-weights-alpha",
    );
    const h = depsOf({ local_box: [good], workers_ai: [good], claude: [good] });
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(Answer.parse(answer)).toBeTruthy();
    assertNothingInternalLeaks(answer, "answered case");
    expect(answer.status).toBe("answered");
    expect(answer.claims[0]?.verificationStatus).toBe("binding_passed");
    expect(answer.dataClass).toBe("internal");
    expect(answer.expertVersions).toEqual(["uav-doc-expert@v3"]);
    expect(answer.runId).toBe(RUN_ID);
    expect(audit.answeredBy).toMatchObject({
      providerKey: "local_box",
      chainPosition: 1,
      model: "open-weights-alpha",
    });
    expect(routeOf(audit).eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
    expect(adapterFor(h, "local_box").calls).toHaveLength(1);
    expect(adapterFor(h, "workers_ai").calls).toHaveLength(0);
  });

  it("the answer carries the highest data class of its inputs and only cleared providers are called", async () => {
    const confidentialClaim = claimOf("c1", "source_fact", "The log must record the operator.", [
      ref("chk-0002", VERSION_B, "must record the operator"),
    ]);
    const payload = candidate([confidentialClaim]);
    const h = depsOf({
      local_box: [failed("connection")],
      workers_ai: [answered(payload, "hosted-beta")],
      claude: [answered(payload, "hosted-gamma")],
      deepseek: [answered(payload, "hosted-delta")],
      openrouter: [answered(payload, "hosted-epsilon")],
    });
    const { answer } = await composeAnswer(input({ evidence: CONFIDENTIAL_PACK }), h.deps);
    expect(answer.dataClass).toBe("client_confidential");
    for (const providerKey of ["workers_ai", "deepseek", "openrouter"]) {
      expect(adapterFor(h, providerKey).calls, `${providerKey} saw client_confidential text`).toHaveLength(0);
    }
    expect(adapterFor(h, "claude").calls).toHaveLength(1);
    expect(adapterFor(h, "local_box").calls[0]?.dataClass).toBe("client_confidential");
  });

  it("the evidence pack is capped by the expert's limits and the cap is stated, not hidden", async () => {
    const good = answered(
      candidate([claimOf("c1", "source_fact", "Ground the aircraft.", [ref("chk-0003", VERSION_C, "Ground the aircraft")])]),
      "open-weights-alpha",
    );
    const h = depsOf({ local_box: [good] });
    const { answer } = await composeAnswer(
      input({ expert: { ...EXPERT, limits: { ...EXPERT.limits, evidenceChunks: 2 } } }),
      h.deps,
    );
    const prompt = adapterFor(h, "local_box").calls[0]?.messages.map((message) => message.text).join("\n") ?? "";
    expect(prompt).toContain("chk-0001");
    expect(prompt).toContain("chk-0002");
    expect(prompt).not.toContain("chk-0003");
    expect(answer.truncation.join(" ")).toMatch(/fewer chunks|evidence pack/i);
    // A citation to a chunk the model was never given cannot be defended, so nothing survives.
    expect(answer.claims).toEqual([]);
    assertNothingInternalLeaks(answer, "evidence pack capped");
    expect(answer.status).toBe("refused");
  });

  it("with no evidence nothing is composed and no provider is called (no silent public default)", async () => {
    const h = depsOf({
      local_box: [answered("never", "open-weights-alpha")],
      claude: [answered("never", "hosted-gamma")],
    });
    const { answer, audit } = await composeAnswer(input({ evidence: [] }), h.deps);
    expect(answer.status).toBe("refused");
    expect(answer.summary).toBe(EXPERT.refusalTemplates.no_evidence);
    for (const adapter of h.adapters) expect(adapter.calls).toHaveLength(0);
    expect(h.meter.events).toEqual([]);
    expect(audit.answeredBy).toBeNull();
    expect(answer.unknowns.length).toBeGreaterThan(0);
  });
});

describe("pass 1 rejects citations that do not exist in this run (plan §12.1)", () => {
  it("a claim citing a chunk that was not retrieved is dropped and the answer degrades to partial", async () => {
    const real = claimOf("c1", "source_fact", "Calibrate the antenna first.", [
      ref("chk-0001", VERSION_A, "Calibrate the antenna"),
    ]);
    const invented = claimOf("c2", "source_fact", "The antenna must be replaced yearly.", [
      { kind: "chunk", sourceVersionId: VERSION_A, chunkId: "chk-9999", span: { startChar: 0, endChar: 12 }, quotedText: "Calibrate the " },
    ]);
    const h = depsOf({ local_box: [answered(candidate([real, invented]), "open-weights-alpha")] });
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(Answer.parse(answer)).toBeTruthy();
    expect(answer.claims.map((claim) => claim.id)).toEqual(["c1"]);
    expect(answer.status).toBe("partial");
    expect(audit.bindingRejected).toEqual(["c2"]);
    expect(answer.truncation.join(" ")).toMatch(/citation|dropped/i);
    assertNothingInternalLeaks(answer, "invented citation dropped");
  });

  it("an answer made only of inferences is not an `answered` result (§12.1, issue #16 N2)", async () => {
    const inferred: Claim = {
      ...claimOf("c1", "inference", "The order of operations implies calibration first.", []),
      limitations: ["Inferred from the procedure order; no source states it."],
    };
    const h = depsOf({ local_box: [answered(candidate([inferred]), "open-weights-alpha")] });
    const { answer } = await composeAnswer(input(), h.deps);
    expect(answer.status).toBe("partial");
    expect(answer.claims[0]?.verificationStatus).toBe("binding_passed");
  });

  it("a model that reports its own truncation is rejected: the platform states what was left out (§12.1)", async () => {
    const h = depsOf({
      local_box: [answered(candidate([], { truncation: ["I left out the second procedure."] }), "open-weights-alpha")],
    });
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(answer.status).toBe("unavailable");
    expect(answer.truncation).toEqual([]);

    // And the rejected attempt is **billed**, not released: the model ran, produced output, and the
    // schema is what refused it. §12.3 — an attempt is settled against reported usage, or kept as
    // potentially billed when usage is unknown; "nothing was spent" would be the under-count.
    const [attempt] = audit.composeAttempts;
    if (!attempt) throw new Error("expected one compose attempt");
    expect(attempt.outcome).toBe("invalid_output");
    expect(attempt.reservedUnits).toEqual({
      maxInputUnits: expect.any(Number),
      maxOutputUnits: EXPERT.limits.maxOutputTokens,
    });
    expect(attempt.reconciled).toBe("settled");
    expect(h.meter.events).toEqual([
      `reserve:local_box:${attempt.attemptId}`,
      `reconcile:settled:${attempt.attemptId}`,
    ]);
    expect(h.meter.events.filter((event) => event.includes("reconcile:released:"))).toEqual([]);
  });

  it("unusable output with no reported usage keeps its reservation as potentially billed (§12.3)", async () => {
    const h = depsOf({
      local_box: [
        {
          ok: true,
          text: "prose the schema cannot hold, and this provider reports no usage",
          model: "open-weights-alpha",
          finishReason: "stop",
        },
      ],
    });
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(answer.status).toBe("unavailable");
    const [attempt] = audit.composeAttempts;
    if (!attempt) throw new Error("expected one compose attempt");
    expect(attempt.outcome).toBe("invalid_output");
    expect(attempt.reconciled).toBe("ambiguous");
    expect(h.meter.events).toEqual([
      `reserve:local_box:${attempt.attemptId}`,
      `reconcile:ambiguous:${attempt.attemptId}`,
    ]);
  });

  it("a length-truncated completion is billed work with nothing usable: settled against reported usage (§12.3)", async () => {
    const h = depsOf({
      local_box: [
        {
          ok: true,
          text: '{"summary":"cut off mid-',
          model: "open-weights-alpha",
          finishReason: "length",
          usage: { inputUnits: 9_000, outputUnits: 800 },
        },
      ],
    });
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(answer.status).toBe("unavailable");
    const [attempt] = audit.composeAttempts;
    if (!attempt) throw new Error("expected one compose attempt");
    expect(attempt.outcome).toBe("context_overflow");
    expect(attempt.reconciled).toBe("settled");
    expect(h.meter.events).toEqual([
      `reserve:local_box:${attempt.attemptId}`,
      `reconcile:settled:${attempt.attemptId}`,
    ]);
    expect(h.meter.events.filter((event) => event.includes("reconcile:released:"))).toEqual([]);
  });

  it("a truncated completion from a provider that reports no usage keeps the full reservation as ambiguous", async () => {
    const h = depsOf({
      local_box: [
        { ok: true, text: '{"summary":"cut off mid-', model: "open-weights-alpha", finishReason: "length" },
      ],
    });
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(answer.status).toBe("unavailable");
    const [attempt] = audit.composeAttempts;
    if (!attempt) throw new Error("expected one compose attempt");
    expect(attempt.outcome).toBe("context_overflow");
    // The reservation was the expert's own `maxOutputTokens`, and this is exactly the shape §12.3
    // calls ambiguous: the box generated to its limit, so the units are unknown, not zero.
    expect(attempt.reservedUnits.maxOutputUnits).toBe(EXPERT.limits.maxOutputTokens);
    expect(attempt.reconciled).toBe("ambiguous");
    expect(h.meter.events).toEqual([
      `reserve:local_box:${attempt.attemptId}`,
      `reconcile:ambiguous:${attempt.attemptId}`,
    ]);
  });

  it("a chain that never yields a valid structured answer ends unavailable, not a guess", async () => {
    const h = depsOf({
      local_box: [answered("prose without structure", "open-weights-alpha")],
      workers_ai: [answered("also prose", "hosted-beta")],
      claude: [answered("still prose", "hosted-gamma")],
    });
    const { answer } = await composeAnswer(input(), h.deps);
    expect(answer.status).toBe("unavailable");
    expect(answer.summary).toBe(EXPERT.refusalTemplates.unavailable);
    assertNothingInternalLeaks(answer, "chain produced no structured answer");
    expect(answer.claims).toEqual([]);
  });

  it("a restricted payload with the box offline is unavailable with zero cloud calls", async () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000 });
    book.recordFailure("local_box", T0);
    const restricted = chunk("chk-0004", VERSION_A, "Site A coordinates are listed here.", "restricted");
    const h = depsOf(
      {
        local_box: [answered(candidate([claimOf("c1", "source_fact", "Coordinates are listed.", [ref("chk-0001", VERSION_A, "Calibrate the antenna")])]), "open-weights-alpha")],
        workers_ai: [answered("never", "hosted-beta")],
        claude: [answered("never", "hosted-gamma")],
        deepseek: [answered("never", "hosted-delta")],
        openrouter: [answered("never", "hosted-epsilon")],
      },
      { book },
    );
    const { answer } = await composeAnswer(input({ evidence: [restricted], questionDataClass: "restricted" }), h.deps);
    expect(answer.status).toBe("unavailable");
    expect(answer.summary).toBe(EXPERT.refusalTemplates.unavailable);
    for (const adapter of h.adapters) {
      if (adapter.providerKey === "local_box") continue;
      expect(adapter.calls, `${adapter.providerKey} saw restricted text`).toHaveLength(0);
    }
    expect(answer.dataClass).toBe("restricted");
    assertNothingInternalLeaks(answer, "restricted with the box offline");
  });
});

describe("verification selection (plan §12.1 rules (d)/(e), issue #9)", () => {
  it("never verifies with the model that composed the answer, and withholds requirement claims when nothing is left", async () => {
    const payload = candidate([
      claimOf("c1", "source_fact", "Calibrate the antenna first.", [ref("chk-0001", VERSION_A, "Calibrate the antenna")]),
      claimOf("c2", "requirement", "Calibration is required before every survey.", [ref("chk-0001", VERSION_A, "Calibrate the antenna")]),
    ]);
    const h = depsOf({
      local_box: [failed("connection")],
      workers_ai: [failed("connection")],
      claude: [answered(payload, "hosted-gamma")],
    });
    const { answer, audit } = await composeAnswer(input(), h.deps);
    const verifierRoute = audit.verifierRoute;
    if (verifierRoute === null) throw new Error("expected a verifier route for a composed answer");
    expect(audit.answeredBy?.providerKey).toBe("claude");
    expect(verifierRoute.eligible).toEqual([]);
    expect(verifierRoute.skipped).toContainEqual({ providerKey: "claude", reason: "composed_the_answer" });
    expect(verifierRoute.skipped).toContainEqual({ providerKey: "workers_ai", reason: "below_tier" });
    expect(audit.withheldRequirementClaims).toBe(1);
    expect(answer.claims.map((claim) => claim.id)).toEqual(["c1"]);
    expect(answer.status).toBe("partial");
    expect(answer.truncation.join(" ")).toMatch(/requirement/i);
    assertNothingInternalLeaks(answer, "requirement claims withheld");
    expect(Answer.parse(answer)).toBeTruthy();
  });

  it("a cleared, evaluated verifier above minVerifierTier lets requirement claims through when semantic verification runs (T-215 plugs in here)", async () => {
    const payload = candidate([
      claimOf("c1", "requirement", "Calibration is required before every survey.", [ref("chk-0001", VERSION_A, "Calibrate the antenna")]),
    ]);
    const semanticVerifier: SemanticVerifierPort = {
      async verify() {
        return [{ claimId: "c1", status: "supported", reason: "The cited span states it." }];
      },
    };
    const h = depsOf(
      { local_box: [answered(payload, "open-weights-alpha")], claude: [answered(payload, "hosted-gamma")] },
      { semanticVerifier },
    );
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(audit.answeredBy?.providerKey).toBe("local_box");
    expect(routeOf(audit).eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
    expect(audit.semanticVerification).toBe("ran");
    expect(audit.verdicts.map((verdict) => [verdict.claimId, verdict.status])).toEqual([["c1", "supported"]]);
    expect(answer.claims[0]?.verificationStatus).toBe("supported");
    expect(answer.status).toBe("answered");
    assertNothingInternalLeaks(answer, "requirement claim verified by a second model");
  });

  it("a verdict of unsupported drops that claim and re-checks coherence (§12.1)", async () => {
    const payload = candidate([
      claimOf("c1", "requirement", "Grounding is mandatory.", [ref("chk-0003", VERSION_C, "Ground the aircraft")]),
      claimOf("c2", "source_fact", "The bay is held by four screws.", [ref("chk-0003", VERSION_C, "Ground the aircraft")]),
    ]);
    const semanticVerifier: SemanticVerifierPort = {
      async verify() {
        return [{ claimId: "c1", status: "unsupported", reason: "The cited span does not state it." }];
      },
    };
    const h = depsOf(
      { local_box: [answered(payload, "open-weights-alpha")], claude: [answered(payload, "hosted-gamma")] },
      { semanticVerifier },
    );
    const { answer, audit } = await composeAnswer(input(), h.deps);
    expect(routeOf(audit).eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
    expect(audit.droppedByVerifier).toEqual(["c1"]);
    expect(answer.claims.map((claim) => claim.id)).toEqual(["c2"]);
    expect(answer.status).toBe("partial");
    expect(answer.truncation.join(" ")).toMatch(/unsupported/i);
    assertNothingInternalLeaks(answer, "verifier found a claim unsupported");
    expect(Answer.parse(answer)).toBeTruthy();
  });

  it("no eligible verifier means requirement claims never reach the employee; quotes that passed pass 1 still do", async () => {
    const payload = candidate([
      claimOf("c1", "requirement", "Grounding is mandatory.", [ref("chk-0003", VERSION_C, "Ground the aircraft")]),
      claimOf("c2", "source_fact", "The bay is held by four screws.", [ref("chk-0003", VERSION_C, "Ground the aircraft")]),
    ]);
    const h = depsOf({
      local_box: [failed("connection")],
      workers_ai: [failed("connection")],
      claude: [answered(payload, "hosted-gamma")],
    });
    // A verify chain whose only entry just composed the answer leaves nothing eligible.
    const { answer, audit } = await composeAnswer(
      input({ expert: { ...EXPERT, modelChains: { ...EXPERT.modelChains, verify: ["claude"] } } }),
      h.deps,
    );
    expect(routeOf(audit).eligible).toEqual([]);
    expect(answer.claims.map((claim) => claim.id)).toEqual(["c2"]);
    expect(answer.claims[0]?.verificationStatus).toBe("binding_passed");
    expect(answer.status).toBe("partial");
    assertNothingInternalLeaks(answer, "no eligible verifier");
  });
});
