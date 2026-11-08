import type { ProviderKey } from "@/contracts/keys";

import type { CircuitPolicy } from "./config";
import type { HealthReader } from "./route";

/**
 * F37 health and circuit state (plan §12.4 chain walking (b), F38 "advances on outage, timeout,
 * 429/5xx…"). §12.4: "A circuit opens after repeated failures and closes after a cooldown and
 * successful health check."
 *
 * In-memory and per process on purpose: passive health checks and a shared `provider_health` store
 * are T-314 / issue #45. Nothing here relaxes clearance — it only removes a provider from the
 * chain for a while.
 */

export type CircuitState = "closed" | "open";

interface ProviderWindow {
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs: number | null;
  lastCheckedAtMs: number | null;
  quotaExhausted: boolean;
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

const DEFAULT_POLICY: CircuitPolicy = { openAfterFailures: 3, cooldownMs: 60_000 };

export class CircuitBook implements HealthReader, HealthWriter {
  private readonly windows = new Map<ProviderKey, ProviderWindow>();

  constructor(private readonly policy: CircuitPolicy = DEFAULT_POLICY) {}

  availability(providerKey: ProviderKey, nowMs: number): "available" | "circuit_open" {
    const current = this.window(providerKey);
    if (current.state === "open") {
      // The cooldown is the health-check window. Once it passes, the next attempt *is* the probe:
      // the circuit is left one failure short of open, so a probe that fails again re-opens it
      // immediately instead of letting a broken provider take `openAfterFailures` calls each time.
      if (current.openedAtMs === null || nowMs - current.openedAtMs < this.policy.cooldownMs) {
        return "circuit_open";
      }
      current.state = "closed";
      current.consecutiveFailures = this.policy.openAfterFailures - 1;
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
  }

  recordFailure(providerKey: ProviderKey, nowMs: number): void {
    const current = this.window(providerKey);
    current.lastCheckedAtMs = nowMs;
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
  noteHealthCheck(providerKey: ProviderKey, healthy: boolean, nowMs: number): void {
    const current = this.window(providerKey);
    current.lastCheckedAtMs = nowMs;
    if (healthy) {
      current.state = "closed";
      current.consecutiveFailures = 0;
      current.openedAtMs = null;
      return;
    }
    current.state = "open";
    current.openedAtMs = nowMs;
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
