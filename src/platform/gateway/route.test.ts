import { describe, expect, it } from "vitest";

import { DEFAULT_TASK_CHAIN_ORDER, PLATFORM_DEFAULT_CLEARANCE } from "@/contracts/provider-route";

import { M1_ENDPOINTS, FULL_COMPOSE_CHAIN, PROVIDER_ROWS, testConfiguration } from "./gateway-fixtures";
import { CircuitBook } from "./circuit";
import {
  selectModelRoute,
  type RouteDecision,
  type RouteDeps,
  type HealthReader,
  type RouteRequest,
} from "./route";

/**
 * F31 `selectModelRoute` (plan §12.4 chain walking, rules (a)–(e)).
 * Every case asserts the eligible order **and** the reason each other provider was dropped,
 * because "clearance was never relaxed" is only provable when the skips are recorded (F40).
 */

const T0 = 1_730_000_000_000;

function route(
  request: RouteRequest,
  options: {
    book?: CircuitBook;
    adapters?: string[];
    config?: ReturnType<typeof testConfiguration>;
    health?: HealthReader;
  } = {},
): RouteDecision {
  const adapterKeys = new Set(options.adapters ?? ["local_box", "workers_ai", "claude", "deepseek", "openrouter"]);
  const deps: RouteDeps = {
    config: options.config ?? testConfiguration(),
    health: options.health ?? options.book ?? new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 }),
    adapters: { has: (providerKey) => adapterKeys.has(providerKey) },
  };
  return selectModelRoute(request, deps);
}

