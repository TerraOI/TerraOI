import { ExpertDefinition, type ExpertDefinition as ExpertDefinitionValue } from "@/contracts/expert-definition";
import type { ExpertComposePolicy } from "@/platform/agents/compose";
import type { TenantContext } from "@/contracts/tenant-context";
import type { ServiceKey } from "@/contracts/keys";
import { DEFAULT_PLATFORM_CHAIN } from "@/contracts/provider-route";

import type { ChatRefusalKey, ExpertCatalog, ExpertGrant, RefusalNotice } from "./deps";

/**
 * Which expert a chat request may use, and the policy a run is executed under.
 *
 * **What belongs to this packet and what does not.** An expert is a governed, versioned release
 * (plan §5.2, F36) and its durable home is T-113's `expert_versions` table plus T-102c's
 * `expert_grants`; the prompt body is T-103's prompt registry. None of those exist on `main` yet, so
 * this module holds a **provisional, in-code** definition — validated by the merged
 * `ExpertDefinition` contract at module load, so it cannot drift into something the contract would
 * reject — behind two seams that are already the right shape: `ExpertCatalog` (who may use which
 * expert) and `ExpertComposePolicy` (what a run obeys). When T-113 lands, production wiring swaps the
 * catalog for a scoped read and this list goes away; nothing in `run-chat.ts` changes. That swap is
 * stated in the PR rather than left for a reader to find, and the definition below is labelled
 * unevaluated because it has not been through an eval set (F36).
 *
 * Three rules this module enforces, all of them from the non-negotiables rather than preference:
 *
 * - **The service grant comes from the context.** `context.permittedServiceKeys` is computed
 *   server-side from the membership (`resolve-tenant-context.ts:24-35`), so an expert whose service
 *   is not in that list is refused before a question is stored, and a request cannot widen it.
 * - **A posted `projectId` is a filter, never a grant** (issue #16 N5): it must be a project the
 *   context already permits, and an expert whose grant narrows to other projects is refused.
 * - **A refusal says nothing about what exists.** The reason is one of two closed keys, and the
 *   message is the expert's own template or a fixed sentence — never "that expert exists but you may
 *   not use it", which is a probe (plan §8.2, #13(2)).
 */

/**
 * The provisional M1 skeleton expert: knowledge-class, no tools, no collection bindings of its own
 * (a retrieval profile belongs to T-114), and a verify chain that names only Claude — the one
 * endpoint with a recorded, evaluated verifier model in `gateway-fixtures.ts:95-105`.
 */
export const PROVISIONAL_EXPERTS: readonly ExpertDefinitionValue[] = [
  ExpertDefinition.parse({
    key: "gpr-field-officer",
    version: "provisional-v0-unevaluated",
    serviceKey: "uav-compliance",
    instructionTemplateVersion: "v1",
    retrievalProfileVersion: "unbound-v0",
    collectionBindings: [],
    toolKeys: [],
    workflowKeys: [],
    answerSchemaVersion: "v1",
    // Honest label, not a placeholder to fill in: no eval set has run for this definition (F36), and
    // a release that has not passed one cannot be offered to a real tenant.
    evaluationSetVersion: "unevaluated",
    riskClass: "knowledge",
    promptTemplateRef: { id: "gpr-field-officer/instruction", version: "v1" },
    modelChains: {
      route: ["local_box", "workers_ai"],
      condense: ["local_box", "workers_ai"],
      compose: [...DEFAULT_PLATFORM_CHAIN],
      verify: ["claude"],
    },
    embeddingIndexKey: "unbound-v0",
    limits: {
      retrievalPasses: 1,
      toolCalls: 0,
      evidenceChunks: 8,
      maxOutputTokens: 1200,
      stageDeadlineMs: 30_000,
    },
    clarificationPolicy: "never",
    refusalTemplates: {
      no_evidence: "Nothing in the documents you are allowed to read answers this question.",
      out_of_scope: "That question is outside what this expert covers.",
      unavailable: "The assistant could not answer just now. Please try again shortly.",
    },
    minVerifierTier: "medium",
  }),
];

/**
 * The instruction body for a `promptTemplateRef`. Bodies belong in the prompt registry (plan §6.1),
 * which has no table yet, so the text is code here and its version is the definition's own ref: a
 * definition pointing at a body this map does not have is a wiring bug caught at call time, not a
 * prompt the model invents. Retrieved text is delimited as data inside the compose prompt itself
 * (`compose.ts:192-210`), which is where the injection guard lives.
 */
