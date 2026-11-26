import { describe, expect, it } from "vitest";

import { EvalCase } from "@/contracts/eval-case";
import { createTenantContext } from "@/contracts/tenant-context";

import { SAFE_TENANT_RPC_MESSAGE, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import {
  exportApprovedEvalCases,
  exportedCaseToEvalCaseJson,
  type ExportedEvalCase,
} from "./export-approved-cases";

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
const APPROVER = "00000000-0000-4000-8000-0000000000a2";
const APPROVED_AT = "2026-11-21T12:00:00.000Z";
const CHUNK_SOURCE = "11111111-1111-4111-8111-111111111101";
const CHUNK_ID = "chunk-synth-uav-e001";

const PAYLOAD_BODY = {
  schemaVersion: 1,
  caseType: "answerable",
  expectedAnswerPoints: [
    "Names the three checks the manual lists and cites the source version.",
  ],
  expectedClaimTypes: ["source_fact"],
  expectedAnswerStatus: "answered",
  citationRequired: true,
  projectScope: "synth-tenant-wide",
  forbiddenClaims: ["Must not invent compliance claims."],
  isolationBait: false,
  adversarialClass: null,
  expectedSource: "SYNTH-UAV-MAN-A17 page:12 section:3.2.1",
  expectedFixtures: ["SYNTH-UAV-MAN-A17"],
  expectedEvidence: [
    {
      kind: "chunk",
      sourceVersionId: CHUNK_SOURCE,
      chunkId: CHUNK_ID,
      span: { startChar: 0, endChar: 40 },
    },
  ],
  draftedBy: "agent (T-315 draft)",
  draftedOn: "2026-11-06",
} as const;

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

function sampleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_A,
    case_key: "UAV-E001",
    expert_key: "uav-expert",
    origin: "expert_written",
    question: "What do we have to check on UAV-A17 before a training flight?",
    data_class: "internal",
    approved_by: APPROVER,
    approved_at: APPROVED_AT,
    payload: { ...PAYLOAD_BODY },
    ...overrides,
  };
}

describe("exportApprovedEvalCases", () => {
  it("parses PostgREST snake_case rows into typed exported cases", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([sampleRow()]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await exportApprovedEvalCases(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cases).toEqual([
      {
        id: CASE_A,
        caseKey: "UAV-E001",
        expertKey: "uav-expert",
        origin: "expert_written",
        question: "What do we have to check on UAV-A17 before a training flight?",
        dataClass: "internal",
        approvedBy: APPROVER,
        approvedAt: APPROVED_AT,
        payload: { ...PAYLOAD_BODY },
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/rpc\/export_approved_eval_cases_v1$/);
    const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ p_organisation_id: ORG });
    expect(body.p_organisation_id).not.toBe(OTHER_ORG);
  });

  it("returns an empty cases array when the RPC returns []", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await exportApprovedEvalCases(CTX, TOKEN, {
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

    const outcome = await exportApprovedEvalCases(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("tenancy");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.tenancy);
  });

  it("treats a non-array RPC payload as backend_failure", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ id: CASE_A }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await exportApprovedEvalCases(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });

  it("fails closed when a row payload is not a JSON object", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([sampleRow({ payload: ["not", "an", "object"] })]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await exportApprovedEvalCases(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });

  it("fails closed when approved_by is missing", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([sampleRow({ approved_by: null })]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await exportApprovedEvalCases(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
  });
});

describe("exportedCaseToEvalCaseJson", () => {
  const exported: ExportedEvalCase = {
    id: CASE_A,
    caseKey: "UAV-E001",
    expertKey: "uav-expert",
    origin: "expert_written",
    question: "What do we have to check on UAV-A17 before a training flight?",
    dataClass: "internal",
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    payload: { ...PAYLOAD_BODY },
  };

  it("maps a successful export row to EvalCase-parseable JSON in memory", () => {
    const json = exportedCaseToEvalCaseJson(exported);
    expect(json).toBeDefined();
    const parsed = EvalCase.parse(json);
    expect(parsed.caseId).toBe("UAV-E001");
    expect(parsed.status).toBe("approved");
    expect(parsed.approvedBy).toBe(APPROVER);
    expect(parsed.approvedAt).toBe(APPROVED_AT);
    expect(parsed.origin).toBe("expert_written");
  });

  it("refuses origin === pilot even if a row is present (#102)", () => {
    const json = exportedCaseToEvalCaseJson({ ...exported, origin: "pilot" });
    expect(json).toBeUndefined();
  });
});