describe("eligible chain (plan §12.4)", () => {
  it("keeps the task's cost order and never reorders a chain to find a cheaper provider", () => {
    const decision = route({ task: "compose", dataClass: "public", chain: FULL_COMPOSE_CHAIN, nowMs: T0 });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual([
      "local_box",
      "workers_ai",
      "claude",
      "deepseek",
      "openrouter",
    ]);
    expect(decision.eligible.map((entry) => entry.chainPosition)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a reordered expert chain selects nothing (fail closed, §5.2)", () => {
    const decision = route({ task: "compose", dataClass: "public", chain: ["openrouter", "local_box"], nowMs: T0 });
    expect(decision.eligible).toEqual([]);
    expect(decision.skipped.every((skip) => skip.reason === "chain_order")).toBe(true);
  });

  it("a provider with no adapter or no recorded endpoint is never called (fail closed)", () => {
    const decision = route({ task: "compose", dataClass: "public", chain: FULL_COMPOSE_CHAIN, nowMs: T0 });
    expect(decision.eligible.map((entry) => entry.providerKey)).toContain("local_box");

    const noAdapter = route(
      { task: "compose", dataClass: "public", chain: FULL_COMPOSE_CHAIN, nowMs: T0 },
      { adapters: [] },
    );
    expect(noAdapter.eligible).toEqual([]);
    expect(noAdapter.skipped.every((skip) => skip.reason === "no_adapter")).toBe(true);

    const noEndpoint = route(
      { task: "compose", dataClass: "public", chain: ["local_box", "claude"], nowMs: T0 },
      {
        config: testConfiguration({
          endpoints: M1_ENDPOINTS.filter((endpoint) => endpoint.providerKey !== "claude"),
        }),
      },
    );
    expect(noEndpoint.eligible.map((entry) => entry.providerKey)).toEqual(["local_box"]);
    expect(noEndpoint.skipped).toContainEqual({ providerKey: "claude", reason: "no_endpoint" });
  });

  it("drops a provider whose registry row does not serve this task class", () => {
    // The union makes this request carry `composedWith`: the type checker caught a real omission
    // in this very test when rule (e) became un-representable-without-it.
    const decision = route({
      task: "verify",
      dataClass: "public",
      minTier: "medium",
      nowMs: T0,
      composedWith: { providerKey: "workers_ai", model: "hosted-beta" },
    });
    expect(decision.skipped).toContainEqual({ providerKey: "deepseek", reason: "task_unsupported" });
    expect(decision.skipped).toContainEqual({ providerKey: "openrouter", reason: "task_unsupported" });
  });

  it("records the matrix revision it used with every route (F40, issue #16 N4)", () => {
    const decision = route(
      { task: "compose", dataClass: "public", nowMs: T0 },
      { config: testConfiguration({ matrixRevision: 42 }) },
    );
    expect(decision.matrixRevision).toBe(42);
    expect(decision.task).toBe("compose");
    expect(decision.dataClass).toBe("public");
  });
});

describe("clearance filter (plan §12.4, TOI-ADR-12)", () => {
  it("a client_confidential payload clears only the local box and Claude by default", () => {
    const decision = route({
      task: "compose",
      dataClass: "client_confidential",
      chain: FULL_COMPOSE_CHAIN,
      nowMs: T0,
    });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["local_box", "claude"]);
    for (const providerKey of ["workers_ai", "deepseek", "openrouter"]) {
      expect(decision.skipped).toContainEqual({ providerKey, reason: "not_cleared" });
    }
  });

  it("a tenant policy may narrow the matrix but can never widen it", () => {
    const decision = route({
      task: "compose",
      dataClass: "client_confidential",
      chain: FULL_COMPOSE_CHAIN,
      tenantPolicy: { client_confidential: [...FULL_COMPOSE_CHAIN] },
      nowMs: T0,
    });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["local_box", "claude"]);
    expect(decision.skipped).toContainEqual({ providerKey: "workers_ai", reason: "not_cleared" });
  });

  it("Workers AI is reachable for client_confidential only when the reviewed baseline records it", () => {
    // The recorded tenant decision (plan §18.3 choice **E1**) lands as *reviewed configuration*:
    // both the baseline row and the provider row's own ceiling, never as a request-time parameter.
    const approvedConfiguration = testConfiguration({
      clearance: { ...PLATFORM_DEFAULT_CLEARANCE, client_confidential: ["local_box", "workers_ai", "claude"] },
      providers: PROVIDER_ROWS.map((row) =>
        row.providerKey === "workers_ai" ? { ...row, maxClearedClass: "client_confidential" } : row,
      ),
      matrixRevision: 8,
    });
    const approved = route(
      { task: "compose", dataClass: "client_confidential", chain: FULL_COMPOSE_CHAIN, nowMs: T0 },
      { config: approvedConfiguration },
    );
    expect(approved.eligible.map((entry) => entry.providerKey)).toEqual([
      "local_box",
      "workers_ai",
      "claude",
    ]);
    expect(approved.matrixRevision).toBe(8);

    const tenantAsk = route({
      task: "compose",
      dataClass: "client_confidential",
      chain: FULL_COMPOSE_CHAIN,
      tenantPolicy: { client_confidential: ["local_box", "workers_ai"] },
      nowMs: T0,
    });
    expect(tenantAsk.skipped).toContainEqual({ providerKey: "workers_ai", reason: "not_cleared" });
  });

  it("a provider row whose own maxClearedClass is lower than the payload class is blocked", () => {
    const decision = route(
      {
        task: "compose",
        dataClass: "client_confidential",
        chain: ["workers_ai", "claude"],
        nowMs: T0,
      },
      {
        // In the matrix for this deployment, but the `model_providers` row caps it at `internal`.
        config: testConfiguration({
          clearance: { ...PLATFORM_DEFAULT_CLEARANCE, client_confidential: ["workers_ai", "claude"] },
        }),
      },
    );
    expect(decision.skipped).toContainEqual({ providerKey: "workers_ai", reason: "not_cleared" });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
  });

  it("restricted content clears the local box only", () => {
    const decision = route({ task: "compose", dataClass: "restricted", chain: FULL_COMPOSE_CHAIN, nowMs: T0 });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["local_box"]);
    expect(decision.skipped.filter((skip) => skip.reason === "not_cleared")).toHaveLength(4);
  });

  it("internal clears box + Workers AI + Claude and drops the public-only fallbacks by default", () => {
    const decision = route({ task: "compose", dataClass: "internal", chain: FULL_COMPOSE_CHAIN, nowMs: T0 });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual([
      "local_box",
      "workers_ai",
      "claude",
    ]);
    expect(decision.skipped).toEqual([
      { providerKey: "deepseek", reason: "not_cleared" },
      { providerKey: "openrouter", reason: "not_cleared" },
    ]);
  });

  it("a tenant may narrow `internal`, and its widening attempt changes nothing", () => {
    const narrowed = route({
      task: "compose",
      dataClass: "internal",
      chain: FULL_COMPOSE_CHAIN,
      tenantPolicy: { internal: ["local_box"] },
      nowMs: T0,
    });
    expect(narrowed.eligible.map((entry) => entry.providerKey)).toEqual(["local_box"]);

    const widened = route({
      task: "compose",
      dataClass: "internal",
      chain: FULL_COMPOSE_CHAIN,
      // Asking for the public-only providers on an `internal` payload is refused by the matrix
      // arithmetic, not by a special case: widening needs a recorded decision (§12.4).
      tenantPolicy: { internal: [...FULL_COMPOSE_CHAIN] },
      nowMs: T0,
    });
    expect(widened.eligible.map((entry) => entry.providerKey)).toEqual([
      "local_box",
      "workers_ai",
      "claude",
    ]);
    expect(widened.skipped).toEqual([
      { providerKey: "deepseek", reason: "not_cleared" },
      { providerKey: "openrouter", reason: "not_cleared" },
    ]);
  });

  it("a tenant that removed Workers AI from `public` has it skipped in the chain", () => {
    const decision = route({
      task: "compose",
      dataClass: "public",
      chain: FULL_COMPOSE_CHAIN,
      tenantPolicy: { public: ["local_box", "claude", "deepseek", "openrouter"] },
      nowMs: T0,
    });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual([
      "local_box",
      "claude",
      "deepseek",
      "openrouter",
    ]);
    expect(decision.skipped).toEqual([{ providerKey: "workers_ai", reason: "not_cleared" }]);
  });

  it("client_confidential with the box offline goes to Claude, the plan's stated consequence", () => {
    const book = new CircuitBook({ openAfterFailures: 1, cooldownMs: 30_000 });
    book.recordFailure("local_box", T0);
    const decision = route(
      { task: "compose", dataClass: "client_confidential", chain: FULL_COMPOSE_CHAIN, nowMs: T0 + 1 },
      { book },
    );
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
  });

  it("with Claude unhealthy too, nothing falls back to a public-only provider", () => {
    const decision = route(
      { task: "compose", dataClass: "client_confidential", chain: FULL_COMPOSE_CHAIN, nowMs: T0 },
      {
        health: {
          availability: (providerKey) =>
            providerKey === "claude" ? "unhealthy" : providerKey === "local_box" ? "circuit_open" : "available",
          quotaExhausted: () => false,
        },
      },
    );
    expect(decision.eligible).toEqual([]);
    expect(decision.skipped).toEqual([
      { providerKey: "local_box", reason: "circuit_open" },
      { providerKey: "workers_ai", reason: "not_cleared" },
      { providerKey: "claude", reason: "unhealthy" },
      { providerKey: "deepseek", reason: "not_cleared" },
      { providerKey: "openrouter", reason: "not_cleared" },
    ]);
  });
});

