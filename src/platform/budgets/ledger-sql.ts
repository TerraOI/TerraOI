import postgres from "postgres";

import type { MeterPort } from "@/platform/gateway/call";

import {
  createBoundMeterPortFromBudgetLedger,
  type BudgetLedgerExec,
  type ReconcileBudgetArgs,
  type ReserveBudgetArgs,
} from "./meter";

/**
 * T-313 PR-8: Hyperdrive-backed `BudgetLedgerExec` over `BUDGET_DB` (#134 / T-004).
 *
 * Connects as a login user that is `IN ROLE toi_budget_ledger`. Calls only
 * `budget_ledger.reserve_v1` / `reconcile_v1` — never table SELECT/INSERT. A leaked `BUDGET_DB`
 * credential can reserve and reconcile spend, and nothing else.
 *
 * One short-lived client per operation, `prepare: false` (ADR-0002 / session-db pattern).
 * Returns `null` when the binding is missing — fail closed at the MeterPort seam.
 */

export type BudgetDbBinding = { connectionString: string };

/** Narrow surface used by tests: a tagged-template caller that returns rows. */
export type BudgetSql = {
  <T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  end(options?: { timeout?: number }): Promise<void>;
};

export type BudgetDbDeps = {
  /** Injected in tests; production builds one from `BUDGET_DB`. */
  openSql?: () => BudgetSql;
  binding?: BudgetDbBinding | null;
};

function openFromBinding(binding: BudgetDbBinding): BudgetSql {
  return postgres(binding.connectionString, { prepare: false, max: 1 }) as unknown as BudgetSql;
}

function assertUuid(label: string, value: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`budget ledger: ${label} must be a uuid`);
  }
}

function assertAttemptId(attemptId: string): void {
  if (typeof attemptId !== "string" || attemptId.trim().length === 0 || attemptId.length > 128) {
    throw new Error("budget ledger: attemptId must be 1..128 characters");
  }
}

/**
 * Builds the ledger exec. Returns `null` when unbound — callers treat that as budget authority
 * unavailable (fail closed), never as an infinite free allowance.
 */
export function createBudgetLedgerExecFromSql(deps: BudgetDbDeps): BudgetLedgerExec | null {
  const open: (() => BudgetSql) | null =
    deps.openSql ?? (deps.binding ? () => openFromBinding(deps.binding as BudgetDbBinding) : null);
  if (open === null) return null;
  const openSql = open;

  async function withSql<T>(run: (sql: BudgetSql) => Promise<T>): Promise<T> {
    const sql = openSql();
    try {
      return await run(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  return {
    async reserve(args: ReserveBudgetArgs): Promise<string> {
      assertUuid("organisationId", args.organisationId);
      assertUuid("runId", args.runId);
      assertAttemptId(args.attemptId);
      if (args.userId !== null) assertUuid("userId", args.userId);
      if (!Number.isFinite(args.maxInputUnits) || args.maxInputUnits < 0) {
        throw new Error("budget ledger: maxInputUnits must be a non-negative number");
      }
      if (!Number.isFinite(args.maxOutputUnits) || args.maxOutputUnits < 0) {
        throw new Error("budget ledger: maxOutputUnits must be a non-negative number");
      }

      const rows = await withSql(async (sql) =>
        sql<{ id: string }>`
          select budget_ledger.reserve_v1(
            ${args.organisationId}::uuid,
            ${args.runId}::uuid,
            ${args.attemptId},
            ${args.userId}::uuid,
            ${args.task},
            ${args.providerKey},
            ${args.maxInputUnits}::bigint,
            ${args.maxOutputUnits}::bigint
          ) as id
        `,
      );
      const id = rows[0]?.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("budget ledger: reserve_v1 returned no reservation id");
      }
      return id;
    },

    async reconcile(args: ReconcileBudgetArgs): Promise<void> {
      assertUuid("organisationId", args.organisationId);
      assertUuid("reservationId", args.reservationId);
      assertAttemptId(args.attemptId);
      if (
        args.usedUnits !== null &&
        (!Number.isFinite(args.usedUnits) || args.usedUnits < 0)
      ) {
        throw new Error("budget ledger: usedUnits must be null or a non-negative number");
      }

      await withSql(async (sql) => {
        await sql`
          select budget_ledger.reconcile_v1(
            ${args.organisationId}::uuid,
            ${args.attemptId},
            ${args.reservationId}::uuid,
            ${args.outcome},
            ${args.usedUnits}::bigint
          )
        `;
      });
    },
  };
}

/**
 * T-313 PR-9: compose `BUDGET_DB` → MeterPort for gateway deps.
 *
 * Returns `null` when unbound — the call site must not invent an in-memory ceiling or skip
 * reservation (call.ts maps a missing/throwing meter to `budget_authority_unavailable`).
 */
export function createMeterPortFromBudgetDb(
  deps: BudgetDbDeps,
  options: { userIdForRun?: (runId: string) => string | null } = {},
): MeterPort | null {
  const exec = createBudgetLedgerExecFromSql(deps);
  if (exec === null) return null;
  return createBoundMeterPortFromBudgetLedger(exec, options);
}

export type BudgetGatewayEnv = {
  /** Hyperdrive binding for budget_ledger over BUDGET_DB (#134). */
  BUDGET_DB?: BudgetDbBinding | null;
};

/**
 * T-313 PR-10: production seam for F19 MeterPort.
 * Returns null when BUDGET_DB unbound — never invent an infinite free meter.
 * OWNER binds Hyperdrive (T-004); this helper only maps env → factory.
 */
export function createProductionMeterPort(
  env: BudgetGatewayEnv,
  deps: Omit<BudgetDbDeps, "binding"> = {},
  options?: { userIdForRun?: (runId: string) => string | null },
): MeterPort | null {
  return createMeterPortFromBudgetDb(
    { ...deps, binding: env.BUDGET_DB ?? null },
    options ?? {},
  );
}
