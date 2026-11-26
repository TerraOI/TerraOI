import type { HealthObservationSink } from "./health";
import {
  createHealthObservationSinkFromConfigDb,
  type ConfigDbBinding,
  type ConfigDbDeps,
} from "./health-config-db";

/**
 * T-314 PR-5: production seam for F37 observation persistence.
 *
 * `GatewayDeps.health` stays the isolate `CircuitBook` (PR-2). The optional sink is for
 * `runScheduledHealthChecks` / passive helpers only. Returns `null` when `CONFIG_DB` is unbound —
 * never invent an in-memory sink that would look like durable health in production (T-004 §20.8).
 */

export type GatewayEnv = {
  /** Hyperdrive binding for `toi_gateway_config` over CONFIG_DB (#134). */
  CONFIG_DB?: ConfigDbBinding | null;
};

export function createProductionHealthObservationSink(
  env: GatewayEnv,
  deps: Omit<ConfigDbDeps, "binding"> = {},
): HealthObservationSink | null {
  return createHealthObservationSinkFromConfigDb({
    ...deps,
    binding: env.CONFIG_DB ?? null,
  });
}
