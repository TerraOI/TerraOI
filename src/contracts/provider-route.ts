import { z } from "zod";

import { DataClass, dataClassRank } from "./data-class";
import { ProviderKey } from "./keys";

/**
 * Model chain and data-class clearance (plan §12.4, TOI-ADR-12/13).
 *
 * This module is the **shape** of the chain plus the pure clearance arithmetic the gateway and
 * the supervisor's configuration review share. Choosing providers, health and circuits (F31,
 * F37, F38) is implemented in `src/platform/gateway/` (T-115, T-314).
 */

/**
 * The full cost order of TOI-ADR-12 (cheapest first), which is also the default **`compose`**
 * chain. Not every task may use every provider: see `DEFAULT_TASK_CHAIN_ORDER`, because a
 * single flat order would reject the plan's own `verify` chain (§12.4).
 */
export const DEFAULT_PLATFORM_CHAIN: readonly ProviderKey[] = [
  "local_box",
  "workers_ai",
  "claude",
  "deepseek",
  "openrouter",
];

/** Task classes of the bounded M1 pipeline (plan §10.1). Embeddings are pinned, not chained. */
export const TaskClass = z.enum(["route", "condense", "compose", "verify"]);
export type TaskClass = z.infer<typeof TaskClass>;

/**
 * Default chain order **per task class**, from plan §12.4 "Per-task chains":
 * `route`/`condense` skip Claude (cheap work, cheap providers first), `compose` uses the full
 * order, and `verify` puts Claude ahead of Workers AI because the strongest default verifier is
 * what §12.1 needs. An expert may shorten a chain but not reorder it (§5.2), so each chain is
 * checked against its own task's order — not against one global list.
 *
 * Providers that the plan marks "(public only)" for a task are still listed: the data class is
 * enforced by the clearance matrix at call time, not by hiding the provider from the order.
 * The `verify` local-box entry additionally requires a different, adequate model, and "not the
 * model that composed the answer" is chain-walking rule (e) — the gateway's job (T-115), not a
 * contract-level rejection.
 */
export const DEFAULT_TASK_CHAIN_ORDER: Readonly<Record<TaskClass, readonly ProviderKey[]>> = {
  route: ["local_box", "workers_ai", "deepseek", "openrouter"],
  condense: ["local_box", "workers_ai", "deepseek", "openrouter"],
  compose: DEFAULT_PLATFORM_CHAIN,
  verify: ["local_box", "claude", "workers_ai", "deepseek", "openrouter"],
};
export type TaskChainOrders = typeof DEFAULT_TASK_CHAIN_ORDER;

export const CapabilityTier = z.enum(["small", "medium", "large"]);
export type CapabilityTier = z.infer<typeof CapabilityTier>;

/** One row of the platform `model_providers` registry (plan §6.1). No secrets live here. */
export const PlatformProvider = z.strictObject({
  providerKey: ProviderKey,
  capabilityTier: CapabilityTier,
  costRank: z.number().int().positive(),
  taskClasses: z.array(TaskClass).min(1),
  // The highest data class this provider may ever see for this deployment. A route may be
  // allowed for `compose` but still blocked for a class by the matrix below.
  maxClearedClass: DataClass,
  supportsStructuredOutput: z.boolean().default(false),
});
export type PlatformProvider = z.infer<typeof PlatformProvider>;

/** Per-class allowed providers (plan §12.4 "Default clearance matrix"). */
export const ClearanceMatrix = z.strictObject({
  public: z.array(ProviderKey),
  internal: z.array(ProviderKey),
  client_confidential: z.array(ProviderKey),
  restricted: z.array(ProviderKey),
});
export type ClearanceMatrix = z.infer<typeof ClearanceMatrix>;

export const PLATFORM_DEFAULT_CLEARANCE: ClearanceMatrix = {
  public: [...DEFAULT_PLATFORM_CHAIN],
  internal: ["local_box", "workers_ai", "claude"],
  // Workers AI for client_confidential is a tenant decision, not a default (§12.4).
  client_confidential: ["local_box", "claude"],
  // Nothing but owner-controlled hardware may see restricted content (TOI-ADR-12).
  restricted: ["local_box"],
};

