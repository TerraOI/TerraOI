import { describe, expect, it } from "vitest";

import { createBoundMeterPortFromBudgetLedger } from "./meter";
import {
  createBudgetLedgerExecFromSql,
  createMeterPortFromBudgetDb,
  type BudgetSql,
} from "./ledger-sql";

const ORG = "11111111-1111-4111-8111-111111111111";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RES = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

type Call = { sql: string; values: unknown[] };

function recordingSql(handler: (call: Call) => Promise<Record<string, unknown>[]>): {
  sql: BudgetSql;
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
  }) as BudgetSql;
  sql.end = async () => undefined;
  return { sql, calls };
}

describe("createBudgetLedgerExecFromSql — BUDGET_DB Hyperdrive carrier", () => {
  it("returns null when BUDGET_DB is not bound (fail closed, not an infinite free allowance)", () => {
    expect(createBudgetLedgerExecFromSql({})).toBeNull();
    expect(createBudgetLedgerExecFromSql({ binding: null })).toBeNull();
  });

  it("reserve calls reserve_v1 with bound parameters and never concatenates ids into SQL text", async () => {
    const { sql, calls } = recordingSql(async () => [{ id: RES }]);
    const exec = createBudgetLedgerExecFromSql({ openSql: () => sql });
    expect(exec).not.toBeNull();

    const id = await exec!.reserve({
      organisationId: ORG,
      runId: RUN,
      attemptId: "compose:1",
      userId: null,
      task: "compose",
      providerKey: "local_box",
      maxInputUnits: 40,
      maxOutputUnits: 60,
    });

    expect(id).toBe(RES);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("budget_ledger.reserve_v1");
    expect(calls[0]?.sql).not.toContain(ORG);
    expect(calls[0]?.sql).not.toContain("compose:1");
    expect(calls[0]?.values[0]).toBe(ORG);
    expect(calls[0]?.values[1]).toBe(RUN);
    expect(calls[0]?.values[2]).toBe("compose:1");
    expect(calls[0]?.values[3]).toBeNull();
    expect(calls[0]?.values[4]).toBe("compose");
    expect(calls[0]?.values[5]).toBe("local_box");
    expect(calls[0]?.values[6]).toBe(40);
    expect(calls[0]?.values[7]).toBe(60);
  });

  it("reconcile calls reconcile_v1 and does not SELECT budget tables", async () => {
    const { sql, calls } = recordingSql(async () => []);
    const exec = createBudgetLedgerExecFromSql({ openSql: () => sql })!;

    await exec.reconcile({
      organisationId: ORG,
      attemptId: "compose:1",
      reservationId: RES,
      outcome: "ambiguous",
      usedUnits: null,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("budget_ledger.reconcile_v1");
    expect(calls[0]?.sql).not.toMatch(/from\s+public\.budget_/i);
    expect(calls[0]?.values[3]).toBe("ambiguous");
  });

  it("refuses a malformed organisation id before opening SQL", async () => {
    const { sql, calls } = recordingSql(async () => [{ id: RES }]);
    const exec = createBudgetLedgerExecFromSql({ openSql: () => sql })!;

    await expect(
      exec.reserve({
        organisationId: "not-a-uuid",
        runId: RUN,
        attemptId: "a1",
        userId: null,
        task: "compose",
        providerKey: "claude",
        maxInputUnits: 1,
        maxOutputUnits: 1,
      }),
    ).rejects.toThrow(/organisationId must be a uuid/);
    expect(calls).toHaveLength(0);
  });

  it("wires through MeterPort: unbound ledger is not silently substituted", async () => {
    expect(createBudgetLedgerExecFromSql({})).toBeNull();
    // Callers must fail closed at the MeterPort seam when null — covered by call.ts budget_authority_unavailable.
  });

  it("createMeterPortFromBudgetDb returns null when unbound (fail closed, no infinite free meter)", () => {
    expect(createMeterPortFromBudgetDb({})).toBeNull();
    expect(createMeterPortFromBudgetDb({ binding: null })).toBeNull();
  });

  it("createMeterPortFromBudgetDb composes SQL exec into a MeterPort", async () => {
    const { sql, calls } = recordingSql(async (call) => {
      if (call.sql.includes("reserve_v1")) return [{ id: RES }];
      return [];
    });
    const meter = createMeterPortFromBudgetDb({ openSql: () => sql });
    expect(meter).not.toBeNull();

    const { reservationId } = await meter!.reserve({
      organisationId: ORG,
      runId: RUN,
      attemptId: "compose:factory:1",
      task: "compose",
      providerKey: "local_box",
      maxInputUnits: 5,
      maxOutputUnits: 5,
    });
    expect(reservationId).toBe(RES);
    await meter!.reconcile({
      attemptId: "compose:factory:1",
      reservationId,
      outcome: "released",
    });
    expect(calls.map((c) => c.sql)).toEqual([
      expect.stringContaining("reserve_v1"),
      expect.stringContaining("reconcile_v1"),
    ]);
  });

  it("createBoundMeterPortFromBudgetLedger works over the SQL exec", async () => {
    const { sql, calls } = recordingSql(async (call) => {
      if (call.sql.includes("reserve_v1")) return [{ id: RES }];
      return [];
    });
    const exec = createBudgetLedgerExecFromSql({ openSql: () => sql })!;
    const meter = createBoundMeterPortFromBudgetLedger(exec);

    const { reservationId } = await meter.reserve({
      organisationId: ORG,
      runId: RUN,
      attemptId: "compose:pass:1",
      task: "compose",
      providerKey: "workers_ai",
      maxInputUnits: 10,
      maxOutputUnits: 10,
    });
    expect(reservationId).toBe(RES);

    await meter.reconcile({
      attemptId: "compose:pass:1",
      reservationId,
      outcome: "settled",
      usedInputUnits: 8,
      usedOutputUnits: 4,
    });

    expect(calls.map((c) => c.sql)).toEqual([
      expect.stringContaining("reserve_v1"),
      expect.stringContaining("reconcile_v1"),
    ]);
    expect(calls[1]?.values[4]).toBe(12);
  });
});
