import { dataClassRank, type DataClass } from "@/contracts/data-class";
import type { ProviderKey } from "@/contracts/keys";
import {
  CapabilityTier,
  DEFAULT_TASK_CHAIN_ORDER,
  chainFollowsPlatformOrder,
  type ClearanceMatrix,
  type PlatformProvider,
  type TaskClass,
} from "@/contracts/provider-route";

import { effectiveClearance, type GatewayConfiguration } from "./config";

/**
 * F31 `selectModelRoute` — plan §12.4 "Chain walking (F31 + F38)" rules (a)–(e).
 *
 * The rule that matters most here is the last sentence of §12.4: **"It never relaxes data policy
 * to find a provider."** So this function only *removes* providers from the expert's chain; it
 * never reorders, never substitutes a provider from another task class, and never falls back to a
 * cheaper one because the eligible list is short. An empty list is a legitimate, returned answer
 * (`unavailable` is the caller's job, §8.1).
 *
 * `tenantPolicy` is the tenant's *own recorded* narrowing (plan §12.4: "tenant admins may narrow
 * it"), resolved server-side from tenant configuration — never from a request, a header or a model
 * output (AGENTS.md §4.1, issue #16 N4). `config.clearance` is the reviewed platform baseline.
 */

export interface HealthReader {
  /** Circuit state at `nowMs`; anything but `available` removes the provider from the chain. */
  availability(providerKey: ProviderKey, nowMs: number): "available" | "circuit_open" | "unhealthy";
  /** F38 quota window state — (c) of chain walking, tracked separately from the circuit. */
  quotaExhausted(providerKey: ProviderKey): boolean;
}

/** Which providers this deployment can actually reach (an adapter is registered for them). */
export interface AdapterRegistry {
  has(providerKey: ProviderKey): boolean;
}

interface RouteRequestBase {
  /** The payload's highest data class (§6.2), computed by the caller with `maxDataClass`. */
  dataClass: DataClass;
  tenantPolicy?: Partial<ClearanceMatrix>;
  /** The expert's chain for this task; defaults to that task's platform order. */
  chain?: readonly ProviderKey[];
  /** §12.1: for `verify`, the expert's `minVerifierTier`. */
  minTier?: CapabilityTier;
  /** Explicit clock so circuit state is deterministic in tests. */
  nowMs: number;
}

/**
 * §12.4 rule (e) removes "the same model that composed the answer", so a model call that is not a
 * verification has nothing to name here, and a verification **must** name it. A `verify` request
 * that could omit it would be a route that can select the composer, so the union makes that state
 * unrepresentable instead of documenting it.
 */
export interface ModelRouteRequest extends RouteRequestBase {
  task: "route" | "condense" | "compose";
  composedWith?: never;
}

export interface VerifierRouteRequest extends RouteRequestBase {
  task: "verify";
  composedWith: { providerKey: ProviderKey; model: string };
}

export type RouteRequest = ModelRouteRequest | VerifierRouteRequest;

export type RouteSkipReason =
  | "chain_order"
  | "unknown_provider"
  | "task_unsupported"
  | "not_cleared"
  | "no_endpoint"
  | "no_adapter"
  | "circuit_open"
  | "unhealthy"
  | "quota_exhausted"
  | "below_tier"
  | "verifier_not_evaluated"
  | "composed_the_answer"
  | "composer_unknown";

export interface RouteEntry {
  providerKey: ProviderKey;
  /** 1-based position in the expert's chain — the only provider identity an employee may see (§9.3). */
  chainPosition: number;
  capabilityTier: CapabilityTier;
  costRank: number;
  /** The model id this call would use (the evaluated verifier model for a `verify` task). */
  model: string;
}

export interface RouteDecision {
  eligible: RouteEntry[];
  /** Audit-only: why each provider was removed (F40). Never rendered to an employee (§9.3). */
  skipped: { providerKey: ProviderKey; reason: RouteSkipReason }[];
  /** Recorded with every route so the decision can be replayed (F40, issue #16 N4). */
  matrixRevision: number;
  task: TaskClass;
  dataClass: DataClass;
}

const TIER_RANK: Record<CapabilityTier, number> = { small: 0, medium: 1, large: 2 };

export interface RouteDeps {
  config: GatewayConfiguration;
  health: HealthReader;
  adapters: AdapterRegistry;
}

