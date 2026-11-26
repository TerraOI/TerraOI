import { describe, expect, it } from "vitest";
import { z } from "zod";

import { callModelGateway, type ModelCallInput } from "./call";
import { CircuitBook } from "./circuit";
import {
  CONVERSATION_ID,
  FULL_COMPOSE_CHAIN,
  RUN_ID,
  answered,
  fakeAdapter,
  fakeProbe,
  recordingMeter,
  registryOf,
  syntheticContext,
  testConfiguration,
} from "./gateway-fixtures";
import { InMemoryHealthObservationSink, isHealthCheckDue, runScheduledHealthChecks } from "./health";
import { selectModelRoute } from "./route";

/**
 * T-314 PR-4 / #74: the week-3 box-offline drill acceptance lines that the agent can prove
 * without stopping owner hardware. Staging steps and the OCR "queued for OCR" half live in
 * `docs/runbooks/box-offline-drill.md` (OWNER stops the box; agent records the result).
 */

const T0 = 1_730_000_000_000;
const INTERVAL = 15_000;

const echoSchema = z.object({ answer: z.string() });

function composeInput(
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

describe("box-offline drill (#74): offline within one check interval", () => {
  it("a box that stops answering is marked unhealthy on the next due scheduled pass", async () => {
    const book = new CircuitBook({ openAfterFailures: 3, cooldownMs: 60_000, checkIntervalMs: INTERVAL });
    const sink = new InMemoryHealthObservationSink();
    const probe = fakeProbe("local_box", { healthy: true });

    await runScheduledHealthChecks({
      providerKeys: ["local_box"],
      probes: registryOf(probe),
      book,
      nowMs: T0,
      sink,
    });
    expect(book.availability("local_box", T0 + 1)).toBe("available");

    probe.healthy = false;
    expect(isHealthCheckDue(book, "local_box", T0 + INTERVAL, INTERVAL)).toBe(true);
    await runScheduledHealthChecks({
      providerKeys: ["local_box"],
      probes: registryOf(probe),
      book,
      nowMs: T0 + INTERVAL,
      sink,
    });
    expect(book.availability("local_box", T0 + INTERVAL + 1)).toBe("unhealthy");
  });
});

describe("box-offline drill (#74): client_confidential advances to Claude only", () => {
  it("never selects DeepSeek or OpenRouter after a scheduled offline mark", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL });
    book.noteScheduledProbe("local_box", false, T0);

    const decision = selectModelRoute(
      { task: "compose", dataClass: "client_confidential", chain: FULL_COMPOSE_CHAIN, nowMs: T0 + 1 },
      {
        config: testConfiguration({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL }),
        health: book,
        adapters: registryOf(
          fakeAdapter("local_box", [answered("no", "open-weights-alpha")]),
          fakeAdapter("claude", [answered("yes", "hosted-gamma")]),
          fakeAdapter("deepseek", [answered("leak", "hosted-delta")]),
          fakeAdapter("openrouter", [answered("leak", "hosted-epsilon")]),
        ),
      },
    );

    expect(decision.eligible.map((e) => e.providerKey)).toEqual(["claude"]);
    expect(decision.eligible.map((e) => e.providerKey)).not.toContain("deepseek");
    expect(decision.eligible.map((e) => e.providerKey)).not.toContain("openrouter");
  });

  it("records zero DeepSeek and OpenRouter adapter calls on the wire", async () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL });
    book.noteScheduledProbe("local_box", false, T0);
    const adapters = [
      fakeAdapter("local_box", [answered(JSON.stringify({ answer: "no" }), "open-weights-alpha")]),
      fakeAdapter("claude", [answered(JSON.stringify({ answer: "ok" }), "hosted-gamma")]),
      fakeAdapter("deepseek", [answered(JSON.stringify({ answer: "leak" }), "hosted-delta")]),
      fakeAdapter("openrouter", [answered(JSON.stringify({ answer: "leak" }), "hosted-epsilon")]),
    ];
    const result = await callModelGateway(composeInput({ dataClass: "client_confidential", nowMs: T0 + 1 }), {
      config: testConfiguration({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL }),
      adapters: registryOf(...adapters),
      health: book,
      meter: recordingMeter(),
    });
    if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
    expect(result.providerKey).toBe("claude");
    expect(adapters.find((a) => a.providerKey === "deepseek")?.calls).toHaveLength(0);
    expect(adapters.find((a) => a.providerKey === "openrouter")?.calls).toHaveLength(0);
  });
});

describe("box-offline drill (#74): restricted returns unavailable", () => {
  it("never falls through to a cloud provider when the box is scheduled-unhealthy", async () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL });
    book.noteScheduledProbe("local_box", false, T0);
    const adapters = [
      fakeAdapter("local_box", [answered(JSON.stringify({ answer: "no" }), "open-weights-alpha")]),
      fakeAdapter("workers_ai", [answered(JSON.stringify({ answer: "no" }), "hosted-beta")]),
      fakeAdapter("claude", [answered(JSON.stringify({ answer: "no" }), "hosted-gamma")]),
      fakeAdapter("deepseek", [answered(JSON.stringify({ answer: "no" }), "hosted-delta")]),
      fakeAdapter("openrouter", [answered(JSON.stringify({ answer: "no" }), "hosted-epsilon")]),
    ];
    const result = await callModelGateway(composeInput({ dataClass: "restricted", nowMs: T0 + 1 }), {
      config: testConfiguration({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL }),
      adapters: registryOf(...adapters),
      health: book,
      meter: recordingMeter(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_eligible_provider");
    for (const adapter of adapters) {
      expect(adapter.calls, `${adapter.providerKey} was called`).toHaveLength(0);
    }
  });
});
