import type { ProviderKey } from "@/contracts/keys";

import {
  CircuitBook,
  checkProviderHealth,
  type HealthProbeRegistry,
} from "./circuit";

/**
 * T-314 PR-2: F37 scheduled health pass + observation sink (plan §12.4 (b), §17.1, F37).
 *
 * Persistence of `provider_health` rows is owned by T-116's table and a server-path write function
 * (#45 / #134). Until that writer is wired over `CONFIG_DB`, observations land on an injected sink
 * (in-memory in tests, Worker-side later). Circuit / unhealthy state that chain walking reads stays
 * on `CircuitBook` for the life of the isolate — same assumption #45 confirmed for M1.
 */

export type HealthStatus =
  "healthy" | "degraded" | "down" | "unknown" | "unreachable";

export interface HealthObservation {
  providerKey: ProviderKey;
  checkedAtMs: number;
  status: HealthStatus;
  latencyMs: number | null;
  circuitOpen: boolean;
  observedBy: "scheduled" | "passive";
}

/** Audit/diagnostic view. Never employee-visible (§9.3): it names providers. */
export interface HealthSnapshot {
  providerKey: ProviderKey;
  status: HealthStatus;
  circuitOpen: boolean;
  lastCheckedAtMs: number | null;
  observedBy: "scheduled" | "passive" | null;
  availability: "available" | "circuit_open" | "unhealthy";
}

export interface HealthObservationSink {
  record(observation: HealthObservation): void | Promise<void>;
}

/** Test / isolate-local sink: what would become a `provider_health` insert. */
export class InMemoryHealthObservationSink implements HealthObservationSink {
  readonly observations: HealthObservation[] = [];

  record(observation: HealthObservation): void {
    this.observations.push(observation);
  }
}

export function isHealthCheckDue(
  book: CircuitBook,
  providerKey: ProviderKey,
  nowMs: number,
  checkIntervalMs: number,
): boolean {
  const last = book.snapshot(providerKey).lastCheckedAtMs;
  if (last === null) return true;
  return nowMs - last >= checkIntervalMs;
}

export function readHealthSnapshot(
  book: CircuitBook,
  providerKey: ProviderKey,
  nowMs: number,
): HealthSnapshot {
  const window = book.snapshot(providerKey);
  const availability = book.availability(providerKey, nowMs);
  return {
    providerKey,
    status: book.probeStatus(providerKey),
    circuitOpen: availability === "circuit_open" || window.state === "open",
    lastCheckedAtMs: window.lastCheckedAtMs,
    observedBy: book.lastObservedBy(providerKey),
    availability,
  };
}

/**
 * One scheduled F37 pass: probe every named provider, record what the adapter's `health()` said,
 * and update the circuit book so the next route skips offline providers without waiting on a
 * user-visible call timeout (§17.1).
 */
export async function runScheduledHealthChecks(deps: {
  providerKeys: readonly ProviderKey[];
  probes: HealthProbeRegistry;
  book: CircuitBook;
  nowMs: number;
  sink?: HealthObservationSink;
}): Promise<ReadonlyMap<ProviderKey, boolean>> {
  const results = new Map<ProviderKey, boolean>();

  for (const providerKey of deps.providerKeys) {
    const probe = deps.probes.get(providerKey);
    const started = deps.nowMs;
    let healthy: boolean;
    let latencyMs: number | null = null;
    let status: HealthStatus;

    if (probe?.health === undefined) {
      // Unknown is never reported healthy, and it is not a reason to skip the provider either: the
      // passive circuit governs providers that cannot be probed.
      healthy = false;
      status = "unknown";
      deps.book.noteMissingProbe(providerKey, deps.nowMs);
    } else {
      const before = Date.now();
      try {
        healthy = (await probe.health()) === true;
      } catch {
        // A probe that throws is a failed probe; it must not abort the pass for the providers after it.
        healthy = false;
      }
      latencyMs = Math.max(0, Date.now() - before);
      status = healthy ? "healthy" : "down";
      deps.book.noteScheduledProbe(providerKey, healthy, deps.nowMs);
      // Keep the shared helper's bookkeeping in sync for callers that still use it as the close path.
      if (healthy) {
        deps.book.noteHealthCheck(providerKey, true, deps.nowMs);
      }
    }

    results.set(providerKey, healthy);
    const observation: HealthObservation = {
      providerKey,
      checkedAtMs: started,
      status,
      latencyMs,
      circuitOpen:
        deps.book.availability(providerKey, deps.nowMs) === "circuit_open",
      observedBy: "scheduled",
    };
    await deps.sink?.record(observation);
  }

  return results;
}

/** Passive path: mirror a call-path failure into the observation sink (error-rate / circuit open). */
export function recordPassiveHealthObservation(
  book: CircuitBook,
  providerKey: ProviderKey,
  nowMs: number,
  sink?: HealthObservationSink,
): void {
  const availability = book.availability(providerKey, nowMs);
  const observation: HealthObservation = {
    providerKey,
    checkedAtMs: nowMs,
    status: availability === "available" ? "degraded" : "down",
    latencyMs: null,
    circuitOpen: availability === "circuit_open",
    observedBy: "passive",
  };
  book.notePassiveObservation(providerKey);
  void sink?.record(observation);
}

/** Re-export so F37 callers have one import surface for the single-provider probe. */
export { checkProviderHealth };
