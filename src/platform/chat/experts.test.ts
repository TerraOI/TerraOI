import { describe, expect, it } from "vitest";

import { ExpertDefinition } from "@/contracts/expert-definition";

import { CLOSED_CATALOG, ORG_COMPANY1, PROJECT_SITE_A, USER_A2, catalogWith, contextFor } from "./chat-fixtures";
import {
  PROVISIONAL_EXPERTS,
  UnregisteredPrompt,
  composePolicy,
  findExpert,
  instructionFor,
  provisionalCatalog,
  resolveExpertAccess,
} from "./experts";

/**
 * Who may run which expert, and under what policy (plan §10.1, §9.4 F08). The durable registry is
 * T-102c's and T-113's; what is pinned here is the *decision*, which must not change when the source
 * of the grants does.
 */

const KEY = "gpr-field-officer";
const GRANT = { expertKey: KEY, serviceKey: "uav-compliance" };

describe("the provisional definition", () => {
  it("validates against the merged expert contract, so the stand-in cannot drift", () => {
    for (const expert of PROVISIONAL_EXPERTS) {
      expect(() => ExpertDefinition.parse(expert)).not.toThrow();
    }
  });

  it("is labelled unevaluated, because no eval set has run for it (F36)", () => {
    expect(PROVISIONAL_EXPERTS[0]?.evaluationSetVersion).toBe("unevaluated");
  });

  it("grants itself no collection bindings and no tools, so it cannot widen what retrieval may reach", () => {
    const expert = PROVISIONAL_EXPERTS[0];
    expect(expert?.collectionBindings).toEqual([]);
    expect(expert?.toolKeys).toEqual([]);
    expect(expert?.limits.toolCalls).toBe(0);
  });
});

describe("resolveExpertAccess", () => {
  it("allows an expert whose service the membership holds", async () => {
    const access = await resolveExpertAccess({
      context: contextFor(),
      expertKey: KEY,
      projectId: null,
      catalog: catalogWith(GRANT),
    });
    expect(access.ok).toBe(true);
    if (access.ok) expect(access.serviceKey).toBe("uav-compliance");
  });

  it("refuses when the catalog grants nothing, without saying whether the expert exists (#13(2))", async () => {
    const unknown = await resolveExpertAccess({
      context: contextFor(),
      expertKey: "an-expert-that-does-not-exist",
      projectId: null,
      catalog: CLOSED_CATALOG,
    });
    const notGranted = await resolveExpertAccess({
      context: contextFor(),
      expertKey: KEY,
      projectId: null,
      catalog: CLOSED_CATALOG,
    });
    expect(unknown).toEqual(notGranted);
    expect(notGranted.ok).toBe(false);
    if (!notGranted.ok) expect(notGranted.key).toBe("expert_not_permitted");
  });

  it("refuses an expert whose service the membership does not hold, however the request is phrased", async () => {
    // The service list is computed server-side from the membership; nothing in a request can extend
    // it, so the fail-closed path is a context with an empty list (the value today's Data API gives).
    const access = await resolveExpertAccess({
      context: contextFor({ permittedServiceKeys: [] }),
      expertKey: KEY,
      projectId: null,
      catalog: catalogWith(GRANT),
    });
    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.key).toBe("out_of_scope");
  });

  it("treats a posted projectId as a filter the context must already allow (#16 N5)", async () => {
    const outside = await resolveExpertAccess({
      context: contextFor({ permittedProjectIds: [] }),
      expertKey: KEY,
      projectId: PROJECT_SITE_A,
      catalog: catalogWith(GRANT),
    });
    expect(outside.ok).toBe(false);

    const inside = await resolveExpertAccess({
      context: contextFor(),
      expertKey: KEY,
      projectId: PROJECT_SITE_A,
      catalog: catalogWith(GRANT),
    });
    expect(inside.ok).toBe(true);
    if (inside.ok) expect(inside.projectId).toBe(PROJECT_SITE_A);
  });

  it("refuses a project the expert's own grant does not cover", async () => {
    const other = "41000000-0000-4000-8000-000000000009";
    const access = await resolveExpertAccess({
      // Both projects are permitted to the member; the grant narrows to one of them.
      context: contextFor({ permittedProjectIds: [PROJECT_SITE_A, other] }),
      expertKey: KEY,
      projectId: other,
      catalog: catalogWith({ ...GRANT, projectIds: [PROJECT_SITE_A] }),
    });
    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.key).toBe("out_of_scope");
  });

  it("the refusal names no expert, no service and no project", async () => {
    const access = await resolveExpertAccess({
      context: contextFor({ permittedServiceKeys: [] }),
      expertKey: KEY,
      projectId: PROJECT_SITE_A,
      catalog: catalogWith(GRANT),
    });
    const text = JSON.stringify(access);
    expect(text).not.toContain(PROJECT_SITE_A);
    expect(text).not.toContain("uav-compliance");
    expect(text).not.toContain(KEY);
  });

  it("the catalog read sees the context, so a later table-backed read can scope itself", async () => {
    const seen: unknown[] = [];
    const access = await resolveExpertAccess({
      context: contextFor(),
      expertKey: KEY,
      projectId: null,
      catalog: {
        grants: async (ctx) => {
          seen.push(ctx.organisationId);
          return [{ ...GRANT, projectIds: [] }];
        },
      },
    });
    expect(access.ok).toBe(true);
    expect(seen).toEqual([ORG_COMPANY1]);
  });

  it("provisionalCatalog is the in-code stand-in, and its keys match the definitions", async () => {
    const grants = await provisionalCatalog().grants(contextFor());
    expect(grants.map((grant) => grant.expertKey)).toEqual(PROVISIONAL_EXPERTS.map((expert) => expert.key));
  });
});

