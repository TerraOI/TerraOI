import { z } from "zod";

import { ExpertDefinition } from "@/contracts/expert-definition";
import { ExpertKey, ServiceKey, VersionTag } from "@/contracts/keys";
import type { TenantContext } from "@/contracts/tenant-context";

/**
 * Immutable expert-definition parser and tenant-scoped resolution helpers (T-311, F07).
 *
 * Maps database rows from `expert_definitions` and `tenant_experts` into the strict
 * `ExpertDefinition` contract without depending on chat UI or eval publication.
 */

export const ExpertDefinitionStatus = z.enum(["registered", "published", "withdrawn"]);
export type ExpertDefinitionStatus = z.infer<typeof ExpertDefinitionStatus>;

export const TenantVocabularyOverride = z.strictObject({
  terminology: z
    .record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(200))
    .refine((entries) => Object.keys(entries).length <= 50, "at most 50 terminology entries")
    .optional(),
  tone: z.string().trim().min(1).max(500).optional(),
  formatting: z.string().trim().min(1).max(500).optional(),
});
export type TenantVocabularyOverride = z.infer<typeof TenantVocabularyOverride>;

export interface ExpertDefinitionRow {
  readonly expert_key: string;
  readonly version: string;
  readonly service_key: string;
  readonly instruction_template_version: string;
  readonly retrieval_profile_version: string;
  readonly tool_keys: readonly string[];
  readonly workflow_keys: readonly string[];
  readonly answer_schema_version: string;
  readonly evaluation_set_version: string;
  readonly risk_class: string;
  readonly prompt_template_id: string;
  readonly prompt_template_version: string;
  readonly model_chains: unknown;
  readonly embedding_index_key: string;
  readonly limits: unknown;
  readonly clarification_policy: string;
  readonly refusal_templates: unknown;
  readonly min_verifier_tier: string;
  readonly status: string;
}

export interface TenantExpertBinding {
  readonly organisationId: string;
  readonly serviceKey: string;
  readonly expertKey: string;
  readonly expertVersion: string;
  readonly enabled: boolean;
  readonly collectionBindings: readonly string[];
  readonly vocabularyOverride: unknown;
}

export interface ParsedExpertRelease {
  readonly definition: ExpertDefinition;
  readonly status: ExpertDefinitionStatus;
}

export interface ResolvedTenantExpert {
  readonly definition: ExpertDefinition;
  readonly serviceKey: ServiceKey;
  readonly status: ExpertDefinitionStatus;
  readonly vocabularyOverride: TenantVocabularyOverride;
}

export type ResolveExpertOutcome =
  | { readonly ok: true; readonly expert: ResolvedTenantExpert }
  | { readonly ok: false; readonly reason: "not_authorized"; readonly expertKey: string }
  | {
      readonly ok: false;
      readonly reason: "version_withdrawn" | "version_not_published";
      readonly expertKey: string;
      readonly version: string;
    };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export function parseExpertDefinitionRow(
  row: ExpertDefinitionRow,
  collectionBindings: readonly string[],
): ParsedExpertRelease {
  const status = ExpertDefinitionStatus.parse(row.status);
  const definition = ExpertDefinition.parse({
    key: row.expert_key,
    version: row.version,
    serviceKey: row.service_key,
    instructionTemplateVersion: row.instruction_template_version,
    retrievalProfileVersion: row.retrieval_profile_version,
    collectionBindings: [...collectionBindings],
    toolKeys: [...row.tool_keys],
    workflowKeys: [...row.workflow_keys],
    answerSchemaVersion: row.answer_schema_version,
    evaluationSetVersion: row.evaluation_set_version,
    riskClass: row.risk_class,
    promptTemplateRef: {
      id: row.prompt_template_id,
      version: row.prompt_template_version,
    },
    modelChains: row.model_chains,
    embeddingIndexKey: row.embedding_index_key,
    limits: row.limits,
    clarificationPolicy: row.clarification_policy,
    refusalTemplates: row.refusal_templates,
    minVerifierTier: row.min_verifier_tier,
  });

  return deepFreeze({ definition, status });
}

export interface ResolveAuthorizedExpertInput {
  readonly context: TenantContext;
  readonly expertKey: string;
  readonly bindings: readonly TenantExpertBinding[];
  readonly definitions: readonly ExpertDefinitionRow[];
}

/**
 * Resolves one immutable expert release for `context.organisationId` only (AGENTS.md §4.1).
 * Never falls back to a newer version when the tenant's pinned version is withdrawn, and
 * refuses unentitled or cross-tenant bindings uniformly so hidden services cannot be enumerated.
 */
export function resolveAuthorizedExpert(
  input: ResolveAuthorizedExpertInput,
): ResolveExpertOutcome {
  const keyParsed = ExpertKey.safeParse(input.expertKey);
  if (!keyParsed.success) {
    return { ok: false, reason: "not_authorized", expertKey: input.expertKey };
  }

  const permitted = new Set<string>(input.context.permittedServiceKeys);
  const binding = input.bindings.find(
    (b) =>
      b.organisationId === input.context.organisationId &&
      b.enabled &&
      b.expertKey === keyParsed.data &&
      permitted.has(b.serviceKey),
  );
  if (!binding) {
    return { ok: false, reason: "not_authorized", expertKey: keyParsed.data };
  }

  const versionParsed = VersionTag.safeParse(binding.expertVersion);
  const serviceParsed = ServiceKey.safeParse(binding.serviceKey);
  if (!versionParsed.success || !serviceParsed.success) {
    return { ok: false, reason: "not_authorized", expertKey: keyParsed.data };
  }

  const row = input.definitions.find(
    (d) =>
      d.expert_key === keyParsed.data &&
      d.version === versionParsed.data &&
      d.service_key === serviceParsed.data,
  );
  if (!row) {
    return { ok: false, reason: "not_authorized", expertKey: keyParsed.data };
  }

  const parsed = parseExpertDefinitionRow(row, binding.collectionBindings);
  switch (parsed.status) {
    case "withdrawn":
      return {
        ok: false,
        reason: "version_withdrawn",
        expertKey: keyParsed.data,
        version: versionParsed.data,
      };
    case "registered":
      return {
        ok: false,
        reason: "version_not_published",
        expertKey: keyParsed.data,
        version: versionParsed.data,
      };
    case "published":
      break;
    default: {
      const exhaustive: never = parsed.status;
      throw new Error(`unexpected expert status: ${String(exhaustive)}`);
    }
  }

  const vocabularyOverride = TenantVocabularyOverride.parse(binding.vocabularyOverride ?? {});
  return {
    ok: true,
    expert: deepFreeze({
      definition: parsed.definition,
      serviceKey: serviceParsed.data,
      status: parsed.status,
      vocabularyOverride,
    }),
  };
}
