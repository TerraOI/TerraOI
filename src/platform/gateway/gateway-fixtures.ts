import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";
import {
  DEFAULT_PLATFORM_CHAIN,
  PLATFORM_DEFAULT_CLEARANCE,
  type ClearanceMatrix,
  type PlatformProvider,
} from "@/contracts/provider-route";
import type { ProviderKey } from "@/contracts/keys";

import { parseGatewayConfiguration, type GatewayConfiguration, type ProviderEndpoint } from "./config";
import type { HealthProbe } from "./circuit";

/**
 * Synthetic fixtures for the gateway tests (AGENTS.md §4.7: synthetic data only, no secrets).
 * Provider keys are the five platform providers of TOI-ADR-12; model names are placeholders,
 * exactly as issue #9 instructs for `model_providers` rows until the owner supplies real ones.
 */

export function syntheticContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return createTenantContext({
    organisationId: "0f9fd6dd-0f0a-4b02-9b45-2fda5e6d1e01",
    host: "company1.terraoi.app",
    userId: "6f0a1e6a-8f4a-4b57-9e30-1d6b9a0e4a11",
    membershipId: "b1d1e0a6-1a5c-4d7e-9c47-2c1e6a5b0f22",
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: ["uav"],
    permittedProjectIds: [],
    policyRevision: 1,
    resolvedAt: "2026-11-05T09:00:00.000Z",
    ...overrides,
  });
}

export const RUN_ID = "2b1c6f0e-4a5d-4e33-9b0e-7c2f1a5d8e04";
export const CONVERSATION_ID = "conv-0001";

/** The full `compose` cost order of TOI-ADR-12, as an expert would write it. */
export const FULL_COMPOSE_CHAIN = [...DEFAULT_PLATFORM_CHAIN];

/**
 * Capability tiers here are the plan's §12.4 roles (box/Workers AI mid-tier, Claude the strongest
 * default verifier); DeepSeek and OpenRouter are public-only fallbacks. Real tiers are
 * `model_providers` data, evaluated before an expert release (F35/F36).
 */
export const PROVIDER_ROWS: PlatformProvider[] = [
  {
    providerKey: "local_box",
    capabilityTier: "medium",
    costRank: 1,
    taskClasses: ["route", "condense", "compose", "verify"],
    maxClearedClass: "restricted",
    supportsStructuredOutput: true,
  },
  {
    providerKey: "workers_ai",
    capabilityTier: "medium",
    costRank: 2,
    taskClasses: ["route", "condense", "compose", "verify"],
    maxClearedClass: "internal",
    supportsStructuredOutput: true,
  },
  {
    providerKey: "claude",
    capabilityTier: "large",
    costRank: 3,
    taskClasses: ["route", "condense", "compose", "verify"],
    maxClearedClass: "client_confidential",
    supportsStructuredOutput: true,
  },
  {
    providerKey: "deepseek",
    capabilityTier: "medium",
    costRank: 4,
    taskClasses: ["route", "condense", "compose"],
    maxClearedClass: "public",
    supportsStructuredOutput: false,
  },
  {
    providerKey: "openrouter",
    capabilityTier: "large",
    costRank: 5,
    taskClasses: ["route", "condense", "compose"],
    maxClearedClass: "public",
    supportsStructuredOutput: false,
  },
];

/**
 * M1 endpoints: only Claude carries a recorded, evaluated verifier model, which is what issue #9
 * decided ("the verify chain starts at Claude"). The box gets one only after an F35 run proves a
 * second, adequate model on it.
 */
export const M1_ENDPOINTS: ProviderEndpoint[] = [
  { providerKey: "local_box", model: "open-weights-alpha" },
  { providerKey: "workers_ai", model: "hosted-beta" },
  {
    providerKey: "claude",
    model: "hosted-gamma",
    verifierModel: { model: "hosted-gamma", evalSetVersion: "ev-0001" },
  },
  { providerKey: "deepseek", model: "hosted-delta" },
  { providerKey: "openrouter", model: "hosted-epsilon" },
];

export interface FixtureOptions {
  /** The reviewed platform baseline the tenant policy is narrowed against (issue #16 N4). */
  clearance?: ClearanceMatrix;
  endpoints?: ProviderEndpoint[];
  providers?: PlatformProvider[];
  matrixRevision?: number;
  openAfterFailures?: number;
  cooldownMs?: number;
}

export function testConfiguration(options: FixtureOptions = {}): GatewayConfiguration {
  return parseGatewayConfiguration({
    providers: options.providers ?? PROVIDER_ROWS,
    endpoints: options.endpoints ?? M1_ENDPOINTS,
    clearance: options.clearance ?? PLATFORM_DEFAULT_CLEARANCE,
    matrixRevision: options.matrixRevision ?? 7,
    circuit: {
      openAfterFailures: options.openAfterFailures ?? 2,
      cooldownMs: options.cooldownMs ?? 30_000,
    },
  });
}

export interface FakeProbe extends HealthProbe {
  providerKey: ProviderKey;
  healthChecks: number;
}

/** A recorded health probe: F37 checks are asserted by call counts, never by a real box. */
export function fakeProbe(providerKey: ProviderKey, options: { healthy: boolean }): FakeProbe {
  const probe: FakeProbe = {
    providerKey,
    healthChecks: 0,
    async health() {
      probe.healthChecks += 1;
      return options.healthy;
    },
  };
  return probe;
}

export function registryOf<T extends { providerKey: ProviderKey }>(...entries: T[]): Map<ProviderKey, T> {
  return new Map(entries.map((entry) => [entry.providerKey, entry]));
}
