import type { ProviderKey } from "@/contracts/keys";

import type { CircuitBook, HealthProbeRegistry } from "./circuit";
import { runScheduledHealthChecks, type HealthObservationSink } from "./health";
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

/**
 * T-314 PR-6: production scheduled F37 pass.
 *
 * Builds the optional Config DB observation sink, then runs `runScheduledHealthChecks` so CircuitBook
 * updates even when `CONFIG_DB` is unbound (fail closed for persistence; probes still run).
 *
 * Cron / wrangler schedule bind is OWNER / T-004 — this helper is the gateway seam only.
 */
export async function runProductionScheduledHealthChecks(input: {
  env: GatewayEnv;
  providerKeys: readonly ProviderKey[];
  probes: HealthProbeRegistry;
  book: CircuitBook;
  nowMs: number;
  /** Optional overrides for ConfigDbDeps (openSql / etc for tests). */
  configDbDeps?: Omit<ConfigDbDeps, "binding">;
}): Promise<ReadonlyMap<ProviderKey, boolean>> {
  const sink = createProductionHealthObservationSink(input.env, input.configDbDeps);
  return runScheduledHealthChecks({
    providerKeys: input.providerKeys,
    probes: input.probes,
    book: input.book,
    nowMs: input.nowMs,
    sink: sink ?? undefined,
  });
}
