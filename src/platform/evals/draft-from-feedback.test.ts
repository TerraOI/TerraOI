import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import { SAFE_TENANT_RPC_MESSAGE, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import {
  draftEvalCaseFromFeedback,
  type DraftEvalCaseFromFeedbackPayload,
} from "./draft-from-feedback";

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

const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MESSAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const BASE_PAYLOAD: DraftEvalCaseFromFeedbackPayload = {
  expertKey: "uav-expert",
  question: "Synthetic pilot question used only for feedback-draft unit tests.",
  dataClass: "client_confidential",
  rating: "incorrect",
  derivedFromRunId: RUN_ID,
  derivedFromMessageId: MESSAGE_ID,
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

describe("draftEvalCaseFromFeedback", () => {
  it("posts draft_eval_case_from_feedback_v1 with snake_case p_body and org from TenantContext", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify(CASE_ID), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await draftEvalCaseFromFeedback(CTX, TOKEN, BASE_PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, caseId: CASE_ID });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/rpc\/draft_eval_case_from_feedback_v1$/);
    const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.p_organisation_id).toBe(ORG);
    expect(body.p_organisation_id).not.toBe(OTHER_ORG);
    expect(body.p_body).toEqual({
      expert_key: "uav-expert",
      question: "Synthetic pilot question used only for feedback-draft unit tests.",
      data_class: "client_confidential",
      rating: "incorrect",
      derived_from_run_id: RUN_ID,
      derived_from_message_id: MESSAGE_ID,
    });
    expect(Object.keys(body).sort()).toEqual(["p_body", "p_organisation_id"]);
  });

  it("forwards optional case_type and payload when provided", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify(CASE_ID), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await draftEvalCaseFromFeedback(
      CTX,
      TOKEN,
      {
        ...BASE_PAYLOAD,
        rating: "suggest_correction",
        caseType: "must_refuse",
        payload: { note: "synthetic" },
      },
      { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    expect(outcome.ok).toBe(true);
    const body = JSON.parse(sent[0]?.body ?? "{}") as {
      p_body: Record<string, unknown>;
    };
    expect(body.p_body.rating).toBe("suggest_correction");
    expect(body.p_body.case_type).toBe("must_refuse");
    expect(body.p_body.payload).toEqual({ note: "synthetic" });
  });

  it("maps tenant rpc failure to a safe employee message", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ code: "42501", message: "permission denied" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await draftEvalCaseFromFeedback(CTX, TOKEN, BASE_PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("tenancy");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.tenancy);
    expect(outcome.employeeMessage).not.toMatch(/postgres|sqlstate|28000|organization/i);
  });

  it("treats a non-uuid RPC payload as backend_failure", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ id: CASE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await draftEvalCaseFromFeedback(CTX, TOKEN, BASE_PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });

  it("treats an empty-string RPC payload as backend_failure", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify(""), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await draftEvalCaseFromFeedback(CTX, TOKEN, BASE_PAYLOAD, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });
});
