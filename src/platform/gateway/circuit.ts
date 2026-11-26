import type { ProviderKey } from "@/contracts/keys";

import type { CircuitPolicy } from "./config";
import type { HealthReader } from "./route";

/**
 * F37 health and circuit state (plan §12.4 chain walking (b), F38 "advances on outage, timeout,
 * 429/5xx…"). §12.4: "A circuit opens after repeated failures and closes after a cooldown and
 * successful health check."
 *
 * In-memory and per process on purpose: #45 confirmed circuit/quota stay in the isolate for M1;
 * T-314's scheduled/passive observations write through an injected sink toward `provider_health`
 * (T-116 owns the table). Nothing here relaxes clearance — it only removes a provider from the
 * chain for a while.
 */

export type CircuitState = "closed" | "open";

interface ProviderWindow {
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs: number | null;
  lastCheckedAtMs: number | null;
  quotaExhausted: boolean;
  /** Last scheduled probe outcome; `null` means never probed this isolate life. */
  lastProbeHealthy: boolean | null;
  /** True when the scheduled pass found no `health()` endpoint (unknown ≠ healthy). */
  probeMissing: boolean;
  lastObservedBy: "scheduled" | "passive" | null;
}

/** F37: an adapter may expose a health endpoint. `complete` is not needed to answer this. */
export interface HealthProbe {
  health?(): Promise<boolean>;
}

export interface HealthProbeRegistry {
  get(providerKey: ProviderKey): HealthProbe | undefined;
}

/** What the chain writer records after an attempt; a timeout is a failure, not a maybe. */
export interface HealthWriter {
  recordSuccess(providerKey: ProviderKey, nowMs: number): void;
  recordFailure(providerKey: ProviderKey, nowMs: number): void;
  noteQuotaExhausted(providerKey: ProviderKey, exhausted: boolean): void;
}

const DEFAULT_POLICY: CircuitPolicy = {
  openAfterFailures: 3,
  cooldownMs: 60_000,
  checkIntervalMs: 30_000,
};

export class CircuitBook implements HealthReader, HealthWriter {
  private readonly windows = new Map<ProviderKey, ProviderWindow>();
  private readonly policy: CircuitPolicy;

