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

/** Cost order, cheapest first (TOI-ADR-12). A tenant may narrow it, never reorder it. */
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
