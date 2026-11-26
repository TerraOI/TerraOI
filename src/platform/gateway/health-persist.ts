import type { HealthObservation, HealthObservationSink, HealthStatus } from "./health";

/**
 * T-314 PR-3: map an F37 observation onto `gateway_config.record_provider_health_v1` (#134).
 * The SQL call itself runs as `toi_gateway_config` over CONFIG_DB; this module only shapes the
 * arguments. No secrets, no employee-visible strings.
 */

export interface RecordProviderHealthArgs {
  providerKey: string;
  status: HealthStatus;
  latencyMs: number | null;
  circuitOpen: boolean;
  observedBy: "scheduled" | "passive";
  checkedAt: string;
  quotaWindowResetAt: string | null;
}

export type RecordProviderHealthExec = (args: RecordProviderHealthArgs) => void | Promise<void>;

export function observationToRecordArgs(observation: HealthObservation): RecordProviderHealthArgs {
  return {
    providerKey: observation.providerKey,
    status: observation.status,
    latencyMs: observation.latencyMs,
    circuitOpen: observation.circuitOpen,
    observedBy: observation.observedBy,
    checkedAt: new Date(observation.checkedAtMs).toISOString(),
    quotaWindowResetAt: null,
  };
}

/**
 * Sink that forwards each observation through an injected CONFIG_DB exec (or a test recorder).
 *
 * A failed write never escapes `record` (supervisor round 1 on #251): the scheduled pass awaits the
 * sink inside its per-provider loop, so a throw would skip every provider after it, and the passive
 * path fires `void sink.record(...)`, so a rejection would be unhandled. Failures go to `onError`
 * (a safe kind only, never the driver message) and the observation is dropped.
 */
export function createPersistingHealthObservationSink(
  exec: RecordProviderHealthExec,
  onError?: (event: { kind: "provider_health_write_failed"; providerKey: string }) => void,
): HealthObservationSink {
  return {
    async record(observation: HealthObservation): Promise<void> {
      try {
        await exec(observationToRecordArgs(observation));
      } catch {
        onError?.({ kind: "provider_health_write_failed", providerKey: observation.providerKey });
      }
    },
  };
}
