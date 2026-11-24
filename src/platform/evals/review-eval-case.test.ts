import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import { SAFE_TENANT_RPC_MESSAGE, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { reviewEvalCase } from "./review-eval-case";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjE4MDAwMDM2MDB9.c2ln";
const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CTX = createTenantContext({
  organisationId: ORG,
  host: "company1.terraoi.test",
  userId: "00000000-0000-4000-8000-0000000000a2",
  membershipId: "55555555-5555-4555-8555-555555555555",
  membershipStatus: "active",
  roles: ["member"],
  permittedServiceKeys: [],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-11T00:00:00.000Z",
});

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

describe("reviewEvalCase", () => {
  it("succeeds on a void 204 from review_eval_case_v1", async () => {
    const { sent, fetchImpl } = transport(() => new Response(null, { status: 204 }));

    const outcome = await reviewEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "approve", edits: {} },
      { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    expect(outcome).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/rpc\/review_eval_case_v1$/);
  });

  it("succeeds when PostgREST returns JSON null for a void RPC", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response("null", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await reviewEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "reject" },
      { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    expect(outcome).toEqual({ ok: true });
  });

  it("forwards p_case_id, p_decision, p_edits and never forges organisation id", async () => {
    const { sent, fetchImpl } = transport(() => new Response(null, { status: 204 }));

    await reviewEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "edit", edits: { question: "restated" } },
      { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    );
    await reviewEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "approve", edits: null },
      { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    expect(sent).toHaveLength(2);
    const editBody = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    const approveBody = JSON.parse(sent[1]?.body ?? "{}") as Record<string, unknown>;
    expect(editBody).toEqual({
      p_organisation_id: ORG,
      p_case_id: CASE_ID,
      p_decision: "edit",
      p_edits: { question: "restated" },
    });
    expect(approveBody.p_edits).toEqual({});
    expect(approveBody.p_organisation_id).toBe(ORG);
    expect(approveBody.p_organisation_id).not.toBe(OTHER_ORG);
    expect(Object.keys(editBody).sort()).toEqual([
      "p_case_id",
      "p_decision",
      "p_edits",
      "p_organisation_id",
    ]);
  });

  it("maps permission denial to a safe tenancy employee message", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ code: "42501", message: "not permitted to review eval cases" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await reviewEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "approve" },
      { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("tenancy");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.tenancy);
    expect(JSON.stringify(outcome)).not.toContain("not permitted");
  });

  it("treats a non-null void RPC payload as backend_failure", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ reviewed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await reviewEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "approve" },
      { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });
});