describe("the policy a run executes under", () => {
  it("projects the definition onto the slice compose reads, without inventing limits", () => {
    const expert = findExpert(KEY);
    if (expert === null) throw new Error("the provisional expert should exist");
    const policy = composePolicy(expert);
    expect(policy.limits).toEqual({
      evidenceChunks: expert.limits.evidenceChunks,
      maxOutputTokens: expert.limits.maxOutputTokens,
      stageDeadlineMs: expert.limits.stageDeadlineMs,
    });
    expect(policy.refusalTemplates).toEqual(expert.refusalTemplates);
    expect(policy.modelChains.verify).toEqual(["claude"]);
    expect(policy.key).toBe(KEY);
  });

  it("a definition pointing at an unregistered prompt body is a wiring bug, said out loud", () => {
    const expert = findExpert(KEY);
    if (expert === null) throw new Error("the provisional expert should exist");
    const dangling = { ...expert, promptTemplateRef: { id: "no-such-prompt", version: "v9" } };
    // The failure is loud and names the reference, because a silent fallback prompt would be a
    // governed artifact replaced by an ungoverned one (plan §6.1).
    expect(() => instructionFor(dangling)).toThrow(UnregisteredPrompt);
    expect(() => instructionFor(dangling)).toThrow(/no-such-prompt@v9/);
  });

  it("every provisional instruction body is non-empty and does not name a provider", () => {
    for (const expert of PROVISIONAL_EXPERTS) {
      const body = instructionFor(expert);
      expect(body.length).toBeGreaterThan(40);
      expect(body).not.toMatch(/claude|openai|deepseek|openrouter|workers_ai/i);
    }
  });
});

describe("the actor never comes from the caller", () => {
  it("no input to the access check carries a user id, and no refusal mentions one", async () => {
    const access = await resolveExpertAccess({
      context: contextFor({ permittedServiceKeys: [] }),
      expertKey: KEY,
      projectId: null,
      catalog: catalogWith(GRANT),
    });
    expect(JSON.stringify(access)).not.toContain(USER_A2);
    expect(ORG_COMPANY1.length).toBeGreaterThan(0);
  });
});
