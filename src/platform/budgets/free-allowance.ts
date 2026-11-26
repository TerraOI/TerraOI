import type { ProviderKey } from "@/contracts/keys";

/**
 * T-313 PR-2: free-tier unit metering (plan §12.3).
 *
 * Local box and Workers AI are free in cash but still burn units. Exhaustion must be predicted
 * from metered usage so the next paid tier is reserved **before** it is called — never discovered
 * by a provider 429.
 */

/** Providers whose cash cost is zero in M1 but whose units still count against an allowance. */
export const FREE_TIER_PROVIDERS = ["local_box", "workers_ai"] as const;
export type FreeTierProvider = (typeof FREE_TIER_PROVIDERS)[number];

export function isFreeTierProvider(key: ProviderKey): key is FreeTierProvider {
  return (FREE_TIER_PROVIDERS as readonly string[]).includes(key);
}

export type FreeAllowanceSnapshot = {
  providerKey: FreeTierProvider;
  remainingUnits: number;
  settledUnits: number;
  /** Always 0 for free tiers — cash is not the signal; units are. */
  cashCost: 0;
};

export type ExhaustionPlan =
  | { status: "within_allowance"; remainingAfter: number }
  | {
      status: "would_exhaust";
      /** Mark the free provider quota exhausted before walking further. */
      markQuotaExhausted: FreeTierProvider;
      /**
       * Next paid provider in the eligible chain that must be reserved before any network call.
       * Null when the chain has no paid fallback left.
       */
      nextPaidToReserveBeforeCall: ProviderKey | null;
    };

export type FreeAllowanceBook = {
  remaining(providerKey: FreeTierProvider): number;
  snapshot(providerKey: FreeTierProvider): FreeAllowanceSnapshot;
  /**
   * Predict whether `maxUnits` fits the free allowance. When it would exhaust, name the next paid
   * provider that must be reserved before the call (plan §12.3).
   */
  predict(
    providerKey: FreeTierProvider,
    maxUnits: number,
    eligibleChainAfterCurrent: readonly ProviderKey[],
  ): ExhaustionPlan;
  /** Record settled free usage. Cash cost is always 0. */
  settle(
    providerKey: FreeTierProvider,
    usedUnits: number,
  ): FreeAllowanceSnapshot;
  /**
   * `predict` and, when it fits, take `maxUnits` out of the allowance in the same synchronous step,
   * so two calls in flight in one isolate cannot both be admitted against the same units
   * (supervisor round 1 on #256, B1).
   */
  hold(
    providerKey: FreeTierProvider,
    maxUnits: number,
    eligibleChainAfterCurrent: readonly ProviderKey[],
  ): ExhaustionPlan;
  /**
   * Close a hold: return the held units, then settle what was used. `usedUnits: null` means the
   * model may have run but reported no usage, so the whole hold is kept as used (conservative).
   */
  finish(
    providerKey: FreeTierProvider,
    heldUnits: number,
    usedUnits: number | null,
  ): FreeAllowanceSnapshot;
};

function firstPaid(chain: readonly ProviderKey[]): ProviderKey | null {
  for (const key of chain) {
    if (!isFreeTierProvider(key)) return key;
  }
  return null;
}

/**
 * In-memory free-allowance book for Worker-isolate admission. It is isolate-local, so it is an early
 * skip, not the authority: two isolates each hold their own copy, and the allowance never refills
 * inside one. Persistence of quota windows across isolates and restarts is #45 / T-314 health.
 */
export function createFreeAllowanceBook(options: {
  allowances: Partial<Record<FreeTierProvider, number>>;
}): FreeAllowanceBook {
  const remaining: Record<FreeTierProvider, number> = {
    local_box: options.allowances.local_box ?? Number.POSITIVE_INFINITY,
    workers_ai: options.allowances.workers_ai ?? Number.POSITIVE_INFINITY,
  };
  const settled: Record<FreeTierProvider, number> = {
    local_box: 0,
    workers_ai: 0,
  };

  const snap = (providerKey: FreeTierProvider): FreeAllowanceSnapshot => ({
    providerKey,
    remainingUnits: remaining[providerKey],
    settledUnits: settled[providerKey],
    cashCost: 0,
  });

  function settle(
    providerKey: FreeTierProvider,
    usedUnits: number,
  ): FreeAllowanceSnapshot {
    if (!(usedUnits >= 0)) {
      throw new Error("free allowance: usedUnits must be >= 0");
    }
    const burn = Math.min(usedUnits, remaining[providerKey]);
    remaining[providerKey] -= burn;
    settled[providerKey] += burn;
    return snap(providerKey);
  }

  function predict(
    providerKey: FreeTierProvider,
    maxUnits: number,
    eligibleChainAfterCurrent: readonly ProviderKey[],
  ): ExhaustionPlan {
    if (!(maxUnits >= 0)) {
      throw new Error("free allowance: maxUnits must be >= 0");
    }
    const left = remaining[providerKey];
    if (maxUnits <= left) {
      return { status: "within_allowance", remainingAfter: left - maxUnits };
    }
    return {
      status: "would_exhaust",
      markQuotaExhausted: providerKey,
      nextPaidToReserveBeforeCall: firstPaid(eligibleChainAfterCurrent),
    };
  }

  return {
    remaining: (providerKey) => remaining[providerKey],
    snapshot: snap,
    predict,
    settle,
    hold(providerKey, maxUnits, eligibleChainAfterCurrent) {
      const plan = predict(providerKey, maxUnits, eligibleChainAfterCurrent);
      if (plan.status === "within_allowance")
        remaining[providerKey] -= maxUnits;
      return plan;
    },
    finish(providerKey, heldUnits, usedUnits) {
      remaining[providerKey] += heldUnits;
      return settle(providerKey, usedUnits === null ? heldUnits : usedUnits);
    },
  };
}

/**
 * Before a free-tier attempt: if the conservative max would exhaust the allowance, mark quota
 * exhausted and return the paid provider that must be reserved next — without calling the free
 * provider. When within allowance, the units are held (`heldUnits`) and the caller must close the
 * hold with `book.finish` whatever the attempt's outcome.
 */
export function planFreeTierAttempt(args: {
  book: FreeAllowanceBook;
  providerKey: ProviderKey;
  maxUnits: number;
  eligibleChainAfterCurrent: readonly ProviderKey[];
  setQuotaExhausted: (
    providerKey: FreeTierProvider,
    exhausted: boolean,
  ) => void;
}):
  | { skipFreeProvider: true; nextPaidToReserveBeforeCall: ProviderKey | null }
  | { skipFreeProvider: false; heldUnits: number } {
  if (!isFreeTierProvider(args.providerKey)) {
    return { skipFreeProvider: false, heldUnits: 0 };
  }
  const plan = args.book.hold(
    args.providerKey,
    args.maxUnits,
    args.eligibleChainAfterCurrent,
  );
  if (plan.status === "within_allowance") {
    return { skipFreeProvider: false, heldUnits: args.maxUnits };
  }
  args.setQuotaExhausted(plan.markQuotaExhausted, true);
  return {
    skipFreeProvider: true,
    nextPaidToReserveBeforeCall: plan.nextPaidToReserveBeforeCall,
  };
}
