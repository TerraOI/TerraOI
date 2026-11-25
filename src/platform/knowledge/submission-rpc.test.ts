import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { createSubmissionRpcClient, SAFE_SUBMISSION_RPC_MESSAGE } from "./submission-rpc";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER = "00000000-0000-4000-8000-0000000000a1";
const COLLECTION = "51000000-0000-4000-8000-000000000001";
const SUBMISSION = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.sig";

function context(organisationId: string): TenantContext {
  return createTenantContext({
    organisationId,
    host: "company1.terraoi.test",
    userId: USER,
    membershipId: "55555555-5555-4555-8555-555555555555",
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: [],
    permittedProjectIds: [],
    policyRevision: 1,
    resolvedAt: "2026-11-23T00:00:00.000Z",
  });
}

function recordingFetch(status: number, body: unknown): { fetchImpl: FetchImpl; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("createSubmissionRpcClient", () => {
  it("submit posts context org only and never a body org", async () => {
    const t = recordingFetch(200, SUBMISSION);
    const client = createSubmissionRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: t.fetchImpl,
    });
    const outcome = await client.submit({
      context: context(ORG_A),
      accessToken: TOKEN,
      collectionId: COLLECTION,
      kind: "note",
      proposedText: "Synthetic F15 body.",
      contextDataClass: "public",
    });
    expect(outcome).toEqual({ ok: true, id: SUBMISSION });
    expect(t.calls[0]?.url).toContain("/rpc/submit_employee_knowledge_v1");
    const body = JSON.parse(String(t.calls[0]?.init?.body));
    expect(body.p_organisation_id).toBe(ORG_A);
    expect(body.p_collection_id).toBe(COLLECTION);
    expect(body).not.toHaveProperty("organisation_id");

    const t2 = recordingFetch(200, SUBMISSION);
    await createSubmissionRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: t2.fetchImpl,
    }).submit({
      context: context(ORG_B),
      accessToken: TOKEN,
      collectionId: COLLECTION,
      kind: "answer",
      proposedText: "Other tenant body.",
      contextDataClass: "internal",
    });
    expect(JSON.parse(String(t2.calls[0]?.init?.body)).p_organisation_id).toBe(ORG_B);
  });

  it("review and withdraw map tenancy refusals without leaking SQL text", async () => {
    const ok = recordingFetch(200, SUBMISSION);
    const client = createSubmissionRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: ok.fetchImpl,
    });
    expect(
      await client.review({
        context: context(ORG_A),
        accessToken: TOKEN,
        submissionId: SUBMISSION,
        decision: "approve",
      }),
    ).toEqual({ ok: true, id: SUBMISSION });
    expect(ok.calls[0]?.url).toContain("/rpc/review_knowledge_submission_v1");

    expect(
      await client.withdraw({
        context: context(ORG_A),
        accessToken: TOKEN,
        submissionId: SUBMISSION,
      }),
    ).toEqual({ ok: true, id: SUBMISSION });
    expect(ok.calls[1]?.url).toContain("/rpc/withdraw_knowledge_submission_v1");

    const tenancy = recordingFetch(401, { code: "42501", message: "author cannot review their own submission" });
    const refused = await createSubmissionRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: tenancy.fetchImpl,
    }).review({
      context: context(ORG_A),
      accessToken: TOKEN,
      submissionId: SUBMISSION,
      decision: "approve",
    });
    expect(refused).toEqual({ ok: false, kind: "tenancy", message: SAFE_SUBMISSION_RPC_MESSAGE.tenancy });
    expect(JSON.stringify(refused)).not.toContain("author cannot");
  });
});
