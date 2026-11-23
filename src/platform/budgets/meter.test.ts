import { describe, expect, it } from "vitest";

import {
  createBoundMeterPortFromBudgetLedger,
  createInMemoryBudgetLedger,
} from "./meter";

const ORG = "11111111-1111-4111-8111-111111111111";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

describe("createBoundMeterPortFromBudgetLedger (F19 seam)", () => {
  it("reserves before the call and releases unused liability", async () => {
    const ledger = createInMemoryBudgetLedger({ dailyCeiling: 1_000 });
    const meter = createBoundMeterPortFromBudgetLedger(ledger);

    const { reservationId } = await meter.reserve({
      organisationId: ORG,
      runId: RUN,
      attemptId: "a1",
      task: "compose",
      providerKey: "local_box",
      maxInputUnits: 40,
      maxOutputUnits: 60,
    });
    expect(reservationId).toMatch(/^res-/);
    expect(ledger.reservedUnits()).toBe(100);

    await meter.reconcile({
      attemptId: "a1",
      reservationId,
      outcome: "released",
    });
    expect(ledger.reservedUnits()).toBe(0);
  });

  it("fails closed when the daily ceiling would be exceeded", async () => {
    const ledger = createInMemoryBudgetLedger({ dailyCeiling: 50 });
    const meter = createBoundMeterPortFromBudgetLedger(ledger);

    await expect(
      meter.reserve({
        organisationId: ORG,
        runId: RUN,
        attemptId: "a1",
        task: "compose",
        providerKey: "claude",
        maxInputUnits: 40,
        maxOutputUnits: 20,
      }),
    ).rejects.toThrow(/daily budget ceiling/i);
  });

  it("is idempotent for the same attempt id", async () => {
    const ledger = createInMemoryBudgetLedger({ dailyCeiling: 1_000 });
    const meter = createBoundMeterPortFromBudgetLedger(ledger);
    const input = {
      organisationId: ORG,
      runId: RUN,
      attemptId: "a1",
      task: "compose" as const,
      providerKey: "workers_ai" as const,
      maxInputUnits: 10,
      maxOutputUnits: 10,
    };
    const first = await meter.reserve(input);
    const second = await meter.reserve(input);
    expect(second.reservationId).toBe(first.reservationId);
    expect(ledger.reservedUnits()).toBe(20);
  });

  it("enforces the per-tenant concurrent-run cap", async () => {
    const ledger = createInMemoryBudgetLedger({ dailyCeiling: 10_000, concurrentRunCap: 1 });
    const meter = createBoundMeterPortFromBudgetLedger(ledger);
    await meter.reserve({
      organisationId: ORG,
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      attemptId: "a1",
      task: "compose",
      providerKey: "local_box",
      maxInputUnits: 1,
      maxOutputUnits: 1,
    });
    await expect(
      meter.reserve({
        organisationId: ORG,
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        attemptId: "a2",
        task: "compose",
        providerKey: "local_box",
        maxInputUnits: 1,
        maxOutputUnits: 1,
      }),
    ).rejects.toThrow(/concurrent run cap/i);
  });
});