describe("per-task chain order (plan §12.4, the per-task table)", () => {
  it("route and condense skip Claude and use the shorter order", () => {
    expect(DEFAULT_TASK_CHAIN_ORDER.route).toEqual(["local_box", "workers_ai", "deepseek", "openrouter"]);
    expect(DEFAULT_TASK_CHAIN_ORDER.condense).toEqual(DEFAULT_TASK_CHAIN_ORDER.route);
    for (const task of ["route", "condense"] as const) {
      const decision = route({ task, dataClass: "public", nowMs: T0 });
      expect(decision.eligible.map((entry) => entry.providerKey)).toEqual([
        "local_box",
        "workers_ai",
        "deepseek",
        "openrouter",
      ]);
    }
  });

  it("the shorter chains still stop at the data class: an internal condense never reaches the public-only fallbacks", () => {
    const decision = route({ task: "condense", dataClass: "internal", nowMs: T0 });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["local_box", "workers_ai"]);
    expect(decision.skipped).toEqual([
      { providerKey: "deepseek", reason: "not_cleared" },
      { providerKey: "openrouter", reason: "not_cleared" },
    ]);
  });
});

describe("verify chain (issue #9, plan §12.1, §12.4 (d)/(e))", () => {
  const verifyRequest: RouteRequest = {
    task: "verify",
    dataClass: "internal",
    minTier: "medium",
    nowMs: T0,
    composedWith: { providerKey: "workers_ai", model: "hosted-beta" },
  };

  it("starts at Claude in the M1 configuration, not at the local box", () => {
    const expertChain = DEFAULT_TASK_CHAIN_ORDER.verify.filter((key) => key !== "local_box");
    const decision = route({ ...verifyRequest, chain: expertChain });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
    expect(decision.eligible[0]?.chainPosition).toBe(1);
  });

  // Rule (e) is "the verifier is not the model that composed the answer". `RouteRequest` makes a
  // `verify` request without `composedWith` a compile error; this covers a caller whose argument
  // arrived unvalidated (a queue payload, a job row): the route selects nothing rather than guessing.
  it("a verify route that cannot name the composer selects nothing", () => {
    const unvalidated = {
      task: "verify",
      dataClass: "internal",
      minTier: "medium",
      nowMs: T0,
    } as unknown as RouteRequest;
    const decision = route(unvalidated);
    expect(decision.eligible).toEqual([]);
    expect(decision.skipped.length).toBeGreaterThan(0);
    expect(decision.skipped.every((skip) => skip.reason === "composer_unknown")).toBe(true);
  });

  it("the local box is not a verifier before an F35-approved second model is recorded", () => {
    const decision = route({ ...verifyRequest, chain: DEFAULT_TASK_CHAIN_ORDER.verify });
    expect(decision.skipped).toContainEqual({ providerKey: "local_box", reason: "verifier_not_evaluated" });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);

    // Configuration, not a code branch: once a *different*, evaluated model is recorded on the box,
    // the box becomes eligible at its own chain position (a later supervisor decision, issue #9 B).
    const withBoxVerifier = route(
      { ...verifyRequest, chain: DEFAULT_TASK_CHAIN_ORDER.verify },
      {
        config: testConfiguration({
          endpoints: M1_ENDPOINTS.map((endpoint) =>
            endpoint.providerKey === "local_box"
              ? { ...endpoint, verifierModel: { model: "open-weights-beta", evalSetVersion: "ev-0002" } }
              : endpoint,
          ),
        }),
      },
    );
    expect(withBoxVerifier.eligible.map((entry) => entry.providerKey)).toEqual(["local_box", "claude"]);
    expect(withBoxVerifier.eligible[0]).toMatchObject({
      providerKey: "local_box",
      chainPosition: 1,
      model: "open-weights-beta",
    });
  });

  // Plan §12.4 chain walking (e) removes "the same model that composed the answer" — model-level,
  // not provider-key level, which is why the endpoint config carries model ids.
  it("never selects the model that composed the answer (§12.4 (e))", () => {
    const decision = route(
      { ...verifyRequest, chain: ["claude", "workers_ai"] },
      {
        config: testConfiguration({
          endpoints: M1_ENDPOINTS.map((endpoint) =>
            endpoint.providerKey === "workers_ai"
              ? { ...endpoint, verifierModel: { model: "hosted-beta", evalSetVersion: "ev-0001" } }
              : endpoint,
          ),
        }),
      },
    );
    expect(decision.skipped).toContainEqual({ providerKey: "workers_ai", reason: "composed_the_answer" });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
  });

  it("never selects a provider below minVerifierTier", () => {
    const decision = route(
      { ...verifyRequest, minTier: "large", chain: DEFAULT_TASK_CHAIN_ORDER.verify },
      {
        config: testConfiguration({
          endpoints: M1_ENDPOINTS.map((endpoint) =>
            endpoint.providerKey === "workers_ai"
              ? { ...endpoint, verifierModel: { model: "hosted-zeta", evalSetVersion: "ev-0001" } }
              : endpoint,
          ),
        }),
      },
    );
    expect(decision.skipped).toContainEqual({ providerKey: "workers_ai", reason: "below_tier" });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
  });

  it("clearance still applies to verification: restricted content has no verifier while the box is the only cleared provider", () => {
    const decision = route({ ...verifyRequest, dataClass: "restricted", chain: DEFAULT_TASK_CHAIN_ORDER.verify });
    expect(decision.eligible).toEqual([]);
    expect(decision.skipped).toContainEqual({ providerKey: "local_box", reason: "verifier_not_evaluated" });
    expect(decision.skipped).toContainEqual({ providerKey: "claude", reason: "not_cleared" });
  });

  it("recording an evaluated verifier model buys no clearance: endpoints only narrow the baseline", () => {
    const decision = route(
      { ...verifyRequest, dataClass: "restricted", chain: DEFAULT_TASK_CHAIN_ORDER.verify },
      {
        config: testConfiguration({
          endpoints: M1_ENDPOINTS.map((endpoint) => ({
            ...endpoint,
            verifierModel: { model: `${endpoint.model}-verifier`, evalSetVersion: "ev-0009" },
          })),
        }),
      },
    );
    // Only the owner-controlled box survives the class, however attractive another provider's
    // recorded verifier model looks: issue #9 cannot widen §12.4.
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["local_box"]);
    for (const providerKey of ["workers_ai", "claude"]) {
      expect(decision.skipped).toContainEqual({ providerKey, reason: "not_cleared" });
    }
    for (const providerKey of ["deepseek", "openrouter"]) {
      expect(decision.skipped).toContainEqual({ providerKey, reason: "task_unsupported" });
    }
  });
});

