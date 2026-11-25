import { describe, expect, it } from "vitest";

import { callModelGateway } from "./call";
import { CircuitBook } from "./circuit";
import {
  CONVERSATION_ID,
  FULL_COMPOSE_CHAIN,
  RUN_ID,
  answered,
  failed,
  fakeAdapter,
  fakeProbe,
  recordingMeter,
  registryOf,
  syntheticContext,
  testConfiguration,
} from "./gateway-fixtures";
import {
  InMemoryHealthObservationSink,
  isHealthCheckDue,
  readHealthSnapshot,
  runScheduledHealthChecks,
} from "./health";
import { selectModelRoute } from "./route";

/**
 * T-314 PR-2: F37 scheduled + passive health (plan §12.4 (b), §17.1).
 * Offline within one check interval; circuits open on repeated failures and close only after a
 * successful health check; no tenant knob re-opens a platform-taken-out provider.
 */

const T0 = 1_730_000_000_000;
const INTERVAL = 15_000;

describe("F37 scheduled health (plan §17.1: offline within one check interval)", () => {
  it("a box that stops answering is skipped within one check interval, with zero adapter calls", async () => {
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
    expect(probe.healthChecks).toBe(1);

    // The box drops; the next due scheduled pass marks it offline without waiting for a call timeout.
    probe.healthy = false;
    expect(isHealthCheckDue(book, "local_box", T0 + INTERVAL, INTERVAL)).toBe(true);
    await runScheduledHealthChecks({
      providerKeys: ["local_box"],
      probes: registryOf(probe),
      book,
      nowMs: T0 + INTERVAL,
      sink,
    });
    expect(probe.healthChecks).toBe(2);
    expect(book.availability("local_box", T0 + INTERVAL + 1)).toBe("unhealthy");

    const adapter = fakeAdapter("local_box", [answered("should-not-run", "open-weights-alpha")]);
    const result = await callModelGateway(
      {
        context: syntheticContext(),
        runId: RUN_ID,
        conversationId: CONVERSATION_ID,
        task: "compose",
        dataClass: "public",
        chain: ["local_box"],
        messages: [{ role: "user", text: "Q?" }],
        maxOutputUnits: 50,
        callTimeoutMs: 30_000,
        stageDeadlineMs: 60_000,
        nowMs: T0 + INTERVAL + 2,
      },
      {
        config: testConfiguration({ openAfterFailures: 3, cooldownMs: 60_000, checkIntervalMs: INTERVAL }),
        adapters: registryOf(adapter),
        health: book,
        meter: recordingMeter(),
        clock: () => T0 + INTERVAL + 2,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_eligible_provider");
    expect(result.skipped).toContainEqual({ providerKey: "local_box", reason: "unhealthy" });
    expect(adapter.calls).toHaveLength(0);
    expect(sink.observations.some((row) => row.providerKey === "local_box" && row.observedBy === "scheduled")).toBe(
      true,
    );
  });

  it("a health endpoint that fails authentication reads as offline", async () => {
    const book = new CircuitBook({ openAfterFailures: 3, cooldownMs: 60_000, checkIntervalMs: INTERVAL });
    const probe = fakeProbe("local_box", { healthy: false });
    await runScheduledHealthChecks({
      providerKeys: ["local_box"],
      probes: registryOf(probe),
      book,
      nowMs: T0,
    });
    expect(book.availability("local_box", T0 + 1)).toBe("unhealthy");
    const snap = readHealthSnapshot(book, "local_box", T0 + 1);
    expect(snap.status).toBe("down");
    // Snapshot is audit-only: it may name a provider key, but never an employee-facing sentence.
    expect(JSON.stringify(snap)).not.toMatch(/DeepSeek|OpenRouter|Claude|Workers AI|please try|unavailable to you/i);
  });

  it("a provider with no health probe is unknown, never assumed healthy", async () => {
    const book = new CircuitBook({ openAfterFailures: 3, cooldownMs: 60_000, checkIntervalMs: INTERVAL });
    await runScheduledHealthChecks({
      providerKeys: ["claude"],
      probes: registryOf(fakeProbe("workers_ai", { healthy: true })), // claude absent on purpose
      book,
      nowMs: T0,
    });
    expect(book.availability("claude", T0 + 1)).toBe("unhealthy");
    expect(readHealthSnapshot(book, "claude", T0 + 1).status).toBe("unknown");
  });
});

describe("F37 circuit open/close (plan §12.4 (b))", () => {
  it("opens after repeated passive failures and closes only after cooldown and a successful health check", async () => {
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 10_000, checkIntervalMs: INTERVAL });
    const up = fakeProbe("workers_ai", { healthy: true });

    book.recordFailure("workers_ai", T0);
    book.recordFailure("workers_ai", T0 + 1);
    expect(book.availability("workers_ai", T0 + 2)).toBe("circuit_open");

    // Cooldown alone is half-open: one more failure re-opens; a successful scheduled check clears it.
    // Opened at T0+1 with cooldown 10_000 → half-open at T0+1+10_000.
    expect(book.availability("workers_ai", T0 + 1 + 10_000)).toBe("available");
    book.recordFailure("workers_ai", T0 + 1 + 10_001);
    expect(book.availability("workers_ai", T0 + 1 + 10_002)).toBe("circuit_open");

    await runScheduledHealthChecks({
      providerKeys: ["workers_ai"],
      probes: registryOf(up),
      book,
      nowMs: T0 + 1 + 10_003,
    });
    expect(book.availability("workers_ai", T0 + 1 + 10_004)).toBe("available");
  });

  it("an open circuit skips that provider for every tenant; no tenant setting re-opens it", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL });
    book.recordFailure("local_box", T0);

    const company1 = selectModelRoute(
      { task: "compose", dataClass: "public", chain: ["local_box", "workers_ai"], nowMs: T0 + 1 },
      {
        config: testConfiguration({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL }),
        health: book,
        adapters: registryOf(
          fakeAdapter("local_box", [failed("connection")]),
          fakeAdapter("workers_ai", [answered("ok", "hosted-beta")]),
        ),
      },
    );
    const company2 = selectModelRoute(
      {
        task: "compose",
        dataClass: "public",
        chain: ["local_box", "workers_ai"],
        nowMs: T0 + 1,
        // A tenant policy that "approves" the box still cannot reopen a platform-open circuit.
        tenantPolicy: { public: ["local_box", "workers_ai", "claude", "deepseek", "openrouter"] },
      },
      {
        config: testConfiguration({ openAfterFailures: 1, cooldownMs: 60_000, checkIntervalMs: INTERVAL }),
        health: book,
        adapters: registryOf(
          fakeAdapter("local_box", [failed("connection")]),
          fakeAdapter("workers_ai", [answered("ok", "hosted-beta")]),
        ),
      },
    );

    expect(company1.skipped).toContainEqual({ providerKey: "local_box", reason: "circuit_open" });
    expect(company2.skipped).toContainEqual({ providerKey: "local_box", reason: "circuit_open" });
    expect(company1.eligible.map((e) => e.providerKey)).toEqual(["workers_ai"]);
    expect(company2.eligible.map((e) => e.providerKey)).toEqual(["workers_ai"]);
  });

  it("passive error-rate opens the circuit from call failures without a scheduled probe", () => {
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000, checkIntervalMs: INTERVAL });
    book.recordFailure("deepseek", T0);
    expect(book.availability("deepseek", T0 + 1)).toBe("available");
    book.recordFailure("deepseek", T0 + 2);
    expect(book.availability("deepseek", T0 + 3)).toBe("circuit_open");
    const snap = readHealthSnapshot(book, "deepseek", T0 + 3);
    expect(snap.circuitOpen).toBe(true);
    expect(snap.observedBy).toBe("passive");
  });
});

describe("F37 does not relax clearance while unhealthy", () => {
  it("client_confidential never gains DeepSeek/OpenRouter when the box is down", () => {
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

    expect(decision.skipped).toContainEqual({ providerKey: "local_box", reason: "unhealthy" });
    expect(decision.eligible.map((e) => e.providerKey)).toEqual(["claude"]);
    expect(decision.eligible.map((e) => e.providerKey)).not.toContain("deepseek");
    expect(decision.eligible.map((e) => e.providerKey)).not.toContain("openrouter");
  });
});
