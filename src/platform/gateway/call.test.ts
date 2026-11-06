import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ProgressEvent, type TierChangeReason } from "@/contracts/chat";
import type { ProviderKey } from "@/contracts/keys";

import {
  answered,
  CONVERSATION_ID,
  failed,
  fakeAdapter,
  FULL_COMPOSE_CHAIN,
  M1_ENDPOINTS,
  recordingMeter,
  registryOf,
  RUN_ID,
  syntheticContext,
  testConfiguration,
} from "./gateway-fixtures";
import { CircuitBook } from "./circuit";
import {
  callModelGateway,
  UNAVAILABLE_MESSAGE,
  type GatewayDeps,
  type ModelCallInput,
} from "./call";
import type { AdapterCallOutcome, ProviderFailureKind } from "./adapters";

/**
 * F38 `callProviderChain` inside F20 `callModelGateway` (plan §12.4 chain walking, §12.3
 * reservations). Every provider here is a recorded mock that logs what it received, so "this
 * payload never reached that provider" is a call-count assertion, not a code-reading claim.
 */

const T0 = 1_730_000_000_000;

const echoSchema = z.object({ answer: z.string() });

function baseInput(
  overrides: Partial<ModelCallInput<{ answer: string }>> = {},
): ModelCallInput<{ answer: string }> {
  return {
    context: syntheticContext(),
    runId: RUN_ID,
    conversationId: CONVERSATION_ID,
    task: "compose",
    dataClass: "public",
    messages: [
      { role: "system", text: "Answer only from the supplied evidence." },
      { role: "user", text: "What is the site procedure?" },
    ],
    maxOutputUnits: 600,
    callTimeoutMs: 5_000,
    stageDeadlineMs: 30_000,
    chain: FULL_COMPOSE_CHAIN,
    outputSchema: echoSchema,
    nowMs: T0,
    ...overrides,
  };
}

function harness(
  scripts: Record<string, AdapterCallOutcome[]>,
  options: { config?: ReturnType<typeof testConfiguration>; book?: CircuitBook } = {},
): {
  adapters: ReturnType<typeof fakeAdapter>[];
  meter: ReturnType<typeof recordingMeter>;
  book: CircuitBook;
  events: ProgressEvent[];
  deps: GatewayDeps;
} {
  const adapters = Object.entries(scripts).map(([providerKey, script]) =>
    fakeAdapter(providerKey, script),
  );
  const meter = recordingMeter();
  const events: ProgressEvent[] = [];
  const book = options.book ?? new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
  return {
    adapters,
    meter,
    book,
    events,
    deps: {
      config: options.config ?? testConfiguration({ openAfterFailures: 2, cooldownMs: 30_000 }),
      adapters: registryOf(...adapters),
      health: book,
      meter,
      onProgress: (event) => events.push(event),
    },
  };
}

function adapterFor(h: { adapters: ReturnType<typeof fakeAdapter>[] }, providerKey: ProviderKey) {
  const found = h.adapters.find((adapter) => adapter.providerKey === providerKey);
  if (!found) throw new Error(`no adapter under test for ${providerKey}`);
  return found;
}

