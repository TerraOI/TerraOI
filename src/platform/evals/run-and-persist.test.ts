import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import {
  answered,
  fakeAdapter,
  FULL_COMPOSE_CHAIN,
  recordingMeter,
  registryOf,
  RUN_ID,
  syntheticContext,
  testConfiguration,
} from "@/platform/gateway/gateway-fixtures";
import { CircuitBook } from "@/platform/gateway/circuit";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import type { EvalCase } from "@/contracts/eval-case";

import { runExpertEvalAndPersist } from "./run-and-persist";

const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "0f9fd6dd-0f0a-4b02-9b45-2fda5e6d1e01";
const TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjE4MDAwMDM2MDB9.c2ln";

function approvedFixture(): EvalCase {
  return {
    schemaVersion: 1,
    caseId: "UAV-E001",
    expertKey: "uav-expert",
    status: "approved",
    origin: "expert_written",
    caseType: "answerable",
    question: "Persisted eval question.",
    expectedAnswerPoints: ["Mentions persistence."],
    expectedClaimTypes: ["source_fact"],
    expectedAnswerStatus: "answered",
    citationRequired: false,
    dataClass: "internal",
    projectScope: null,
    forbiddenClaims: [],
    isolationBait: false,
    adversarialClass: null,
    expectedSource: "SYNTH-UAV-MAN-A17 page:1",
    expectedFixtures: ["SYNTH-UAV-MAN-A17"],
    expectedEvidence: [],
    approvedBy: "00000000-0000-4000-8000-0000000000a2",
    approvedAt: "2026-11-21T12:00:00.000Z",
    draftedBy: "builder-agent",
    draftedOn: "2026-11-21",
  };
}

describe("runExpertEvalAndPersist", () => {
  it("runs gateway scoring then persists via record_eval_run_v1", async () => {
    const adapter = fakeAdapter("local_box", [answered('{"status":"answered"}', "box")]);
    const meter = recordingMeter();
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });

    const sent: string[] = [];
    const fetchImpl: FetchImpl = async (_url, init) => {
      sent.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await runExpertEvalAndPersist({
      context: syntheticContext({ organisationId: ORG }),
      accessToken: TOKEN,
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig: { compose: FULL_COMPOSE_CHAIN },
      corpusGeneration: "gen-persist",
      cases: [approvedFixture()],
      caseIdToUuid: { "UAV-E001": CASE_A },
      evalRunId: RUN_ID,
      gatewayDeps: {
        config: testConfiguration(),
        adapters: registryOf(adapter),
        health: book,
        meter,
      },
      recordDeps: { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.results[0]?.score).toBe(1);
    expect(result.persist.ok).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0] ?? "{}") as { p_results: { case_id: string }[] };
    expect(body.p_results[0]?.case_id).toBe(CASE_A);
  });

  it("does not dial PostgREST when the uuid map is incomplete", async () => {
    const adapter = fakeAdapter("local_box", [answered('{"status":"answered"}', "box")]);
    const book = new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 });
    let dialed = false;
    const fetchImpl: FetchImpl = async () => {
      dialed = true;
      return new Response("{}", { status: 500 });
    };

    const result = await runExpertEvalAndPersist({
      context: createTenantContext({
        organisationId: ORG,
        host: "company1.terraoi.app",
        userId: "6f0a1e6a-8f4a-4b57-9e30-1d6b9a0e4a11",
        membershipId: "b1d1e0a6-1a5c-4d7e-9c47-2c1e6a5b0f22",
        membershipStatus: "active",
        roles: ["member"],
        permittedServiceKeys: ["uav"],
        permittedProjectIds: [],
        policyRevision: 1,
        resolvedAt: "2026-11-05T09:00:00.000Z",
      }),
      accessToken: TOKEN,
      expertKey: "uav-expert",
      expertVersion: "1.0.0-test",
      chainConfig: {},
      corpusGeneration: "gen-a",
      cases: [approvedFixture()],
      caseIdToUuid: {},
      evalRunId: RUN_ID,
      gatewayDeps: {
        config: testConfiguration(),
        adapters: registryOf(adapter),
        health: book,
        meter: recordingMeter(),
      },
      recordDeps: { postgrestBaseUrl: "http://127.0.0.1:1", fetchImpl },
    });

    expect(result.run.results).toHaveLength(1);
    expect(result.persist.ok).toBe(false);
    expect(dialed).toBe(false);
  });
});