const CLEARANCE_KEYS: (keyof ClearanceMatrix)[] = [
  "public",
  "internal",
  "client_confidential",
  "restricted",
];

/**
 * Applies a tenant's provider policy to the platform matrix. Tenant lists may only **narrow**
 * a class; anything the platform does not allow is dropped rather than merged, and an omitted
 * class keeps the platform default (plan §12.4: "tenant admins may narrow it; widening needs a
 * recorded tenant decision and provider-terms review"). Widening is a supervisor decision, so
 * this function has no widening parameter at all.
 *
 * **Provenance of `platform` (issue #16 N4).** The platform matrix is reviewed configuration:
 * it is assembled in `src/platform/gateway/` from `model_providers` / clearance rows that a
 * human recorded, and the supervisor's review of that configuration is what makes it
 * authoritative. The parameter exists so the gateway can pass the tenant's *own* reviewed
 * platform baseline (staging differs from production); it is not a hook for a caller to widen
 * clearance. Nothing in this repository may build that argument from a request, a model output,
 * a tenant-editable setting or a default in application code. Any widening — for example E1,
 * approving Workers AI for `client_confidential` embeddings (issue #6) — is recorded as an ADR
 * or a tenant decision before it reaches this argument, and the gateway logs the matrix revision
 * it used with every route (plan §12.4, F40).
 */
export function narrowClearance(
  tenantPolicy: Partial<ClearanceMatrix> | undefined,
  platform: ClearanceMatrix = PLATFORM_DEFAULT_CLEARANCE,
): ClearanceMatrix {
  if (tenantPolicy) {
    for (const key of Object.keys(tenantPolicy)) {
      if (!CLEARANCE_KEYS.includes(key as keyof ClearanceMatrix)) {
        throw new Error(`narrowClearance: unknown data class '${key}' (fail closed)`);
      }
    }
  }
  const result = {} as ClearanceMatrix;
  for (const cls of CLEARANCE_KEYS) {
    const requested = tenantPolicy?.[cls];
    const allowed = new Set(requested ?? platform[cls]);
    // Preserve the platform cost order in the output.
    result[cls] = platform[cls].filter((provider) => allowed.has(provider));
  }
  return result;
}

/**
 * True when `chain` is a subsequence of `platformOrder` (plan §5.2: "Experts may shorten their
 * chains but not reorder them past their data policy"). Unknown providers fail.
 *
 * `platformOrder` must be the order for **that task** (`DEFAULT_TASK_CHAIN_ORDER[task]`); the
 * default argument is the full cost order, which is only correct for `compose`.
 */
export function chainFollowsPlatformOrder(
  chain: readonly string[],
  platformOrder: readonly string[] = DEFAULT_PLATFORM_CHAIN,
): boolean {
  let cursor = 0;
  for (const provider of chain) {
    const index = platformOrder.indexOf(provider, cursor);
    if (index === -1) return false;
    cursor = index + 1;
  }
  return true;
}

/**
 * An embedding index generation pins exactly one model, dimension, metric and generation
 * (TOI-ADR-13). There is deliberately no fallback field: vectors from different models are
 * incomparable, so an outage degrades search (§8.1) or queues ingestion (§12.4) instead.
 */
export const EmbeddingIndex = z.strictObject({
  indexKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  providerKey: ProviderKey,
  model: z.string().min(1).max(128),
  dimensions: z.number().int().positive(),
  metric: z.enum(["cosine", "l2", "ip"]),
  generation: z.number().int().positive(),
  status: z.enum(["building", "active", "retired"]),
  // Cleared for every class present in the index (§12.4 "Embedding clearance is a separate
  // decision"); Company1's E1/E2 choice lands here once recorded.
  clearedFor: z.array(DataClass).default([]),
});
export type EmbeddingIndex = z.infer<typeof EmbeddingIndex>;

/** Guard used by ingestion and forms: the highest class M1 accepts for ingested content. */
export const M1_MAX_INGESTION_CLASS: DataClass = "client_confidential";

export function isIngestibleInM1(cls: DataClass): boolean {
  return dataClassRank(cls) <= dataClassRank(M1_MAX_INGESTION_CLASS);
}
