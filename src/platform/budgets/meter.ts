import type { TaskClass } from "@/contracts/provider-route";

import type { MeterPort } from "@/platform/gateway/call";

/**
 * T-313 PR-1: MeterPort over budget_ledger.reserve_v1 / reconcile_v1 (plan §12.3 F19).
 * SQL runs as toi_budget_ledger on the server path; this module only shapes arguments.
 */

export type BudgetTask = "route" | "compose" | "verify" | "condense" | "ingest";

export interface ReserveBudgetArgs {
  organisationId: string;
  runId: string;
  attemptId: string;
  userId: string | null;
  task: BudgetTask;
  providerKey: string;
  maxInputUnits: number;
  maxOutputUnits: number;
}

export interface ReconcileBudgetArgs {
  organisationId: string;
  attemptId: string;
  reservationId: string;
  outcome: "settled" | "released" | "ambiguous";
  usedUnits: number | null;
}

export type BudgetLedgerExec = {
  reserve(args: ReserveBudgetArgs): Promise<string>;
  reconcile(args: ReconcileBudgetArgs): Promise<void>;
};

const GATEWAY_TASKS = new Set<TaskClass>(["route", "compose", "verify", "condense"]);

function asBudgetTask(task: TaskClass): BudgetTask {
  if (!GATEWAY_TASKS.has(task)) {
    throw new Error("budget meter: unsupported gateway task");
  }
  return task;
}

/**
 * MeterPort that remembers organisationId from reserve() for reconcile() — the gateway MeterPort
 * reconcile shape does not repeat organisationId (call.ts), so the adapter binds it per attempt.
 */
export function createBoundMeterPortFromBudgetLedger(
  exec: BudgetLedgerExec,
  options: { userIdForRun?: (runId: string) => string | null } = {},
): MeterPort {
  const orgByAttempt = new Map<string, string>();
  const userIdForRun = options.userIdForRun ?? (() => null);
  return {
    async reserve(input) {
      const reservationId = await exec.reserve({
        organisationId: input.organisationId,
        runId: input.runId,
        attemptId: input.attemptId,
        userId: userIdForRun(input.runId),
        task: asBudgetTask(input.task),
        providerKey: input.providerKey,
        maxInputUnits: input.maxInputUnits,
        maxOutputUnits: input.maxOutputUnits,
      });
      orgByAttempt.set(input.attemptId, input.organisationId);
      return { reservationId };
    },
    async reconcile(input) {
      const organisationId = orgByAttempt.get(input.attemptId);
      if (!organisationId) {
        throw new Error("budget meter: reconcile without a prior reserve for this attempt");
      }
      const used =
        input.usedInputUnits !== undefined || input.usedOutputUnits !== undefined
          ? (input.usedInputUnits ?? 0) + (input.usedOutputUnits ?? 0)
          : null;
      await exec.reconcile({
        organisationId,
        attemptId: input.attemptId,
        reservationId: input.reservationId,
        outcome: input.outcome,
        usedUnits: used,
      });
      orgByAttempt.delete(input.attemptId);
    },
  };
}

/** In-memory ledger for unit tests: same fail-closed ceilings as the SQL authority. */
export function createInMemoryBudgetLedger(options: {
  dailyCeiling: number;
  concurrentRunCap?: number;
  burstPerUser?: number;
}): BudgetLedgerExec & { reservedUnits: () => number } {
  const concurrentRunCap = options.concurrentRunCap ?? 100;
  const burstPerUser = options.burstPerUser ?? 100;
  const reservations = new Map<
    string,
    { id: string; org: string; runId: string; userId: string | null; max: number; state: string }
  >();
  let reservedUnits = 0;
  let nextId = 1;

  return {
    reservedUnits: () => reservedUnits,
    async reserve(args) {
      const key = `${args.organisationId}:${args.attemptId}`;
      const existing = reservations.get(key);
      if (existing) return existing.id;

      const max = args.maxInputUnits + args.maxOutputUnits;
      if (reservedUnits + max > options.dailyCeiling) {
        throw new Error("daily budget ceiling exceeded");
      }
      const openRuns = new Set(
        [...reservations.values()]
          .filter((r) => r.org === args.organisationId && r.state === "reserved")
          .map((r) => r.runId),
      );
      if (openRuns.size >= concurrentRunCap && !openRuns.has(args.runId)) {
        throw new Error("concurrent run cap exceeded");
      }
      if (args.userId) {
        const burst = [...reservations.values()].filter(
          (r) => r.org === args.organisationId && r.userId === args.userId && r.state === "reserved",
        ).length;
        if (burst >= burstPerUser) throw new Error("per-user burst limit exceeded");
      }

      const id = `res-${nextId++}`;
      reservations.set(key, {
        id,
        org: args.organisationId,
        runId: args.runId,
        userId: args.userId,
        max,
        state: "reserved",
      });
      reservedUnits += max;
      return id;
    },
    async reconcile(args) {
      const key = `${args.organisationId}:${args.attemptId}`;
      const row = reservations.get(key);
      if (!row || row.id !== args.reservationId) throw new Error("reservation not found");
      if (row.state !== "reserved") return;
      row.state = args.outcome;
      reservedUnits = Math.max(0, reservedUnits - row.max);
    },
  };
}
