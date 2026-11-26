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

  it("enforces the per-user burst limit", async () => {
    const userId = "00000000-0000-4000-8000-0000000000a1";
    const ledger = createInMemoryBudgetLedger({
      dailyCeiling: 10_000,
      concurrentRunCap: 10,
      burstPerUser: 1,
    });
    const meter = createBoundMeterPortFromBudgetLedger(ledger, {
      userIdForRun: () => userId,
    });
    await meter.reserve({
      organisationId: ORG,
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      attemptId: "b1",
      task: "compose",
      providerKey: "local_box",
      maxInputUnits: 1,
      maxOutputUnits: 1,
    });
    await expect(
      meter.reserve({
        organisationId: ORG,
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        attemptId: "b2",
        task: "compose",
        providerKey: "local_box",
        maxInputUnits: 1,
        maxOutputUnits: 1,
      }),
    ).rejects.toThrow(/per-user burst/i);
  });

  it("an ambiguous timeout keeps the first liability and books the retry as its own attempt", async () => {
    const ledger = createInMemoryBudgetLedger({ dailyCeiling: 1_000 });
    const meter = createBoundMeterPortFromBudgetLedger(ledger);

    const first = await meter.reserve({
      organisationId: ORG,
      runId: RUN,
      attemptId: "compose:pass:1",
      task: "compose",
      providerKey: "workers_ai",
      maxInputUnits: 40,
      maxOutputUnits: 60,
    });
    await meter.reconcile({
      attemptId: "compose:pass:1",
      reservationId: first.reservationId,
      outcome: "ambiguous",
    });
    expect(ledger.stateOf(ORG, "compose:pass:1")).toBe("ambiguous");
    expect(ledger.settledUnits()).toBe(100);
    expect(ledger.reservedUnits()).toBe(0);

    // Duplicate outbox / second reconcile against the ledger must not double-book (§12.3).
    await ledger.reconcile({
      organisationId: ORG,
      attemptId: "compose:pass:1",
      reservationId: first.reservationId,
      outcome: "ambiguous",
      usedUnits: null,
    });
    expect(ledger.settledUnits()).toBe(100);

    const retry = await meter.reserve({
      organisationId: ORG,
      runId: RUN,
      attemptId: "compose:pass:2",
      task: "compose",
      providerKey: "claude",
      maxInputUnits: 40,
      maxOutputUnits: 60,
    });
    expect(retry.reservationId).not.toBe(first.reservationId);
    expect(ledger.reservedUnits()).toBe(100);
    expect(ledger.settledUnits()).toBe(100);
  });

  it("ambiguous liability still counts against the daily ceiling", async () => {
    const ledger = createInMemoryBudgetLedger({ dailyCeiling: 150 });
    const meter = createBoundMeterPortFromBudgetLedger(ledger);
    const first = await meter.reserve({
      organisationId: ORG,
      runId: RUN,
      attemptId: "ambig-ceiling",
      task: "compose",
      providerKey: "local_box",
      maxInputUnits: 50,
      maxOutputUnits: 50,
    });
    await meter.reconcile({
      attemptId: "ambig-ceiling",
      reservationId: first.reservationId,
      outcome: "ambiguous",
    });
    await expect(
      meter.reserve({
        organisationId: ORG,
        runId: RUN,
        attemptId: "ambig-ceiling-2",
        task: "compose",
        providerKey: "claude",
        maxInputUnits: 40,
        maxOutputUnits: 40,
      }),
    ).rejects.toThrow(/daily budget ceiling/i);
  });
});