const INSTRUCTION_BODIES: Readonly<Record<string, string>> = {
  "gpr-field-officer/instruction@v1":
    "You are TerraOI's field-compliance assistant for general visual-observation flight rules. " +
    "Answer the operator's question for the site they are working on, in plain language, and state " +
    "which document each statement rests on. If the evidence does not cover part of the question, " +
    "say so instead of reasoning around it.",
};

export class UnregisteredPrompt extends Error {}

export function instructionFor(expert: ExpertDefinitionValue): string {
  const key = `${expert.promptTemplateRef.id}@${expert.promptTemplateRef.version}`;
  const body = INSTRUCTION_BODIES[key];
  if (body === undefined) throw new UnregisteredPrompt(`no instruction body registered for ${key}`);
  return body;
}

/** The slice `composeAnswer` reads (compose.ts:53-63); restated here by projection, never by cast. */
export function composePolicy(expert: ExpertDefinitionValue): ExpertComposePolicy {
  return {
    key: expert.key,
    version: expert.version,
    riskClass: expert.riskClass,
    modelChains: { compose: expert.modelChains.compose, verify: expert.modelChains.verify },
    minVerifierTier: expert.minVerifierTier,
    limits: {
      evidenceChunks: expert.limits.evidenceChunks,
      maxOutputTokens: expert.limits.maxOutputTokens,
      stageDeadlineMs: expert.limits.stageDeadlineMs,
    },
    refusalTemplates: expert.refusalTemplates,
    evaluationSetVersion: expert.evaluationSetVersion,
  };
}

/** A named expert, found or not; the search is over `ExpertDefinition` values, not over ids. */
export function findExpert(expertKey: string): ExpertDefinitionValue | null {
  for (const expert of PROVISIONAL_EXPERTS) if (expert.key === expertKey) return expert;
  return null;
}

export function provisionalCatalog(): ExpertCatalog {
  return {
    async grants(): Promise<readonly ExpertGrant[]> {
      return PROVISIONAL_EXPERTS.map((expert) => ({
        expertKey: expert.key,
        serviceKey: expert.serviceKey,
        projectIds: [],
      }));
    },
  };
}

export type ExpertAccess =
  | { ok: true; expert: ExpertDefinitionValue; serviceKey: ServiceKey; projectId: string | null }
  | { ok: false; key: Extract<ChatRefusalKey, "expert_not_permitted" | "out_of_scope">; notice: RefusalNotice };

export interface ExpertAccessInput {
  context: TenantContext;
  expertKey: string;
  /** The project the employee narrowed to, if any — a filter, checked against the context. */
  projectId: string | null | undefined;
  catalog: ExpertCatalog;
}

/**
 * The pre-flight permission read. It refuses **before** anything is stored or dialled, so an
 * unpermitted expert costs no run row and no model call (plan §9.4 F08). It is defense in depth, not
 * the decision: the database re-checks the `chat.ask` area, ownership and the project audience on
 * every write (`chat_actor_may_ask`, `chat_conversation_owned`), and a caller that skipped this
 * function still gets a 42501 from Postgres.
 */
export async function resolveExpertAccess(input: ExpertAccessInput): Promise<ExpertAccess> {
  const expert = findExpert(input.expertKey);
  const grants = await input.catalog.grants(input.context);
  const grant = grants.find((row) => row.expertKey === input.expertKey);

  // One answer for "no such expert" and "not yours to use" (#13(2)): the difference would tell an
  // attacker which expert keys this deployment has.
  if (expert === null || grant === undefined) {
    return {
      ok: false,
      key: "expert_not_permitted",
      notice: {
        key: "expert_not_permitted",
        message: "That assistant is not available to you.",
      },
    };
  }

  // The service that licenses the expert has to be one this membership holds. An empty
  // `permittedServiceKeys` is today's fail-closed value (the service registry is not built), and an
  // empty list means no expert may run — which is the direction the plan wants, not a bug to widen.
  const permitted: readonly string[] = input.context.permittedServiceKeys;
  if (!permitted.includes(grant.serviceKey)) {
    return {
      ok: false,
      key: "out_of_scope",
      notice: { key: "out_of_scope", message: expert.refusalTemplates.out_of_scope },
    };
  }

  if (input.projectId !== undefined && input.projectId !== null) {
    if (!input.context.permittedProjectIds.includes(input.projectId)) {
      return { ok: false, key: "out_of_scope", notice: { key: "out_of_scope", message: expert.refusalTemplates.out_of_scope } };
    }
    if (grant.projectIds.length > 0 && !grant.projectIds.includes(input.projectId)) {
      return { ok: false, key: "out_of_scope", notice: { key: "out_of_scope", message: expert.refusalTemplates.out_of_scope } };
    }
  }

  return { ok: true, expert, serviceKey: grant.serviceKey, projectId: input.projectId ?? null };
}
