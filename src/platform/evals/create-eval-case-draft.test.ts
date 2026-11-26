import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import { SAFE_TENANT_RPC_MESSAGE, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { createEvalCaseDraft, type CreateEvalCaseDraftPayload } from "./create-eval-case-draft";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjE4MDAwMDM2MDB9.c2ln";
const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CTX = createTenantContext({
  organisationId: ORG,
  host: "company1.terraoi.test",
  userId: "00000000-0000-4000-8000-0000000000a1",
  membershipId: "55555555-5555-4555-8555-555555555555",
  membershipStatus: "active",
  roles: ["member"],
  permittedServiceKeys: [],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-11T00:00:00.000Z",
});

const PAYLOAD: CreateEvalCaseDraftPayload = {
  caseKey: "UAV-T090",
  expertKey: "uav-expert",
  origin: "expert_written",
  caseType: "answerable",
  question: "Synthetic UAV pre-flight compass check question.",
  dataClass: "internal",
  draftedBy: "builder-agent",
  draftedOn: "2026-11-21",
  payload: { schemaVersion: 1 },
};

function transport(answer: () => Response) {
  const sent: { url: string; body: string }[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    sent.push({
      url: input,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return answer();
  };
  return { sent, fetchImpl };
}

describe("createEvalCaseDraft", () => {
  it("returns the case uuid from create_eval_case_draft_v1", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify(CASE_ID), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await createEvalCaseDraft(CTX, TOKEN, PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, caseId: CASE_ID });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/rpc\/create_eval_case_draft_v1$/);
  });

  it("maps camelCase payload to snake_case p_body and never forges organisation id", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify(CASE_ID), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await createEvalCaseDraft(CTX, TOKEN, PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.p_organisation_id).toBe(ORG);
    expect(body.p_organisation_id).not.toBe(OTHER_ORG);
    expect(Object.keys(body).sort()).toEqual(["p_body", "p_organisation_id"]);
    expect(body.p_body).toEqual({
      case_key: "UAV-T090",
      expert_key: "uav-expert",
      origin: "expert_written",
      case_type: "answerable",
      question: "Synthetic UAV pre-flight compass check question.",
      data_class: "internal",
      drafted_by: "builder-agent",
      drafted_on: "2026-11-21",
      payload: { schemaVersion: 1 },
    });
  });

  it("omits payload key when the caller did not supply one", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify(CASE_ID), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const withoutPayload: CreateEvalCaseDraftPayload = {
      caseKey: PAYLOAD.caseKey,
      expertKey: PAYLOAD.expertKey,
      origin: PAYLOAD.origin,
      caseType: PAYLOAD.caseType,
      question: PAYLOAD.question,
      dataClass: PAYLOAD.dataClass,
      draftedBy: PAYLOAD.draftedBy,
      draftedOn: PAYLOAD.draftedOn,
    };

    await createEvalCaseDraft(CTX, TOKEN, withoutPayload, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    const body = JSON.parse(sent[0]?.body ?? "{}") as { p_body: Record<string, unknown> };
    expect(body.p_body).not.toHaveProperty("payload");
  });

  it("maps tenant rpc failure to a safe employee message", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ code: "28000", message: "not an active member" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await createEvalCaseDraft(CTX, TOKEN, PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("tenancy");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.tenancy);
    expect(JSON.stringify(outcome)).not.toContain("not an active member");
  });

  it("treats a non-uuid RPC payload as backend_failure", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ id: CASE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await createEvalCaseDraft(CTX, TOKEN, PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });
});
