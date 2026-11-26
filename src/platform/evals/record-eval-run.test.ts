import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { buildRecordEvalRunBodies, recordEvalRun } from "./record-eval-run";
import type { EvalRunRow } from "./run";

const ORG = "11111111-1111-4111-8111-111111111111";
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
const RUN_ROW: EvalRunRow = {
  expertKey: "uav-expert",
  expertVersion: "1.0.0-test",
  chainConfig: { compose: ["local_box"] },
  corpusGeneration: "gen-a",
  caseOrder: ["UAV-E001"],
  status: "completed",
  results: [
    {
      caseId: "UAV-E001",
      score: 1,
      failureClass: null,
      evidence: [],
      providerKeysUsed: ["local_box"],
    },
  ],
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

describe("buildRecordEvalRunBodies", () => {
  it("maps fixture case ids to database uuids and snake_case run fields", () => {
    const built = buildRecordEvalRunBodies(RUN_ROW, { "UAV-E001": CASE_A });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.p_run).toEqual({
      expert_key: "uav-expert",
      expert_version: "1.0.0-test",
      chain_config: { compose: ["local_box"] },
      corpus_generation: "gen-a",
      status: "completed",
    });
    expect(built.p_results).toEqual([
      {
        case_id: CASE_A,
        score: 1,
        failure_class: null,
        evidence: [],
      },
    ]);
  });

  it("refuses when a scored case has no uuid mapping", () => {
    const outcome = buildRecordEvalRunBodies(RUN_ROW, {});
    expect(outcome).toEqual({ ok: false, reason: "case_uuid_unmapped", caseId: "UAV-E001" });
  });
});

describe("recordEvalRun", () => {
  it("posts record_eval_run_v1 with org from TenantContext", async () => {
    const returnedRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { sent, fetchImpl } = transport(() =>
      new Response(JSON.stringify(returnedRunId), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await recordEvalRun(CTX, TOKEN, RUN_ROW, { "UAV-E001": CASE_A }, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, runId: returnedRunId });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/rpc\/record_eval_run_v1$/);
    const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.p_organisation_id).toBe(ORG);
    expect(body.p_run).toBeTruthy();
    expect(body.p_results).toBeTruthy();
  });

  it("returns safe failure without dialing when mapping is missing", async () => {
    const { fetchImpl } = transport(() => new Response("{}", { status: 500 }));
    const outcome = await recordEvalRun(CTX, TOKEN, RUN_ROW, {}, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("case_uuid_unmapped");
    expect(outcome.employeeMessage).not.toMatch(/UAV-E001/);
  });
});