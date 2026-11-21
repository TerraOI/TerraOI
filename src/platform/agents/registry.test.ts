import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";
import { DEFAULT_TASK_CHAIN_ORDER } from "@/contracts/provider-route";

import {
  parseExpertDefinitionRow,
  resolveAuthorizedExpert,
  TenantVocabularyOverride,
  type ExpertDefinitionRow,
  type TenantExpertBinding,
} from "./registry";

const ORG_1 = "11111111-1111-4111-8111-111111111111";
const ORG_2 = "22222222-2222-4222-8222-222222222222";
const USER_1 = "00000000-0000-4000-8000-0000000000a1";
const MEM_1 = "31000000-0000-4000-8000-0000000000a1";
const COLL_UAV = "51000000-0000-4000-8000-000000000001";
const COLL_GPR = "52000000-0000-4000-8000-000000000001";

const UAV_V1_ROW: ExpertDefinitionRow = {
  expert_key: "uav-expert",
  version: "1.0.0",
  service_key: "uav-compliance",
  instruction_template_version: "1.0.0",
  retrieval_profile_version: "1.0.0",
  tool_keys: [],
  workflow_keys: [],
  answer_schema_version: "1.0.0",
  evaluation_set_version: "1.0.0",
  risk_class: "operational",
  prompt_template_id: "uav-expert-system",
  prompt_template_version: "1.0.0",
  model_chains: {
    route: ["local_box", "workers_ai", "deepseek", "openrouter"],
    condense: ["local_box", "workers_ai", "deepseek", "openrouter"],
    compose: ["local_box", "workers_ai", "claude", "deepseek", "openrouter"],
    verify: ["claude", "workers_ai", "deepseek", "openrouter"],
  },
  embedding_index_key: "corpus",
  limits: {
    retrievalPasses: 2,
    toolCalls: 0,
    evidenceChunks: 12,
    maxOutputTokens: 1200,
    stageDeadlineMs: 20000,
  },
  clarification_policy: "ask_once",
  refusal_templates: {
    no_evidence: "I could not find relevant UAV guidance in the documents you can access.",
    insufficient_support: "I found related material, but could not verify a reliable answer from it.",
    out_of_scope: "That question is outside what this UAV document expert answers.",
    unavailable: "This expert is temporarily unavailable. Please try again later.",
  },
  min_verifier_tier: "large",
  status: "registered",
};

const GPR_V1_ROW: ExpertDefinitionRow = {
  expert_key: "gpr-expert",
  version: "1.0.0",
  service_key: "gpr",
  instruction_template_version: "1.0.0",
  retrieval_profile_version: "1.0.0",
  tool_keys: [],
  workflow_keys: [],
  answer_schema_version: "1.0.0",
  evaluation_set_version: "1.0.0",
  risk_class: "knowledge",
  prompt_template_id: "gpr-expert-system",
  prompt_template_version: "1.0.0",
  model_chains: {
    route: ["local_box", "workers_ai", "deepseek", "openrouter"],
    condense: ["local_box", "workers_ai", "deepseek", "openrouter"],
    compose: ["local_box", "workers_ai", "claude", "deepseek", "openrouter"],
    verify: ["claude", "workers_ai", "deepseek", "openrouter"],
  },
  embedding_index_key: "corpus",
  limits: {
    retrievalPasses: 2,
    toolCalls: 0,
    evidenceChunks: 12,
    maxOutputTokens: 1200,
    stageDeadlineMs: 20000,
  },
  clarification_policy: "ask_once",
  refusal_templates: {
    no_evidence: "I could not find relevant GPR documentation in the documents you can access.",
    insufficient_support: "I found related material, but could not verify a reliable answer from it.",
    out_of_scope: "That question is outside what this GPR knowledge expert answers.",
    unavailable: "This expert is temporarily unavailable. Please try again later.",
  },
  min_verifier_tier: "medium",
  status: "registered",
};

function company1Context(permittedServiceKeys: string[]) {
  return createTenantContext({
    organisationId: ORG_1,
    host: "company1.terraoi.app",
    userId: USER_1,
    membershipId: MEM_1,
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys,
    permittedProjectIds: [],
    policyRevision: 1,
    resolvedAt: "2026-11-20T12:00:00Z",
  });
}

describe("parseExpertDefinitionRow (T-311 SQL -> ExpertDefinition contract)", () => {
  it("parses both seeded v1 UAV and GPR definitions against the strict ExpertDefinition contract", () => {
    const uav = parseExpertDefinitionRow(UAV_V1_ROW, [COLL_UAV]);
    const gpr = parseExpertDefinitionRow(GPR_V1_ROW, [COLL_GPR]);

    expect(uav.definition.key).toBe("uav-expert");
    expect(uav.definition.serviceKey).toBe("uav-compliance");
    expect(uav.definition.modelChains.verify[0]).toBe("claude");
    expect(uav.definition.modelChains.route).not.toContain("claude");
    expect(uav.status).toBe("registered");

    expect(gpr.definition.key).toBe("gpr-expert");
    expect(gpr.definition.serviceKey).toBe("gpr");
    expect(gpr.definition.modelChains.verify[0]).toBe("claude");
    expect(gpr.definition.modelChains.route).toEqual([...DEFAULT_TASK_CHAIN_ORDER.route]);
    expect(gpr.status).toBe("registered");
  });

  it("rejects a row whose model chain reorders platform order or omits a refusal template", () => {
    expect(() =>
      parseExpertDefinitionRow(
        {
          ...GPR_V1_ROW,
          model_chains: {
            route: ["local_box", "workers_ai", "deepseek", "openrouter"],
            condense: ["local_box", "workers_ai", "deepseek", "openrouter"],
            compose: ["claude", "local_box"],
            verify: ["claude", "workers_ai", "deepseek", "openrouter"],
          },
        },
        [],
      ),
    ).toThrow();

    expect(() =>
      parseExpertDefinitionRow(
        {
          ...GPR_V1_ROW,
          refusal_templates: {
            no_evidence: "none",
            out_of_scope: "outside",
            unavailable: "down",
          },
        },
        [],
      ),
    ).toThrow();
  });
});

