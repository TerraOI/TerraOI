import { describe, expect, it } from "vitest";

import {
  createHealthObservationSinkFromConfigDb,
  createRecordProviderHealthExecFromSql,
  type ConfigSql,
} from "./health-config-db";
import { observationToRecordArgs } from "./health-persist";
import type { HealthObservation } from "./health";

/**
 * T-314 PR-5: CONFIG_DB → createPersistingHealthObservationSink (#134 / F37).
 */

const SAMPLE: HealthObservation = {
  providerKey: "local_box",
  checkedAtMs: 1_730_000_015_000,
  status: "down",
  latencyMs: 42,
  circuitOpen: true,
  observedBy: "scheduled",
};

type Call = { sql: string; values: unknown[] };

function recordingSql(handler: (call: Call) => Promise<Record<string, unknown>[]>): {
  sql: ConfigSql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ""),
      "",
    );
    const call = { sql: text.replace(/\s+/g, " ").trim(), values };
    calls.push(call);
    return handler(call);
  }) as ConfigSql;
  sql.end = async () => undefined;
  return { sql, calls };
}

describe("createRecordProviderHealthExecFromSql — CONFIG_DB Hyperdrive carrier", () => {
  it("returns null when CONFIG_DB is not bound (fail closed, not an in-memory substitute)", () => {
    expect(createRecordProviderHealthExecFromSql({})).toBeNull();
    expect(createRecordProviderHealthExecFromSql({ binding: null })).toBeNull();
  });

  it("calls record_provider_health_v1 once per record with bound parameters and sets toi_gateway_config", async () => {
    const { sql, calls } = recordingSql(async () => []);
    const exec = createRecordProviderHealthExecFromSql({ openSql: () => sql });
    expect(exec).not.toBeNull();

    const args = observationToRecordArgs(SAMPLE);
    await exec!(args);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    const writer = calls.find((c) => c.sql.includes("record_provider_health_v1"));
    expect(writer).toBeDefined();
    expect(writer?.sql).not.toContain("local_box");
    expect(writer?.values[0]).toBe("local_box");
    expect(writer?.values[1]).toBe("down");
    expect(writer?.values[2]).toBe(42);
    expect(writer?.values[3]).toBe(true);
    expect(writer?.values[4]).toBe("scheduled");
    expect(writer?.values[5]).toBe(args.checkedAt);
    expect(writer?.values[6]).toBeNull();

    expect(calls.some((c) => /set local role toi_gateway_config/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => c.sql === "begin")).toBe(true);
    expect(calls.some((c) => c.sql === "commit")).toBe(true);
  });

  it("refuses a blank provider key before opening SQL", async () => {
    const { sql, calls } = recordingSql(async () => []);
    const exec = createRecordProviderHealthExecFromSql({ openSql: () => sql })!;

    await expect(
      exec({
        ...observationToRecordArgs(SAMPLE),
        providerKey: "   ",
      }),
    ).rejects.toThrow(/providerKey is required/);
    expect(calls).toHaveLength(0);
  });

  it("never puts CONFIG_DB connection strings in thrown error messages", async () => {
    // Synthetic sentinel only — not a credential. Scrubber must still strip URI-shaped fragments.
    const sentinel = "postgresql://toi_gateway_config:redacted@127.0.0.1/terraoi";
    const sql = (async () => {
      throw new Error(`connect ECONNREFUSED ${sentinel}`);
    }) as unknown as ConfigSql;
    sql.end = async () => undefined;

    const exec = createRecordProviderHealthExecFromSql({
      binding: { connectionString: sentinel },
      openSql: () => sql,
    })!;

    let thrown: unknown;
    try {
      await exec(observationToRecordArgs(SAMPLE));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = String((thrown as Error).message);
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain("redacted@127.0.0.1");
    expect(message).not.toMatch(/postgres(ql)?:\/\//i);
  });
});

describe("createHealthObservationSinkFromConfigDb", () => {
  it("returns null when unbound (fail closed)", () => {
    expect(createHealthObservationSinkFromConfigDb({})).toBeNull();
    expect(createHealthObservationSinkFromConfigDb({ binding: null })).toBeNull();
  });

  it("composes CONFIG_DB exec into a persisting observation sink", async () => {
    const { sql, calls } = recordingSql(async () => []);
    const sink = createHealthObservationSinkFromConfigDb({ openSql: () => sql });
    expect(sink).not.toBeNull();

    await sink!.record(SAMPLE);
    expect(calls.some((c) => c.sql.includes("record_provider_health_v1"))).toBe(true);
    expect(calls.filter((c) => c.sql.includes("record_provider_health_v1"))).toHaveLength(1);
  });
});