export function selectModelRoute(request: RouteRequest, deps: RouteDeps): RouteDecision {
  const { config, health, adapters } = deps;
  const skipped: { providerKey: ProviderKey; reason: RouteSkipReason }[] = [];
  const decision: RouteDecision = {
    eligible: [],
    skipped,
    matrixRevision: config.matrixRevision,
    task: request.task,
    dataClass: request.dataClass,
  };

  const taskOrder = DEFAULT_TASK_CHAIN_ORDER[request.task];
  const chain = request.chain ?? [...taskOrder];

  // §5.2: an expert may shorten its chain but not reorder it. A reordered chain is not "the
  // expensive order", it is an unreviewed one, so nothing is selected at all.
  if (!chainFollowsPlatformOrder(chain, taskOrder)) {
    for (const providerKey of chain) skipped.push({ providerKey, reason: "chain_order" });
    return decision;
  }

  // Rule (e) cannot be enforced without knowing who composed the answer, so a `verify` route that
  // cannot say selects nothing. The union above makes that a compile error for typed callers; this
  // guard covers a caller whose argument arrived unvalidated (a queue payload, a job row).
  const composedWith: VerifierRouteRequest["composedWith"] | undefined = request.composedWith;
  if (request.task === "verify" && composedWith === undefined) {
    for (const providerKey of chain) skipped.push({ providerKey, reason: "composer_unknown" });
    return decision;
  }

  const rows = new Map<ProviderKey, PlatformProvider>(config.providers.map((row) => [row.providerKey, row]));
  const endpoints = new Map(config.endpoints.map((endpoint) => [endpoint.providerKey, endpoint]));
  // Intersect-only, so a tenant list can never widen the reviewed baseline (§12.4, issue #16 N4).
  const cleared = new Set(effectiveClearance(config, request.tenantPolicy)[request.dataClass]);

  chain.forEach((providerKey, index) => {
    const chainPosition = index + 1;
    const row = rows.get(providerKey);
    if (row === undefined) {
      skipped.push({ providerKey, reason: "unknown_provider" });
      return;
    }
    if (!row.taskClasses.includes(request.task)) {
      skipped.push({ providerKey, reason: "task_unsupported" });
      return;
    }
    // (a) matrix membership **and** the row's own ceiling: both must allow, or the provider is out.
    if (!cleared.has(providerKey) || dataClassRank(request.dataClass) > dataClassRank(row.maxClearedClass)) {
      skipped.push({ providerKey, reason: "not_cleared" });
      return;
    }
    const endpoint = endpoints.get(providerKey);
    if (endpoint === undefined) {
      // The reviewed configuration names no model for this provider: nothing can be called.
      skipped.push({ providerKey, reason: "no_endpoint" });
      return;
    }
    if (!adapters.has(providerKey)) {
      // No adapter is registered in this deployment (T-314/T-215 own the remaining providers).
      skipped.push({ providerKey, reason: "no_adapter" });
      return;
    }
    const availability = health.availability(providerKey, request.nowMs);
    if (availability === "circuit_open") {
      skipped.push({ providerKey, reason: "circuit_open" });
      return;
    }
    if (availability === "unhealthy") {
      skipped.push({ providerKey, reason: "unhealthy" });
      return;
    }
    if (health.quotaExhausted(providerKey)) {
      skipped.push({ providerKey, reason: "quota_exhausted" });
      return;
    }
    // (d) the task's minimum capability tier — for `verify` this is the expert's `minVerifierTier`.
    if (request.minTier !== undefined && TIER_RANK[row.capabilityTier] < TIER_RANK[request.minTier]) {
      skipped.push({ providerKey, reason: "below_tier" });
      return;
    }
    let model = endpoint.model;
    if (request.task === "verify") {
      // Issue #9: a provider verifies only through a model whose adequacy an F35 run recorded.
      const verifierModel = endpoint.verifierModel;
      if (verifierModel === undefined) {
        skipped.push({ providerKey, reason: "verifier_not_evaluated" });
        return;
      }
      // (e) the verifier is never the model that composed this answer.
      if (composedWith !== undefined && composedWith.model === verifierModel.model) {
        skipped.push({ providerKey, reason: "composed_the_answer" });
        return;
      }
      model = verifierModel.model;
    }
    decision.eligible.push({
      providerKey,
      chainPosition,
      capabilityTier: row.capabilityTier,
      costRank: row.costRank,
      model,
    });
  });

  return decision;
}
