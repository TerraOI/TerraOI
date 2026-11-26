import postgres from "postgres";

import {
  createPersistingHealthObservationSink,
  type RecordProviderHealthArgs,
  type RecordProviderHealthExec,
} from "./health-persist";
import type { HealthObservationSink, HealthStatus } from "./health";

/**
 * T-314 PR-5: Hyperdrive-backed `RecordProviderHealthExec` over `CONFIG_DB` (#134 / T-004).
 *
 * Connects as a login user that is `IN ROLE toi_gateway_config`, then `SET LOCAL ROLE
 * toi_gateway_config` inside a short transaction. Calls only `gateway_config.record_provider_health_v1`
 * — never table SELECT/INSERT. Returns `null` when the binding is missing (fail closed).
 *
 * One short-lived client per operation, `prepare: false` (ADR-0002 / session-db pattern).
 */

export type ConfigDbBinding = { connectionString: string };

/** Narrow surface used by tests: a tagged-template caller that returns rows. */
export type ConfigSql = {
  <T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  end(options?: { timeout?: number }): Promise<void>;
};

export type ConfigDbDeps = {
  /** Injected in tests; production builds one from `CONFIG_DB`. */
  openSql?: () => ConfigSql;
  binding?: ConfigDbBinding | null;
};

const HEALTH_STATUSES: readonly HealthStatus[] = [
  "healthy",
  "degraded",
  "down",
  "unknown",
  "unreachable",
];

function openFromBinding(binding: ConfigDbBinding): ConfigSql {
  return postgres(binding.connectionString, { prepare: false, max: 1 }) as unknown as ConfigSql;
}

function assertProviderKey(providerKey: string): void {
  if (typeof providerKey !== "string" || providerKey.trim().length === 0) {
    throw new Error("provider health: providerKey is required");
  }
}

function assertHealthStatus(status: string): asserts status is HealthStatus {
  if (!HEALTH_STATUSES.includes(status as HealthStatus)) {
    throw new Error("provider health: status must be an F37 health vocabulary value");
  }
}

function assertObservedBy(observedBy: string): asserts observedBy is "scheduled" | "passive" {
  if (observedBy !== "scheduled" && observedBy !== "passive") {
    throw new Error("provider health: observedBy must be scheduled or passive");
  }
}

function assertLatencyMs(latencyMs: number | null): void {
  if (
    latencyMs !== null &&
    (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 600_000)
  ) {
    throw new Error("provider health: latencyMs out of range");
  }
}

function assertRecordArgs(args: RecordProviderHealthArgs): void {
  assertProviderKey(args.providerKey);
  assertHealthStatus(args.status);
  assertObservedBy(args.observedBy);
  if (typeof args.circuitOpen !== "boolean") {
    throw new Error("provider health: circuitOpen is required");
  }
  assertLatencyMs(args.latencyMs);
  if (typeof args.checkedAt !== "string" || Number.isNaN(Date.parse(args.checkedAt))) {
    throw new Error("provider health: checkedAt must be an ISO timestamp");
  }
  if (
    args.quotaWindowResetAt !== null &&
    (typeof args.quotaWindowResetAt !== "string" || Number.isNaN(Date.parse(args.quotaWindowResetAt)))
  ) {
    throw new Error("provider health: quotaWindowResetAt must be null or an ISO timestamp");
  }
}

function scrubConnectionSecret(error: unknown, connectionString: string | undefined): Error {
  if (!(error instanceof Error)) {
    return new Error("provider health: CONFIG_DB write failed");
  }
  let message = error.message;
  if (connectionString && message.includes(connectionString)) {
    message = message.split(connectionString).join("[CONFIG_DB]");
  }
  if (/postgres(ql)?:\/\//i.test(message)) {
    message = "provider health: CONFIG_DB write failed";
  }
  const sanitized = new Error(message);
  sanitized.name = error.name;
  return sanitized;
}

/**
 * Builds the CONFIG_DB exec. Returns `null` when unbound — callers treat that as persistence unavailable
 * (fail closed), not as a silent in-memory substitute.
 */
export function createRecordProviderHealthExecFromSql(
  deps: ConfigDbDeps,
): RecordProviderHealthExec | null {
  const open: (() => ConfigSql) | null =
    deps.openSql ?? (deps.binding ? () => openFromBinding(deps.binding as ConfigDbBinding) : null);
  if (open === null) return null;
  const openSql = open;
  const connectionSecret = deps.binding?.connectionString;

  async function withSql<T>(run: (sql: ConfigSql) => Promise<T>): Promise<T> {
    const sql = openSql();
    try {
      return await run(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  return async (args: RecordProviderHealthArgs): Promise<void> => {
    assertRecordArgs(args);
    try {
      await withSql(async (sql) => {
        await sql`begin`;
        try {
          await sql`set local role toi_gateway_config`;
          await sql`
            select gateway_config.record_provider_health_v1(
              ${args.providerKey},
              ${args.status},
              ${args.latencyMs},
              ${args.circuitOpen},
              ${args.observedBy},
              ${args.checkedAt}::timestamptz,
              ${args.quotaWindowResetAt}::timestamptz
            )
          `;
          await sql`commit`;
        } catch (inner) {
          try {
            await sql`rollback`;
          } catch {
            // best-effort; connection is closed in withSql finally
          }
          throw inner;
        }
      });
    } catch (error) {
      throw scrubConnectionSecret(error, connectionSecret);
    }
  };
}

/**
 * T-314 PR-5: compose `CONFIG_DB` → `HealthObservationSink` for F37 scheduled and passive paths.
 *
 * Returns `null` when unbound — production must not substitute `InMemoryHealthObservationSink` silently.
 */
export function createHealthObservationSinkFromConfigDb(deps: ConfigDbDeps): HealthObservationSink | null {
  const exec = createRecordProviderHealthExecFromSql(deps);
  if (exec === null) return null;
  return createPersistingHealthObservationSink(exec);
}