  constructor(policy: Partial<CircuitPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  availability(
    providerKey: ProviderKey,
    nowMs: number,
  ): "available" | "circuit_open" | "unhealthy" {
    const current = this.window(providerKey);
    if (current.state === "open") {
      // The cooldown is the health-check window. Once it passes, the next attempt *is* the probe:
      // the circuit is left one failure short of open, so a probe that fails again re-opens it
      // immediately instead of letting a broken provider take `openAfterFailures` calls each time.
      if (
        current.openedAtMs === null ||
        nowMs - current.openedAtMs < this.policy.cooldownMs
      ) {
        return "circuit_open";
      }
      // Half-open: the next call is the probe. Clear a prior scheduled-down mark so the attempt
      // can run; a failed call re-opens via recordFailure, a successful scheduled check clears it
      // properly through noteScheduledProbe / noteHealthCheck.
      current.state = "closed";
      current.consecutiveFailures = this.policy.openAfterFailures - 1;
      current.lastProbeHealthy = null;
    }
    // Scheduled F37: a failed probe skips the provider without waiting on a call timeout (§17.1).
    if (current.lastProbeHealthy === false) {
      return "unhealthy";
    }
    return "available";
  }

  quotaExhausted(providerKey: ProviderKey): boolean {
    return this.window(providerKey).quotaExhausted;
  }

  recordSuccess(providerKey: ProviderKey, nowMs: number): void {
    const current = this.window(providerKey);
    current.state = "closed";
    current.consecutiveFailures = 0;
    current.openedAtMs = null;
    current.lastCheckedAtMs = nowMs;
    current.lastObservedBy = "passive";
  }

  recordFailure(providerKey: ProviderKey, nowMs: number): void {
    const current = this.window(providerKey);
    current.lastCheckedAtMs = nowMs;
    current.lastObservedBy = "passive";
    if (current.state === "open") {
      // A failed cooldown probe restarts the window rather than counting down again.
      current.openedAtMs = nowMs;
      return;
    }
    current.consecutiveFailures += 1;
    if (current.consecutiveFailures >= this.policy.openAfterFailures) {
      current.state = "open";
      current.openedAtMs = nowMs;
    }
  }

  noteQuotaExhausted(providerKey: ProviderKey, exhausted: boolean): void {
    this.window(providerKey).quotaExhausted = exhausted;
  }

  /** F37: a successful health check closes the circuit immediately, inside the cooldown. */
  noteHealthCheck(
    providerKey: ProviderKey,
    healthy: boolean,
    nowMs: number,
  ): void {
    const current = this.window(providerKey);
    current.lastCheckedAtMs = nowMs;
    if (healthy) {
      current.state = "closed";
      current.consecutiveFailures = 0;
      current.openedAtMs = null;
      current.lastProbeHealthy = true;
      current.lastObservedBy = "scheduled";
      return;
    }
    current.state = "open";
    current.openedAtMs = nowMs;
    current.lastProbeHealthy = false;
    current.lastObservedBy = "scheduled";
  }

  /**
   * Scheduled F37 probe result. A failure marks the provider **unhealthy** so the next route skips
   * it without opening a call; a success clears that mark and closes any open circuit.
   */
  noteScheduledProbe(
    providerKey: ProviderKey,
    healthy: boolean,
    nowMs: number,
  ): void {
    const current = this.window(providerKey);
    current.lastCheckedAtMs = nowMs;
    current.lastProbeHealthy = healthy;
    current.probeMissing = false;
    current.lastObservedBy = "scheduled";
    if (healthy) {
      current.state = "closed";
      current.consecutiveFailures = 0;
      current.openedAtMs = null;
    }
  }

  /**
   * Scheduled pass found no probe: the status is `unknown`, and routing is left to the passive
   * circuit. Paid adapters register no `health()` on purpose (a probe against a billed endpoint
   * spends money, adapters.ts), so marking them unhealthy here would take Claude out of every chain
   * for the life of the isolate (supervisor round 1 on #249, B1).
   */
  noteMissingProbe(providerKey: ProviderKey, nowMs: number): void {
    const current = this.window(providerKey);
    current.lastCheckedAtMs = nowMs;
    current.probeMissing = true;
    current.lastObservedBy = "scheduled";
  }

  notePassiveObservation(providerKey: ProviderKey): void {
    this.window(providerKey).lastObservedBy = "passive";
  }

  probeStatus(
    providerKey: ProviderKey,
  ): "healthy" | "degraded" | "down" | "unknown" | "unreachable" {
    const current = this.window(providerKey);
    if (current.probeMissing) return "unknown";
    if (current.lastProbeHealthy === true) return "healthy";
    if (current.lastProbeHealthy === false) return "down";
    if (current.state === "open" || current.consecutiveFailures > 0)
      return "degraded";
    return "unknown";
  }

  lastObservedBy(providerKey: ProviderKey): "scheduled" | "passive" | null {
    return this.window(providerKey).lastObservedBy;
  }

  /** Diagnostic/audit view. Never employee-visible: it names providers (§9.3). */
  snapshot(providerKey: ProviderKey): Readonly<ProviderWindow> {
    return { ...this.window(providerKey) };
  }

  private window(providerKey: ProviderKey): ProviderWindow {
    const existing = this.windows.get(providerKey);
    if (existing) return existing;
    const fresh: ProviderWindow = {
      state: "closed",
      consecutiveFailures: 0,
      openedAtMs: null,
      lastCheckedAtMs: null,
      quotaExhausted: false,
      lastProbeHealthy: null,
      probeMissing: false,
      lastObservedBy: null,
    };
    this.windows.set(providerKey, fresh);
    return fresh;
  }
}

/**
 * F37 health check for one provider. A provider with no health endpoint is reported **unhealthy**:
 * unknown is never assumed healthy. The caller decides what to do with the answer.
 */
export async function checkProviderHealth(
  providerKey: ProviderKey,
  deps: { probes: HealthProbeRegistry; book: CircuitBook; nowMs: number },
): Promise<boolean> {
  const probe = deps.probes.get(providerKey);
  const healthy = (await probe?.health?.()) === true;
  deps.book.noteHealthCheck(providerKey, healthy, deps.nowMs);
  return healthy;
}
