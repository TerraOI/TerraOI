import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { createReviewRpcClient, SAFE_REVIEW_RPC_MESSAGE } from "./review-rpc";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER = "00000000-0000-4000-8000-0000000000a1";
const VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const DECISION_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
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

describe("createReviewRpcClient", () => {
  it("reviewDecision posts through withTenantRpc with context org and never a body org", async () => {
    const t = recordingFetch(200, DECISION_ID);
    const client = createReviewRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: t.fetchImpl,
    });
    const outcome = await client.reviewDecision({
      context: context(ORG_A),
      accessToken: TOKEN,
      sourceVersionId: VERSION,
      decision: "approve",
      reason: "looks good",
    });
    expect(outcome).toEqual({ ok: true, id: DECISION_ID });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toContain("/rpc/review_decision_v1");
    const body = JSON.parse(String(t.calls[0]?.init?.body));
    expect(body.p_organisation_id).toBe(ORG_A);
    expect(body.p_source_version_id).toBe(VERSION);
    expect(body.p_decision).toBe("approve");
    expect(body.p_reason).toBe("looks good");
    // A second call with a different context must not reuse the first org.
    const t2 = recordingFetch(200, DECISION_ID);
    const client2 = createReviewRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: t2.fetchImpl,
    });
    await client2.reviewDecision({
      context: context(ORG_B),
      accessToken: TOKEN,
      sourceVersionId: VERSION,
      decision: "reject",
    });
    const body2 = JSON.parse(String(t2.calls[0]?.init?.body));
    expect(body2.p_organisation_id).toBe(ORG_B);
    expect(body2.p_decision).toBe("reject");
    expect(body2.p_reason).toBeUndefined();
  });

  it("publishKnowledgeVersion and revokeSource validate ids and map tenancy refusals", async () => {
    const ok = recordingFetch(200, VERSION);
    const client = createReviewRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: ok.fetchImpl,
    });
    const published = await client.publishKnowledgeVersion({
      context: context(ORG_A),
      accessToken: TOKEN,
      sourceVersionId: VERSION,
    });
    expect(published).toEqual({ ok: true, id: VERSION });
    expect(ok.calls[0]?.url).toContain("/rpc/publish_knowledge_version_v1");

    const revoked = await client.revokeSource({
      context: context(ORG_A),
      accessToken: TOKEN,
      sourceId: SOURCE,
      reason: "wrong doc",
    });
    expect(revoked).toEqual({ ok: true });
    expect(ok.calls[1]?.url).toContain("/rpc/revoke_source_v1");
    const revokeBody = JSON.parse(String(ok.calls[1]?.init?.body));
    expect(revokeBody.p_organisation_id).toBe(ORG_A);
    expect(revokeBody.p_source_id).toBe(SOURCE);

    const bad = await client.publishKnowledgeVersion({
      context: context(ORG_A),
      accessToken: TOKEN,
      sourceVersionId: "not-a-uuid",
    });
    expect(bad).toEqual({ ok: false, kind: "validation", message: SAFE_REVIEW_RPC_MESSAGE.validation });

    const tenancy = recordingFetch(401, { code: "42501", message: "not permitted to review knowledge" });
    const clientTenancy = createReviewRpcClient({
      postgrestBaseUrl: "https://postgrest.test",
      fetchImpl: tenancy.fetchImpl,
    });
    const refused = await clientTenancy.reviewDecision({
      context: context(ORG_A),
      accessToken: TOKEN,
      sourceVersionId: VERSION,
      decision: "approve",
    });
    expect(refused).toEqual({ ok: false, kind: "tenancy", message: SAFE_REVIEW_RPC_MESSAGE.tenancy });
    expect(JSON.stringify(refused)).not.toContain("not permitted");
  });
});
