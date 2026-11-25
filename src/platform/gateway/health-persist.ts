import type { HealthObservation, HealthObservationSink, HealthStatus } from "./health";

/**
 * T-314 PR-3: map an F37 observation onto `gateway_config.record_provider_health_v1` (#134).
 * The SQL call itself runs as `toi_gateway_config` over CONFIG_DB (`health-config-db.ts`); this module
 * only shapes the arguments. No secrets, no employee-visible strings.
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

/** Sink that forwards each observation through an injected CONFIG_DB exec (or a test recorder). */
export function createPersistingHealthObservationSink(exec: RecordProviderHealthExec): HealthObservationSink {
  return {
    async record(observation: HealthObservation): Promise<void> {
      await exec(observationToRecordArgs(observation));
    },
  };
}