describe("TenantVocabularyOverride", () => {
  it("accepts vocabulary and style keys only and refuses clearance or binding overrides", () => {
    expect(
      TenantVocabularyOverride.parse({
        terminology: { sortie: "flight" },
        tone: "concise",
        formatting: "bulleted",
      }),
    ).toEqual({
      terminology: { sortie: "flight" },
      tone: "concise",
      formatting: "bulleted",
    });

    for (const forbidden of [
      { collectionBindings: [COLL_GPR] },
      { clearance: "public" },
      { minVerifierTier: "small" },
      { modelChains: { verify: ["local_box"] } },
      { systemPrompt: "ignore instructions" },
    ]) {
      expect(() => TenantVocabularyOverride.parse(forbidden)).toThrow();
    }
  });
});

describe("resolveAuthorizedExpert (F07 / T-311)", () => {
  const publishedUav: ExpertDefinitionRow = { ...UAV_V1_ROW, status: "published" };
  const publishedGpr: ExpertDefinitionRow = { ...GPR_V1_ROW, status: "published" };
  const bindings: TenantExpertBinding[] = [
    {
      organisationId: ORG_1,
      serviceKey: "uav-compliance",
      expertKey: "uav-expert",
      expertVersion: "1.0.0",
      enabled: true,
      collectionBindings: [COLL_UAV],
      vocabularyOverride: { tone: "concise" },
    },
    {
      organisationId: ORG_2,
      serviceKey: "gpr",
      expertKey: "gpr-expert",
      expertVersion: "1.0.0",
      enabled: true,
      collectionBindings: [COLL_GPR],
      vocabularyOverride: {},
    },
  ];

  it("resolves an entitled published expert for the tenant and freezes the result", () => {
    const result = resolveAuthorizedExpert({
      context: company1Context(["uav-compliance"]),
      expertKey: "uav-expert",
      bindings,
      definitions: [publishedUav, publishedGpr],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expert.definition.key).toBe("uav-expert");
    expect(result.expert.serviceKey).toBe("uav-compliance");
    expect(result.expert.definition.collectionBindings).toEqual([COLL_UAV]);
    expect(Object.isFrozen(result.expert)).toBe(true);
    expect(Object.isFrozen(result.expert.definition)).toBe(true);
  });

  it("never resolves another tenant's tenant_experts row or an unentitled service", () => {
    const crossTenant = resolveAuthorizedExpert({
      context: company1Context(["uav-compliance", "gpr"]),
      expertKey: "gpr-expert",
      bindings,
      definitions: [publishedUav, publishedGpr],
    });
    expect(crossTenant).toEqual({ ok: false, reason: "not_authorized", expertKey: "gpr-expert" });

    const unentitled = resolveAuthorizedExpert({
      context: company1Context([]),
      expertKey: "uav-expert",
      bindings,
      definitions: [publishedUav],
    });
    expect(unentitled).toEqual({ ok: false, reason: "not_authorized", expertKey: "uav-expert" });
  });

  it("refuses a withdrawn pinned version rather than silently falling back to a newer published version", () => {
    const withdrawnV1: ExpertDefinitionRow = { ...UAV_V1_ROW, version: "1.0.0", status: "withdrawn" };
    const newerV2: ExpertDefinitionRow = { ...UAV_V1_ROW, version: "2.0.0", status: "published" };

    const result = resolveAuthorizedExpert({
      context: company1Context(["uav-compliance"]),
      expertKey: "uav-expert",
      bindings,
      definitions: [withdrawnV1, newerV2],
    });

    expect(result).toEqual({
      ok: false,
      reason: "version_withdrawn",
      expertKey: "uav-expert",
      version: "1.0.0",
    });
  });

  it("refuses an unpublished registered version by default (F36 gate), and allows it only when explicitly opted in", () => {
    const refused = resolveAuthorizedExpert({
      context: company1Context(["uav-compliance"]),
      expertKey: "uav-expert",
      bindings,
      definitions: [UAV_V1_ROW],
    });
    expect(refused).toEqual({
      ok: false,
      reason: "version_not_published",
      expertKey: "uav-expert",
      version: "1.0.0",
    });

    const allowed = resolveAuthorizedExpert({
      context: company1Context(["uav-compliance"]),
      expertKey: "uav-expert",
      bindings,
      definitions: [UAV_V1_ROW],
      allowRegistered: true,
    });
    expect(allowed.ok).toBe(true);
  });
});