describe("health, circuits and quota (plan §12.4 (b)/(c), F37)", () => {
  it("an open circuit is skipped and closes after a successful health check", () => {
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
    book.recordFailure("local_box", T0);
    book.recordFailure("local_box", T0 + 100);

    const blocked = route(
      { task: "compose", dataClass: "public", chain: ["local_box"], nowMs: T0 + 200 },
      { book },
    );
    expect(blocked.eligible).toEqual([]);
    expect(blocked.skipped).toEqual([{ providerKey: "local_box", reason: "circuit_open" }]);

    book.noteHealthCheck("local_box", true, T0 + 500);
    const after = route({ task: "compose", dataClass: "public", chain: ["local_box"], nowMs: T0 + 600 }, { book });
    expect(after.eligible.map((entry) => entry.providerKey)).toEqual(["local_box"]);
  });

  it("a quota-exhausted provider is skipped without relaxing anything else", () => {
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
    book.noteQuotaExhausted("workers_ai", true);
    const decision = route(
      { task: "compose", dataClass: "internal", chain: ["workers_ai", "claude"], nowMs: T0 },
      { book },
    );
    expect(decision.skipped).toContainEqual({ providerKey: "workers_ai", reason: "quota_exhausted" });
    expect(decision.eligible.map((entry) => entry.providerKey)).toEqual(["claude"]);
  });
});
