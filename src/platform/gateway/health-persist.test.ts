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

describe("createPersistingHealthObservationSink: a failed write (supervisor round 1 on #251)", () => {
  it("never rejects, reports a safe kind, and leaves later records flowing", async () => {
    const written: string[] = [];
    const errors: unknown[] = [];
    const sink = createPersistingHealthObservationSink(
      async (args) => {
        if (args.providerKey === "local_box") throw new Error("connection refused at 10.0.0.5");
        written.push(args.providerKey);
      },
      (event) => errors.push(event),
    );
    await expect(sink.record(SAMPLE)).resolves.toBeUndefined();
    await sink.record({ ...SAMPLE, providerKey: "workers_ai" });
    expect(written).toEqual(["workers_ai"]);
    expect(errors).toEqual([{ kind: "provider_health_write_failed", providerKey: "local_box" }]);
    expect(JSON.stringify(errors)).not.toContain("10.0.0.5");
  });
});