describe("chain walking in cost order (plan §12.4, F38)", () => {
  it("a public compose walks the local box to Workers AI and reports which tier answered", async () => {
    const h = harness({
      local_box: [failed("connection")],
      workers_ai: [answered(JSON.stringify({ answer: "Step 1: hold the trigger." }), "hosted-beta")],
    });
    const result = await callModelGateway(baseInput({ chain: ["local_box", "workers_ai"] }), h.deps);
    if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
    expect(result.providerKey).toBe("workers_ai");
    expect(result.chainPosition).toBe(2);
    expect(result.capabilityTier).toBe("medium");
    expect(result.parsed).toEqual({ answer: "Step 1: hold the trigger." });
    expect(result.attempts.map((attempt) => attempt.providerKey)).toEqual(["local_box", "workers_ai"]);
    expect(adapterFor(h, "local_box").calls).toHaveLength(1);
    expect(adapterFor(h, "workers_ai").calls).toHaveLength(1);
    expect(result.matrixRevision).toBe(7);
  });

  const advanceOn: ProviderFailureKind[] = [
    "connection",
    "timeout",
    "rate_limited",
    "server_error",
    "context_overflow",
    "invalid_output",
  ];
  for (const kind of advanceOn) {
    it(`advances to the next provider on ${kind}`, async () => {
      const h = harness({
        local_box: [failed(kind, kind === "timeout" || kind === "invalid_output")],
        workers_ai: [answered(JSON.stringify({ answer: "ok" }), "hosted-beta")],
      });
      const result = await callModelGateway(baseInput({ chain: ["local_box", "workers_ai"] }), h.deps);
      if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
      expect(result.providerKey).toBe("workers_ai");
      expect(result.attempts[0]).toMatchObject({ providerKey: "local_box", outcome: kind });
    });
  }

  it("an answer body that fails the output schema is an invalid_output advance, not a delivered answer", async () => {
    const h = harness({
      local_box: [answered("<html>a model that ignored the schema</html>", "open-weights-alpha")],
      workers_ai: [answered(JSON.stringify({ answer: "ok" }), "hosted-beta")],
    });
    const result = await callModelGateway(baseInput({ chain: ["local_box", "workers_ai"] }), h.deps);
    if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
    expect(result.attempts[0]?.outcome).toBe("invalid_output");
    expect(result.providerKey).toBe("workers_ai");
  });

  it("an empty eligible chain returns unavailable without calling anything", async () => {
    const h = harness({ local_box: [answered("never", "open-weights-alpha")] });
    const result = await callModelGateway(baseInput({ chain: ["openrouter"] }), {
      ...h.deps,
      adapters: registryOf(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_eligible_provider");
    expect(result.attempts).toEqual([]);
    expect(result.skipped).toEqual([{ providerKey: "openrouter", reason: "no_adapter" }]);
  });
});

describe("clearance is never relaxed to find a provider (AGENTS.md §4.3)", () => {
  it("a client_confidential payload produces zero calls to DeepSeek, OpenRouter and Workers AI", async () => {
    const h = harness({
      local_box: [failed("connection")],
      workers_ai: [answered(JSON.stringify({ answer: "must not be reached" }), "hosted-beta")],
      claude: [failed("connection")],
      deepseek: [answered(JSON.stringify({ answer: "must not be reached" }), "hosted-delta")],
      openrouter: [answered(JSON.stringify({ answer: "must not be reached" }), "hosted-epsilon")],
    });
    const result = await callModelGateway(
      baseInput({
        dataClass: "client_confidential",
        tenantPolicy: { client_confidential: [...FULL_COMPOSE_CHAIN] },
      }),
      h.deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The two cleared providers were both tried and both failed; the chain never widened.
    expect(result.reason).toBe("all_attempts_failed");
    for (const providerKey of ["workers_ai", "deepseek", "openrouter"]) {
      expect(adapterFor(h, providerKey).calls, `${providerKey} received the payload`).toHaveLength(0);
    }
    expect(
      result.skipped.filter((skip) => skip.reason === "not_cleared").map((skip) => skip.providerKey),
    ).toEqual(["workers_ai", "deepseek", "openrouter"]);
    expect(adapterFor(h, "local_box").calls).toHaveLength(1);
    expect(adapterFor(h, "claude").calls).toHaveLength(1);
  });

  it("a restricted payload with the local box offline returns unavailable and never falls through to the cloud", async () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000 });
    book.recordFailure("local_box", T0);
    const h = harness(
      {
        local_box: [answered("never", "open-weights-alpha")],
        workers_ai: [answered(JSON.stringify({ answer: "never" }), "hosted-beta")],
        claude: [answered(JSON.stringify({ answer: "never" }), "hosted-gamma")],
        deepseek: [answered(JSON.stringify({ answer: "never" }), "hosted-delta")],
        openrouter: [answered(JSON.stringify({ answer: "never" }), "hosted-epsilon")],
      },
      { book },
    );
    const result = await callModelGateway(baseInput({ dataClass: "restricted" }), h.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_eligible_provider");
    for (const adapter of h.adapters) expect(adapter.calls, `${adapter.providerKey} was called`).toHaveLength(0);
    expect(result.skipped).toContainEqual({ providerKey: "local_box", reason: "circuit_open" });
  });

  it("a restricted payload is answered by the local box when the box is up", async () => {
    const h = harness({ local_box: [answered(JSON.stringify({ answer: "restricted ok" }), "open-weights-alpha")] });
    const result = await callModelGateway(baseInput({ dataClass: "restricted", chain: ["local_box"] }), h.deps);
    if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
    expect(result.chainPosition).toBe(1);
  });
});

describe("metering every attempt (plan §12.3, F19 reserve-only)", () => {
  it("each attempt is reserved before the call and reconciled after, including the free local box", async () => {
    const h = harness({
      local_box: [failed("connection")],
      workers_ai: [answered(JSON.stringify({ answer: "ok" }), "hosted-beta")],
    });
    const result = await callModelGateway(baseInput({ chain: ["local_box", "workers_ai"] }), h.deps);
    if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
    const [first, second] = result.attempts;
    if (!first || !second) throw new Error("expected two attempts");
    expect(h.meter.events).toEqual([
      `reserve:local_box:${first.attemptId}`,
      `reconcile:released:${first.attemptId}`,
      `reserve:workers_ai:${second.attemptId}`,
      `reconcile:settled:${second.attemptId}`,
    ]);
    expect(first.reservedUnits).toEqual({
      maxInputUnits: expect.any(Number),
      maxOutputUnits: 600,
    });
    expect(second.reservedUnits).toEqual({
      maxInputUnits: expect.any(Number),
      maxOutputUnits: 600,
    });
    expect(result.usage).toEqual({ inputUnits: 40, outputUnits: 12 });
  });

  it("an ambiguous attempt is reconciled as potentially billed, never released", async () => {
    for (const kind of ["timeout", "invalid_output", "server_error"] as const) {
      const h = harness({
        local_box: [failed(kind, true)],
        workers_ai: [answered(JSON.stringify({ answer: "ok" }), "hosted-beta")],
      });
      const result = await callModelGateway(baseInput({ chain: ["local_box", "workers_ai"] }), h.deps);
      if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
      const [first] = result.attempts;
      if (!first) throw new Error("expected an attempt");
      expect(h.meter.byAttempt.get(first.attemptId)?.reconciled, kind).toBe("ambiguous");
      expect(h.meter.byAttempt.get(first.attemptId)?.reserved, kind).toBe(true);
    }
  });

  it("fails closed when the reservation authority is unavailable: no provider is called at all", async () => {
    const h = harness({ local_box: [answered("never", "open-weights-alpha")] });
    h.meter.reserveThrows = true;
    const result = await callModelGateway(baseInput(), h.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("budget_authority_unavailable");
    for (const adapter of h.adapters) expect(adapter.calls).toHaveLength(0);
  });

  it("the stage deadline stops the walk instead of letting it run on (plan §8.3)", async () => {
    const h = harness({ local_box: [failed("connection")] });
    const result = await callModelGateway(baseInput({ stageDeadlineMs: 0 }), h.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("deadline");
    expect(adapterFor(h, "local_box").calls).toHaveLength(0);
  });
});

describe("verify through the gateway: rule (e) is not the caller's job (plan §12.4 (e))", () => {
  it("skips the model that composed the answer and asks the next eligible one", async () => {
    const h = harness(
      {
        local_box: [answered(JSON.stringify({ answer: "must not verify its own work" }), "open-weights-alpha")],
        claude: [answered(JSON.stringify({ answer: "supported" }), "hosted-gamma")],
      },
      {
        // A box verifier model is recorded (issue #9 option B, later decision) and it is the same
        // model that just composed this answer, so rule (e) is what removes it - not the tier.
        config: testConfiguration({
          endpoints: M1_ENDPOINTS.map((endpoint) =>
            endpoint.providerKey === "local_box"
              ? { ...endpoint, verifierModel: { model: "open-weights-alpha", evalSetVersion: "ev-0002" } }
              : endpoint,
          ),
        }),
      },
    );
    const result = await callModelGateway(
      {
        ...baseInput({ chain: ["local_box", "claude"], dataClass: "internal" }),
        task: "verify",
        minTier: "medium",
        composedWith: { providerKey: "local_box", model: "open-weights-alpha" },
      },
      h.deps,
    );
    if (!result.ok) throw new Error(`expected a verifier, got ${result.reason}`);
    expect(result.providerKey).toBe("claude");
    expect(result.chainPosition).toBe(2);
    expect(result.skipped).toContainEqual({ providerKey: "local_box", reason: "composed_the_answer" });
    expect(adapterFor(h, "local_box").calls).toHaveLength(0);
    expect(result.attempts.map((attempt) => attempt.providerKey)).toEqual(["claude"]);
  });
});

describe("configuration error and deployment gap are different findings (F40 replay)", () => {
  it("no endpoint row in the reviewed configuration skips with no_endpoint, and nothing is called", async () => {
    const h = harness(
      {
        local_box: [failed("connection")],
        claude: [answered(JSON.stringify({ answer: "never" }), "hosted-gamma")],
      },
      { config: testConfiguration({ endpoints: M1_ENDPOINTS.filter((entry) => entry.providerKey !== "claude") }) },
    );
    const result = await callModelGateway(baseInput({ chain: ["local_box", "claude"], dataClass: "internal" }), h.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.skipped).toEqual([{ providerKey: "claude", reason: "no_endpoint" }]);
    expect(result.attempts.map((attempt) => attempt.providerKey)).toEqual(["local_box"]);
    expect(adapterFor(h, "claude").calls).toHaveLength(0);
  });

  it("no adapter registered in this deployment skips with no_adapter (issue #46: Claude lands in T-215)", async () => {
    const h = harness({ local_box: [failed("connection")] });
    const result = await callModelGateway(baseInput({ chain: ["local_box", "claude"], dataClass: "internal" }), h.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.skipped).toEqual([{ providerKey: "claude", reason: "no_adapter" }]);
    expect(result.attempts.map((attempt) => attempt.providerKey)).toEqual(["local_box"]);
  });
});

describe("progress events and employee-visible output (plan §9.3, issue #16 N5)", () => {
  it("advances emit chain positions with a closed reason set, never provider names", async () => {
    const h = harness({
      local_box: [failed("rate_limited")],
      workers_ai: [failed("connection")],
      claude: [answered(JSON.stringify({ answer: "ok" }), "hosted-gamma")],
    });
    const result = await callModelGateway(baseInput({ chain: ["local_box", "workers_ai", "claude"] }), h.deps);
    if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
    expect(h.events).toHaveLength(2);
    for (const event of h.events) {
      ProgressEvent.parse(event);
      expect(event.type).toBe("tier_changed");
    }
    const reasons: TierChangeReason[] = ["quota_exhausted", "provider_unavailable"];
    expect(h.events.map((event) => (event.type === "tier_changed" ? event.reason : null))).toEqual(reasons);
    expect(
      h.events.map((event) => (event.type === "tier_changed" ? [event.fromTier, event.toTier] : null)),
    ).toEqual([
      [1, 2],
      [2, 3],
    ]);
    const serialized = JSON.stringify(h.events);
    for (const name of ["local_box", "workers_ai", "claude", "deepseek", "openrouter", "hosted-"]) {
      expect(serialized).not.toContain(name);
    }
  });

  it("no provider name or model id reaches the employee-visible unavailable message", async () => {
    const h = harness({ local_box: [failed("connection")] });
    const result = await callModelGateway(baseInput({ dataClass: "restricted", chain: ["local_box"] }), h.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(UNAVAILABLE_MESSAGE).not.toMatch(/local_box|workers_ai|claude|deepseek|openrouter|hosted-/i);
    expect(result.reason).toBe("all_attempts_failed");
    // `attempts` and `skipped` are run-audit content (F40); the chat layer renders `reason` only.
    expect(JSON.stringify({ rendered: UNAVAILABLE_MESSAGE, reason: result.reason })).not.toMatch(
      /local_box|hosted-|open-weights/i,
    );
  });

  it("organisation and run come from TenantContext and the run, not from a free parameter (AGENTS.md §4.1)", async () => {
    const context = syntheticContext();
    const h = harness({ local_box: [answered(JSON.stringify({ answer: "ok" }), "open-weights-alpha")] });
    await callModelGateway(baseInput({ context, chain: ["local_box"] }), h.deps);
    expect(h.meter.reserveCalls.map((call) => call.organisationId)).toEqual([context.organisationId]);
    expect(h.meter.reserveCalls.map((call) => call.runId)).toEqual([RUN_ID]);
  });
});
