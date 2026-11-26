import { describe, expect, it } from "vitest";

import { createProductionHealthObservationSink, runProductionScheduledHealthChecks } from "./bundle";
import { CircuitBook } from "./circuit";
import { fakeProbe, registryOf } from "./gateway-fixtures";
import type { ConfigSql } from "./health-config-db";
import type { HealthObservation } from "./health";

const SAMPLE: HealthObservation = {
  providerKey: "workers_ai",
  checkedAtMs: 1_700_000_000_000,
  status: "healthy",
  latencyMs: 12,
  circuitOpen: false,
  observedBy: "scheduled",
};

const T0 = 1_730_000_000_000;

function recordingSql(): { sql: ConfigSql; calls: string[] } {
  const calls: string[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      calls.push(strings.join(""));
      return [];
    },
    { end: async () => undefined },
  ) as ConfigSql;
  return { sql, calls };
}

describe("createProductionHealthObservationSink", () => {
  it("returns null when CONFIG_DB is unbound (fail closed)", () => {
    expect(createProductionHealthObservationSink({})).toBeNull();
    expect(createProductionHealthObservationSink({ CONFIG_DB: null })).toBeNull();
  });

  it("wires a bound CONFIG_DB into a recording observation sink", async () => {
    const { sql, calls } = recordingSql();
    const sink = createProductionHealthObservationSink(
      { CONFIG_DB: { connectionString: "unused-when-openSql-injected" } },
      { openSql: () => sql },
    );
    expect(sink).not.toBeNull();
    await sink!.record(SAMPLE);
    expect(calls.some((c) => c.includes("record_provider_health_v1"))).toBe(true);
  });
});

describe("runProductionScheduledHealthChecks", () => {
  it("unbound CONFIG_DB still probes and marks CircuitBook unhealthy (null sink, fail closed)", async () => {
    const book = new CircuitBook({ openAfterFailures: 3, cooldownMs: 60_000, checkIntervalMs: 15_000 });
    const probe = fakeProbe("local_box", { healthy: false });

    const results = await runProductionScheduledHealthChecks({
      env: {},
      providerKeys: ["local_box"],
      probes: registryOf(probe),
      book,
      nowMs: T0,
    });

    expect(probe.healthChecks).toBe(1);
    expect(results.get("local_box")).toBe(false);
    expect(book.availability("local_box", T0 + 1)).toBe("unhealthy");
  });

  it("bound CONFIG_DB records scheduled observations through the production sink", async () => {
    const { sql, calls } = recordingSql();
    const book = new CircuitBook({ openAfterFailures: 3, cooldownMs: 60_000, checkIntervalMs: 15_000 });
    const probe = fakeProbe("workers_ai", { healthy: true });

    const results = await runProductionScheduledHealthChecks({
      env: { CONFIG_DB: { connectionString: "unused-when-openSql-injected" } },
      providerKeys: ["workers_ai"],
      probes: registryOf(probe),
      book,
      nowMs: T0,
      configDbDeps: { openSql: () => sql },
    });

    expect(probe.healthChecks).toBe(1);
    expect(results.get("workers_ai")).toBe(true);
    expect(book.availability("workers_ai", T0 + 1)).toBe("available");
    expect(calls.some((c) => c.includes("record_provider_health_v1"))).toBe(true);
  });
});
