import { z } from "zod";

import { ProviderKey, VersionTag } from "@/contracts/keys";
import { ClearanceMatrix, PlatformProvider, narrowClearance } from "@/contracts/provider-route";

/**
 * Gateway configuration (plan §6.1 `model_providers` / `provider_routes`, §12.4).
 *
 * **Provenance (issue #16 N4, AGENTS.md §4.3).** Every value here is *reviewed configuration*: a
 * human recorded the rows, and the supervisor's review of that configuration is what makes it
 * authoritative. Nothing in this repository may build a `GatewayConfiguration` from a request, a
 * query string, a header, a model output, a tenant-editable setting or an application default.
 * `clearance` is the platform baseline the tenant's own policy is *narrowed against* — see
 * `effectiveClearance` below and `narrowClearance` in the frozen contract.
 *
 * The `model_providers` table does not exist yet (no migration carries it), so the configuration
 * is injected into the gateway rather than read from a store; that keeps the port testable and
 * does not change any contract.
 */

/**
 * Deployment-side route detail that the frozen `PlatformProvider` shape does not carry: which
 * model a provider actually serves, and — for issue #9 — whether a **separate, evaluated** model
 * is available for the verifier role. `verifierModel` is recorded only after an F35 run proves the
 * model adequate (§12.1, §14.1); while it is absent the provider is not verifier-eligible. That is
 * how "M1 `verify` starts at Claude" stays configuration instead of a code branch.
 */
export const ProviderEndpoint = z.strictObject({
  providerKey: ProviderKey,
  model: z.string().min(1).max(128),
  contextWindowUnits: z.number().int().positive().optional(),
  verifierModel: z
    .strictObject({
      model: z.string().min(1).max(128),
      evalSetVersion: VersionTag,
    })
    .optional(),
});
export type ProviderEndpoint = z.infer<typeof ProviderEndpoint>;

/** F37 circuit policy for this deployment (§12.4: open after repeated failures, cooldown). */
export const CircuitPolicy = z.strictObject({
  openAfterFailures: z.number().int().positive().default(3),
  cooldownMs: z.number().int().positive().default(60_000),
});
export type CircuitPolicy = z.infer<typeof CircuitPolicy>;

export const GatewayConfiguration = z
  .strictObject({
    providers: z.array(PlatformProvider).min(1),
    endpoints: z.array(ProviderEndpoint),
    clearance: ClearanceMatrix,
    // Written into the run audit with every route so a decision can be replayed (F40).
    matrixRevision: z.number().int().nonnegative(),
    circuit: CircuitPolicy,
  })
  .superRefine((config, ctx) => {
    const rows = new Set(config.providers.map((row) => row.providerKey));
    for (const [index, row] of config.providers.entries()) {
      for (const other of config.providers.slice(index + 1)) {
        if (other.providerKey === row.providerKey) {
          ctx.addIssue({ code: "custom", path: ["providers", index], message: "duplicate provider row" });
        }
      }
    }
    config.endpoints.forEach((endpoint, index) => {
      if (!rows.has(endpoint.providerKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["endpoints", index],
          message: `endpoint for '${endpoint.providerKey}' has no model_providers row`,
        });
      }
    });
  });
export type GatewayConfiguration = z.infer<typeof GatewayConfiguration>;

/** Fail closed on malformed configuration: a typo must not widen clearance or enable a provider. */
export function parseGatewayConfiguration(input: unknown): GatewayConfiguration {
  return GatewayConfiguration.parse(input);
}

/**
 * The single place the tenant's recorded policy meets the reviewed platform baseline: intersect
 * only, so a tenant list can never widen clearance (§12.4, issue #16 N4). `ProviderEndpoint` takes
 * no part in this decision — it carries deployment facts (which model, which context window, which
 * verifier model an F35 run approved) and can only ever *narrow* what the baseline permits.
 */
export function effectiveClearance(
  config: GatewayConfiguration,
  tenantPolicy: Partial<ClearanceMatrix> | undefined,
): ClearanceMatrix {
  return narrowClearance(tenantPolicy, config.clearance);
}
