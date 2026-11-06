import { describe, expect, it } from "vitest";

import { PLATFORM_DEFAULT_CLEARANCE } from "@/contracts/provider-route";

import { M1_ENDPOINTS, PROVIDER_ROWS, testConfiguration } from "./gateway-fixtures";
import { effectiveClearance, parseGatewayConfiguration } from "./config";

/**
 * The reviewed configuration the gateway runs on (plan §6.1, §12.4). It is parsed fail-closed, and
 * the part the supervisor cares about: this shape **cannot carry a clearance claim**, so it can
 * only ever narrow the injected baseline (issue #16 N4, lead condition on #31).
 */

const VALID = {
  providers: PROVIDER_ROWS,
  endpoints: M1_ENDPOINTS,
  clearance: PLATFORM_DEFAULT_CLEARANCE,
  matrixRevision: 7,
  circuit: { openAfterFailures: 2, cooldownMs: 30_000 },
};

describe("gateway configuration parsing (fail closed)", () => {
  it("accepts a reviewed baseline and keeps the matrix revision for the audit (F40)", () => {
    const config = parseGatewayConfiguration(VALID);
    expect(config.matrixRevision).toBe(7);
    expect(config.clearance.restricted).toEqual(["local_box"]);
    expect(config.circuit).toEqual({ openAfterFailures: 2, cooldownMs: 30_000 });
  });

  it("an endpoint cannot carry a data class, so it cannot widen clearance", () => {
    expect(() =>
      parseGatewayConfiguration({
        ...VALID,
        endpoints: [{ ...M1_ENDPOINTS[0], maxClearedClass: "restricted" }],
      }),
    ).toThrow();
    expect(() =>
      parseGatewayConfiguration({
        ...VALID,
        endpoints: [{ ...M1_ENDPOINTS[2], clearedFor: ["restricted", "client_confidential"] }],
      }),
    ).toThrow();
  });

  it("an endpoint for a provider with no model_providers row is rejected", () => {
    expect(() =>
      parseGatewayConfiguration({
        ...VALID,
        endpoints: [...M1_ENDPOINTS, { providerKey: "someone_elses_proxy", model: "who-knows" }],
      }),
    ).toThrow();
  });

  it("a duplicate provider row is rejected rather than resolved by last-write-wins", () => {
    expect(() =>
      parseGatewayConfiguration({
        ...VALID,
        providers: [...PROVIDER_ROWS, { ...PROVIDER_ROWS[0], maxClearedClass: "restricted" }],
      }),
    ).toThrow();
  });

  it("a clearance matrix with a missing or unknown class is rejected", () => {
    const missing = { ...PLATFORM_DEFAULT_CLEARANCE };
    delete (missing as Record<string, unknown>).restricted;
    expect(() => parseGatewayConfiguration({ ...VALID, clearance: missing })).toThrow();
    expect(() =>
      parseGatewayConfiguration({
        ...VALID,
        clearance: { ...PLATFORM_DEFAULT_CLEARANCE, secret: ["local_box"] },
      }),
    ).toThrow();
  });

  it("no unknown knob is accepted at the top level", () => {
    expect(() => parseGatewayConfiguration({ ...VALID, allowAnyProviderWhenBusy: true })).toThrow();
    expect(() => parseGatewayConfiguration({ ...VALID, providers: [] })).toThrow();
  });

  it("effectiveClearance intersects the tenant policy with the baseline and never widens it", () => {
    const config = testConfiguration();
    const narrowed = effectiveClearance(config, { public: ["local_box", "claude"] });
    expect(narrowed.public).toEqual(["local_box", "claude"]);
    const widened = effectiveClearance(config, {
      restricted: ["local_box", "claude", "workers_ai", "deepseek", "openrouter"],
    });
    expect(widened.restricted).toEqual(["local_box"]);
    // An omitted class keeps the platform default; it is never treated as "anything goes".
    expect(effectiveClearance(config, undefined).client_confidential).toEqual(["local_box", "claude"]);
  });
});
