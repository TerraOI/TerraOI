import { describe, expect, it } from "vitest";

import { createProductionHealthObservationSink } from "./bundle";
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

function recordingSql(): { sql: ConfigSql; calls: string[] } {
  const calls: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    calls.push(strings.join(""));
    return [];
  }) as ConfigSql;
  sql.end = async () => undefined;
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
