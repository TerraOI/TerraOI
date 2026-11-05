import { z } from "zod";

import { CapabilityTier, DEFAULT_PLATFORM_CHAIN, chainFollowsPlatformOrder } from "./provider-route";
import { ExpertKey, ProviderKey, ServiceKey, ToolKey, VersionTag } from "./keys";

// The chain order and its guard belong to the provider contract; re-exported here so an
// implementer reading one file sees the whole rule set (plan §5.2 + §12.4).
export { DEFAULT_PLATFORM_CHAIN, chainFollowsPlatformOrder };

/**
 * ExpertDefinition (plan §5.2). An expert is a governed, versioned retrieval/tool/policy
 * contract over shared infrastructure — never inline prompts with secrets, never a tenant
 * selector. Releases are immutable: any change to prompt, chain, retrieval profile or limits
 * creates a new version that must pass its approved eval set (F36).
 */

const UniqueProviderChain = z.array(ProviderKey).min(1).superRefine((chain, ctx) => {
  if (new Set(chain).size !== chain.length) {
    ctx.addIssue({ code: "custom", message: "a model chain may list a provider only once" });
  }
});

export const ExpertLimits = z.strictObject({
  // Bounded pipeline (§8.3, §10.1). The values are engineering defaults set by the expert
  // release; the contract only forbids unbounded or non-integer limits.
  retrievalPasses: z.number().int().positive(),
  toolCalls: z.number().int().nonnegative(),
  evidenceChunks: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  stageDeadlineMs: z.number().int().positive(),
});
export type ExpertLimits = z.infer<typeof ExpertLimits>;

export const ExpertDefinition = z
  .strictObject({
    key: ExpertKey,
    version: VersionTag,
    serviceKey: ServiceKey,
    instructionTemplateVersion: VersionTag,
    retrievalProfileVersion: VersionTag,
    // Resolved and authorized by the server (F07); an employee may narrow, never widen (§8.1).
    collectionBindings: z.array(z.uuid()),
    toolKeys: z.array(ToolKey),
    workflowKeys: z.array(ToolKey),
    answerSchemaVersion: VersionTag,
    evaluationSetVersion: VersionTag,
    riskClass: z.enum(["knowledge", "operational", "commercial"]),
    // Prompt bodies live in the prompt registry (plan §6.1), referenced by id + version.
    promptTemplateRef: z.strictObject({ id: z.string().min(1).max(128), version: VersionTag }),
    modelChains: z.strictObject({
      route: UniqueProviderChain.optional(),
      condense: UniqueProviderChain,
      compose: UniqueProviderChain,
      verify: UniqueProviderChain,
    }),
    // Pinned per generation; never chained (TOI-ADR-13).
    embeddingIndexKey: z.string().min(1).max(64),
    limits: ExpertLimits,
    clarificationPolicy: z.enum(["ask_once", "never"]),
    refusalTemplates: z.strictObject({
      no_evidence: z.string().min(1).max(1000),
      out_of_scope: z.string().min(1).max(1000),
      unavailable: z.string().min(1).max(1000),
    }),
    minVerifierTier: CapabilityTier,
  })
  .superRefine((expert, ctx) => {
    // §12.1: with no eligible verifier at or above the tier, requirement claims are withheld,
    // so the tier must be stated rather than inferred at runtime.
    if (expert.riskClass !== "knowledge" && expert.minVerifierTier === "small") {
      ctx.addIssue({
        code: "custom",
        path: ["minVerifierTier"],
        message: "operational and commercial experts need at least a medium verifier tier (§12.1)",
      });
    }
  });

export type ExpertDefinition = z.infer<typeof ExpertDefinition>;
