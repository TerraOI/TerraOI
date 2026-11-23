import { describe, expect, it, vi } from "vitest";

import {
  createFreeAllowanceBook,
  isFreeTierProvider,
  planFreeTierAttempt,
} from "./free-allowance";

describe("free-tier unit metering (plan §12.3)", () => {
  it("meters local_box and workers_ai in units at zero cash cost", () => {
    const book = createFreeAllowanceBook({
      allowances: { local_box: 100, workers_ai: 50 },
    });

    const afterBox = book.settle("local_box", 40);
    expect(afterBox.cashCost).toBe(0);
    expect(afterBox.settledUnits).toBe(40);
    expect(afterBox.remainingUnits).toBe(60);

    const afterWorkers = book.settle("workers_ai", 50);
    expect(afterWorkers.cashCost).toBe(0);
    expect(afterWorkers.remainingUnits).toBe(0);
    expect(book.snapshot("workers_ai").settledUnits).toBe(50);
  });

  it("predicts exhaustion and names the next paid tier before any call", () => {
    const book = createFreeAllowanceBook({ allowances: { workers_ai: 10 } });
    const plan = book.predict("workers_ai", 20, ["claude", "deepseek"]);

    expect(plan).toEqual({
      status: "would_exhaust",
      markQuotaExhausted: "workers_ai",
      nextPaidToReserveBeforeCall: "claude",
    });
  });

  it("stays within allowance when the conservative max fits", () => {
    const book = createFreeAllowanceBook({ allowances: { local_box: 100 } });
    expect(book.predict("local_box", 40, ["workers_ai", "claude"])).toEqual({
      status: "within_allowance",
      remainingAfter: 60,
    });
  });

  it("planFreeTierAttempt skips the free provider and surfaces the paid reserve target", () => {
    const book = createFreeAllowanceBook({ allowances: { local_box: 5 } });
    const setQuotaExhausted = vi.fn();

    const decision = planFreeTierAttempt({
      book,
      providerKey: "local_box",
      maxUnits: 50,
      eligibleChainAfterCurrent: ["workers_ai", "claude"],
      setQuotaExhausted,
    });

    expect(decision).toEqual({
      skipFreeProvider: true,
      // workers_ai is still free — first *paid* after the free streak is claude
      nextPaidToReserveBeforeCall: "claude",
    });
    expect(setQuotaExhausted).toHaveBeenCalledWith("local_box", true);
  });

  it("planFreeTierAttempt does not skip when the free allowance covers the estimate", () => {
    const book = createFreeAllowanceBook({ allowances: { local_box: 500 } });
    const setQuotaExhausted = vi.fn();

    expect(
      planFreeTierAttempt({
        book,
        providerKey: "local_box",
        maxUnits: 50,
        eligibleChainAfterCurrent: ["claude"],
        setQuotaExhausted,
      }),
    ).toEqual({ skipFreeProvider: false });
    expect(setQuotaExhausted).not.toHaveBeenCalled();
  });

  it("paid providers are not free-tier metered by this book", () => {
    expect(isFreeTierProvider("claude")).toBe(false);
    expect(isFreeTierProvider("local_box")).toBe(true);

    const book = createFreeAllowanceBook({ allowances: { local_box: 1 } });
    expect(
      planFreeTierAttempt({
        book,
        providerKey: "claude",
        maxUnits: 999,
        eligibleChainAfterCurrent: [],
        setQuotaExhausted: () => undefined,
      }),
    ).toEqual({ skipFreeProvider: false });
  });

  it("exhausting with no paid fallback still marks quota exhausted and reserves nothing free", () => {
    const book = createFreeAllowanceBook({ allowances: { workers_ai: 0 } });
    const setQuotaExhausted = vi.fn();

    expect(
      planFreeTierAttempt({
        book,
        providerKey: "workers_ai",
        maxUnits: 1,
        eligibleChainAfterCurrent: ["local_box"],
        setQuotaExhausted,
      }),
    ).toEqual({
      skipFreeProvider: true,
      nextPaidToReserveBeforeCall: null,
    });
    expect(setQuotaExhausted).toHaveBeenCalledWith("workers_ai", true);
  });
});
