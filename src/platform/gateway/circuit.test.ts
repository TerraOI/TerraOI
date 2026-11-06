import { describe, expect, it } from "vitest";

import { fakeProbe, registryOf, type FakeProbe } from "./gateway-fixtures";
import { CircuitBook, checkProviderHealth } from "./circuit";

/**
 * F37 circuit state (plan §12.4 chain walking (b): "A circuit opens after repeated failures and
 * closes after a cooldown and successful health check (F37)").
 */

const T0 = 1_730_000_000_000;

describe("circuit state (plan §12.4 (b))", () => {
  it("opens only after repeated failures, not on the first one", () => {
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
    book.recordFailure("local_box", T0);
    expect(book.availability("local_box", T0 + 1)).toBe("available");
    book.recordFailure("local_box", T0 + 1);
    expect(book.availability("local_box", T0 + 2)).toBe("circuit_open");
  });

  it("a success before the threshold resets the failure count", () => {
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
    book.recordFailure("local_box", T0);
    book.recordSuccess("local_box", T0 + 1);
    book.recordFailure("local_box", T0 + 2);
    expect(book.availability("local_box", T0 + 3)).toBe("available");
  });

  it("a timeout counts as a failure: nothing came back, so nothing proves the route is alive", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 30_000 });
    book.recordFailure("workers_ai", T0);
    expect(book.availability("workers_ai", T0)).toBe("circuit_open");
  });

  it("an open circuit stays open through the cooldown and becomes usable after it", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 10_000 });
    book.recordFailure("local_box", T0);
    expect(book.availability("local_box", T0 + 9_000)).toBe("circuit_open");
    expect(book.availability("local_box", T0 + 10_000)).toBe("available");
  });

  it("closes after a successful health check even while the cooldown is running", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000 });
    book.recordFailure("local_box", T0);
    expect(book.availability("local_box", T0 + 1)).toBe("circuit_open");
    book.noteHealthCheck("local_box", true, T0 + 2);
    expect(book.availability("local_box", T0 + 3)).toBe("available");
  });

  it("a failed health check keeps the circuit open and restarts the cooldown window", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 10_000 });
    book.recordFailure("local_box", T0);
    book.noteHealthCheck("local_box", false, T0 + 9_000);
    expect(book.availability("local_box", T0 + 15_000)).toBe("circuit_open");
    expect(book.availability("local_box", T0 + 18_999)).toBe("circuit_open");
    expect(book.availability("local_box", T0 + 19_000)).toBe("available");
  });

  it("the cooldown probe re-opens the circuit when the next attempt fails again", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 10_000 });
    book.recordFailure("local_box", T0);
    expect(book.availability("local_box", T0 + 10_000)).toBe("available");
    book.recordFailure("local_box", T0 + 10_001);
    expect(book.availability("local_box", T0 + 15_000)).toBe("circuit_open");
  });

  it("one provider's circuit never affects another provider's chain entry", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 30_000 });
    book.recordFailure("local_box", T0);
    expect(book.availability("local_box", T0 + 1)).toBe("circuit_open");
    expect(book.availability("workers_ai", T0 + 1)).toBe("available");
  });

  it("quota state is reported separately from the circuit", () => {
    const book = new CircuitBook();
    expect(book.quotaExhausted("workers_ai")).toBe(false);
    book.noteQuotaExhausted("workers_ai", true);
    expect(book.quotaExhausted("workers_ai")).toBe(true);
    expect(book.availability("workers_ai", T0)).toBe("available");
  });

  it("checkProviderHealth asks the adapter's health endpoint and records what it saw (F37)", async () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 60_000 });
    const down = fakeProbe("local_box", { healthy: false });
    const up = fakeProbe("local_box", { healthy: true });
    book.recordFailure("local_box", T0);

    expect(await checkProviderHealth("local_box", { probes: registryOf(down), book, nowMs: T0 + 1 })).toBe(false);
    expect(book.availability("local_box", T0 + 2)).toBe("circuit_open");
    expect(down.healthChecks).toBe(1);

    expect(await checkProviderHealth("local_box", { probes: registryOf(up), book, nowMs: T0 + 3 })).toBe(true);
    expect(book.availability("local_box", T0 + 4)).toBe("available");
  });

  it("a provider with no health endpoint is reported unhealthy, never assumed healthy", async () => {
    const book = new CircuitBook();
    const healthy = await checkProviderHealth("claude", { probes: registryOf<FakeProbe>(), book, nowMs: T0 });
    expect(healthy).toBe(false);
    expect(book.snapshot("claude").state).toBe("open");
  });
});
