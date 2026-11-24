import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import { SAFE_TENANT_RPC_MESSAGE, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { caseIdToUuidFromList, listEvalCases } from "./list-eval-cases";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjE4MDAwMDM2MDB9.c2ln";

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

const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

describe("caseIdToUuidFromList", () => {
  it("maps case_key to id with first-wins on duplicates and skips empty keys", () => {
    const map = caseIdToUuidFromList([
      { id: CASE_A, caseKey: "UAV-E001", expertKey: "uav-expert", status: "approved" },
      { id: CASE_B, caseKey: "UAV-E001", expertKey: "uav-expert", status: "approved" },
      { id: CASE_B, caseKey: "", expertKey: "uav-expert", status: "approved" },
      { id: CASE_B, caseKey: "   ", expertKey: "uav-expert", status: "approved" },
      { id: CASE_B, caseKey: "GPR-E001", expertKey: "gpr-expert", status: "approved" },
    ]);
    expect(map).toEqual({
      "UAV-E001": CASE_A,
      "GPR-E001": CASE_B,
    });
  });
});

describe("listEvalCases", () => {
  it("parses PostgREST snake_case rows into cases and a caseIdToUuid map", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(
          JSON.stringify([
            {
              id: CASE_A,
              case_key: "UAV-E001",
              expert_key: "uav-expert",
              status: "approved",
              origin: "expert_written",
              case_type: "answerable",
              question: "q",
              data_class: "internal",
              approved_by: "00000000-0000-4000-8000-0000000000a2",
              approved_at: "2026-11-21T12:00:00.000Z",
              created_by: "00000000-0000-4000-8000-0000000000a1",
            },
            {
              id: CASE_B,
              case_key: "GPR-E001",
              expert_key: "gpr-expert",
              status: "approved",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const outcome = await listEvalCases(CTX, TOKEN, "approved", {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cases).toEqual([
      { id: CASE_A, caseKey: "UAV-E001", expertKey: "uav-expert", status: "approved" },
      { id: CASE_B, caseKey: "GPR-E001", expertKey: "gpr-expert", status: "approved" },
    ]);
    expect(caseIdToUuidFromList(outcome.cases)).toEqual({
      "UAV-E001": CASE_A,
      "GPR-E001": CASE_B,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/rpc\/list_eval_cases_v1$/);
  });

  it("returns an empty cases array when the RPC returns []", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await listEvalCases(CTX, TOKEN, "approved", {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, cases: [] });
  });

  it("maps tenant rpc failure to a safe employee message", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ code: "42501", message: "permission denied" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await listEvalCases(CTX, TOKEN, "approved", {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("tenancy");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.tenancy);
  });

  it("forwards p_status (including null) and never forges organisation id in the body", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await listEvalCases(CTX, TOKEN, "approved", {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });
    await listEvalCases(CTX, TOKEN, null, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(sent).toHaveLength(2);
    const approvedBody = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    const nullBody = JSON.parse(sent[1]?.body ?? "{}") as Record<string, unknown>;
    expect(approvedBody.p_status).toBe("approved");
    expect(nullBody.p_status).toBeNull();
    expect(approvedBody.p_organisation_id).toBe(ORG);
    expect(nullBody.p_organisation_id).toBe(ORG);
    expect(approvedBody.p_organisation_id).not.toBe(OTHER_ORG);
    expect(Object.keys(approvedBody).sort()).toEqual(["p_organisation_id", "p_status"]);
  });

  it("treats a non-array RPC payload as backend_failure", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ id: CASE_A }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await listEvalCases(CTX, TOKEN, "approved", {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });
});
