import { describe, expect, it } from "vitest";

import {
  createPersistingHealthObservationSink,
  observationToRecordArgs,
  type RecordProviderHealthArgs,
} from "./health-persist";
import type { HealthObservation } from "./health";

/**
 * T-314 PR-3: observation → gateway_config.record_provider_health_v1 argument shape (#134).
 */

const SAMPLE: HealthObservation = {
  providerKey: "local_box",
  checkedAtMs: 1_730_000_015_000,
  status: "down",
  latencyMs: 42,
  circuitOpen: true,
  observedBy: "scheduled",
};

describe("observationToRecordArgs (F37 → provider_health)", () => {
  it("maps a scheduled observation into the SQL writer arguments without employee-facing prose", () => {
    const args = observationToRecordArgs(SAMPLE);
    expect(args).toEqual({
      providerKey: "local_box",
      status: "down",
      latencyMs: 42,
      circuitOpen: true,
      observedBy: "scheduled",
      checkedAt: new Date(SAMPLE.checkedAtMs).toISOString(),
      quotaWindowResetAt: null,
    });
    expect(JSON.stringify(args)).not.toMatch(/please try|unavailable to you|DeepSeek|OpenRouter/i);
  });
});

describe("createPersistingHealthObservationSink", () => {
  it("forwards each record through the injected CONFIG_DB exec", async () => {
    const seen: RecordProviderHealthArgs[] = [];
    const sink = createPersistingHealthObservationSink((args) => {
      seen.push(args);
    });
    await sink.record(SAMPLE);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.providerKey).toBe("local_box");
    expect(seen[0]?.observedBy).toBe("scheduled");
    expect(seen[0]?.circuitOpen).toBe(true);
  });
});
