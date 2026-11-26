import { describe, expect, it } from "vitest";

import { DEFAULT_TASK_CHAIN_ORDER } from "@/contracts/provider-route";
import type { ProviderKey } from "@/contracts/keys";

import {
  answered,
  failed,
  fakeAdapter,
  recordingMeter,
  registryOf,
  RUN_ID,
  syntheticContext,
  testConfiguration,
} from "@/platform/gateway/gateway-fixtures";
import { CircuitBook } from "@/platform/gateway/circuit";
import type { AdapterCallOutcome } from "@/platform/gateway/adapters";
import type { GatewayDeps } from "@/platform/gateway/call";

import {
  createGatewayRouteClassifier,
  DEFAULT_ROUTE_CLASSIFY_DATA_CLASS,
  withGatewayClassify,
} from "./route-classify";
import { routeExpert, type RouteCandidate } from "./route-expert";

const T0 = 1_730_000_000_000;

const UAV: RouteCandidate = { expertKey: "uav-expert", serviceKey: "uav-compliance" };
const GPR: RouteCandidate = { expertKey: "gpr-expert", serviceKey: "gpr" };
const CANDIDATES = [UAV, GPR] as const;

function harness(
  scripts: Record<string, AdapterCallOutcome[]>,
): { adapters: ReturnType<typeof fakeAdapter>[]; deps: GatewayDeps } {
  const adapters = Object.entries(scripts).map(([providerKey, script]) =>
    fakeAdapter(providerKey as ProviderKey, script),
  );
  const meter = recordingMeter();
  const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
  return {
    adapters,
    deps: {
      config: testConfiguration({ openAfterFailures: 2, cooldownMs: 30_000 }),
      adapters: registryOf(...adapters),
      health: book,
      meter,
      clock: () => T0,
    },
  };
}

function adapterFor(
  h: { adapters: ReturnType<typeof fakeAdapter>[] },
  providerKey: ProviderKey,
): ReturnType<typeof fakeAdapter> {
  const found = h.adapters.find((adapter) => adapter.providerKey === providerKey);
  if (!found) throw new Error(`no adapter under test for ${providerKey}`);
  return found;
}

describe("createGatewayRouteClassifier (T-311 PR-3)", () => {
  it("defaults data class to internal (safer than public for routing metadata)", () => {
    expect(DEFAULT_ROUTE_CLASSIFY_DATA_CLASS).toBe("internal");
  });

  it("returns ok with providerKey when the route chain answers valid JSON", async () => {
    const h = harness({
      local_box: [
        answered(JSON.stringify({ expertKey: "uav-expert", confidence: 0.9 }), "open-weights-alpha"),
      ],
    });
    const classify = createGatewayRouteClassifier({
      context: syntheticContext(),
      runId: RUN_ID,
      gatewayDeps: h.deps,
      nowMs: T0,
    });

    const outcome = await classify("UAV pre-flight compass check", CANDIDATES);
    expect(outcome).toEqual({
      status: "ok",
      expertKey: "uav-expert",
      confidence: 0.9,
      providerKey: "local_box",
    });

    const call = adapterFor(h, "local_box").calls[0];
    expect(call?.task).toBe("route");
    expect(call?.dataClass).toBe("internal");
    expect(DEFAULT_TASK_CHAIN_ORDER.route).not.toContain("claude");
  });

  it("returns unavailable when the gateway has no eligible provider", async () => {
    const h = harness({});
    const classify = createGatewayRouteClassifier({
      context: syntheticContext(),
      runId: RUN_ID,
      gatewayDeps: h.deps,
      nowMs: T0,
    });

    await expect(classify("anything", CANDIDATES)).resolves.toEqual({ status: "unavailable" });
  });

  it("returns unavailable when every route attempt fails", async () => {
    const h = harness({
      local_box: [failed("connection")],
      workers_ai: [failed("server_error")],
    });
    const classify = createGatewayRouteClassifier({
      context: syntheticContext(),
      runId: RUN_ID,
      gatewayDeps: h.deps,
      // Shorten to cleared-for-internal providers that we scripted to fail.
      routeChain: ["local_box", "workers_ai"],
      nowMs: T0,
    });

    await expect(classify("UAV question", CANDIDATES)).resolves.toEqual({ status: "unavailable" });
  });

  it("returns unavailable on garbage JSON so keyword via stays clean", async () => {
    const h = harness({
      local_box: [answered("not-json-at-all", "open-weights-alpha")],
    });
    const classify = createGatewayRouteClassifier({
      context: syntheticContext(),
      runId: RUN_ID,
      gatewayDeps: h.deps,
      nowMs: T0,
    });

    await expect(classify("UAV question", CANDIDATES)).resolves.toEqual({ status: "unavailable" });
  });

  it("returns unavailable when the model invents an expertKey outside candidates", async () => {
    const h = harness({
      local_box: [
        answered(
          JSON.stringify({ expertKey: "forged-expert", confidence: 0.99 }),
          "open-weights-alpha",
        ),
      ],
    });
    const classify = createGatewayRouteClassifier({
      context: syntheticContext(),
      runId: RUN_ID,
      gatewayDeps: h.deps,
      nowMs: T0,
    });

    await expect(classify("pick something", CANDIDATES)).resolves.toEqual({ status: "unavailable" });
  });

  it("records route_model via when wired into routeExpert", async () => {
    const h = harness({
      local_box: [
        answered(JSON.stringify({ expertKey: "gpr-expert", confidence: 0.88 }), "open-weights-alpha"),
      ],
    });
    const result = await routeExpert(
      withGatewayClassify({
        question: "Please classify this operational question.",
        candidates: CANDIDATES,
        context: syntheticContext(),
        runId: RUN_ID,
        gatewayDeps: h.deps,
        nowMs: T0,
      }),
    );
    expect(result).toEqual({
      kind: "suggestion",
      expertKey: "gpr-expert",
      serviceKey: "gpr",
      confidence: 0.88,
      via: "route_model",
      providerKey: "local_box",
    });
  });

  it("falls through to keywords when the route chain is unavailable", async () => {
    const h = harness({
      local_box: [failed("connection")],
      workers_ai: [failed("connection")],
    });
    const result = await routeExpert(
      withGatewayClassify({
        question: "UAV pre-flight rotor check before launch",
        candidates: CANDIDATES,
        context: syntheticContext(),
        runId: RUN_ID,
        gatewayDeps: h.deps,
        routeChain: ["local_box", "workers_ai"],
        nowMs: T0,
      }),
    );
    expect(result).toMatchObject({
      kind: "suggestion",
      expertKey: "uav-expert",
      serviceKey: "uav-compliance",
      via: "keywords",
    });
  });
});
