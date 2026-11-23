import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";
import type { TenantResolution } from "@/platform/tenancy/resolve-tenant-context";

import {
  handlePublishKnowledgeVersion,
  handleReviewDecision,
  handleRevokeSource,
  type ReviewDeps,
} from "./review-handlers";
import type { ReviewRpcClient } from "./review-rpc";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "00000000-0000-4000-8000-0000000000a1";
const VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const DECISION_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.sig";
const ORIGIN = "https://company1.terraoi.test";

function context(): TenantContext {
  return createTenantContext({
    organisationId: ORG,
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

function request(path: string, body: unknown, origin = ORIGIN): Request {
  return new Request(`https://company1.terraoi.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

function deps(overrides?: {
  resolution?: TenantResolution;
  token?: string | null;
  client?: Partial<ReviewRpcClient>;
}): ReviewDeps {
  const resolution: TenantResolution = overrides?.resolution ?? { ok: true, context: context() };
  const client: ReviewRpcClient = {
    reviewDecision: async () => ({ ok: true, id: DECISION_ID }),
    publishKnowledgeVersion: async () => ({ ok: true, id: VERSION }),
    revokeSource: async () => ({ ok: true }),
    ...overrides?.client,
  };
  return {
    resolveContext: async () => resolution,
    accessToken: async () => (overrides?.token === undefined ? TOKEN : overrides.token),
    client,
  };
}

describe("review handlers", () => {
  it("approve decision returns the decision id and never echoes a body org", async () => {
    let seenOrg: string | undefined;
    const d = deps({
      client: {
        reviewDecision: async (input) => {
          seenOrg = input.context.organisationId;
          return { ok: true, id: DECISION_ID };
        },
      },
    });
    const res = await handleReviewDecision(
      request("/api/knowledge/review/decision", {
        sourceVersionId: VERSION,
        decision: "approve",
        organisationId: "22222222-2222-4222-8222-222222222222",
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decisionId: DECISION_ID });
    expect(seenOrg).toBe(ORG);
  });

  it("refuses origin mismatch, missing session, and invalid bodies", async () => {
    const d = deps();
    const badOrigin = await handleReviewDecision(
      request("/api/knowledge/review/decision", { sourceVersionId: VERSION, decision: "approve" }, "https://evil.test"),
      d,
    );
    expect(badOrigin.status).toBe(403);
    expect((await badOrigin.json()).error.code).toBe("origin_mismatch");

    const noSession = await handlePublishKnowledgeVersion(
      request("/api/knowledge/review/publish", { sourceVersionId: VERSION }),
      deps({ resolution: { ok: false, reason: "no_session" } }),
    );
    expect(noSession.status).toBe(401);

    const invalid = await handleRevokeSource(
      request("/api/knowledge/review/revoke", { sourceId: "nope" }),
      d,
    );
    expect(invalid.status).toBe(400);
  });

  it("maps RPC tenancy refusal to a safe 403 and publish/revoke succeed", async () => {
    const tenancy = await handleReviewDecision(
      request("/api/knowledge/review/decision", { sourceVersionId: VERSION, decision: "reject" }),
      deps({
        client: {
          reviewDecision: async () => ({
            ok: false,
            kind: "tenancy",
            message: "You do not have permission to perform this action in this workspace.",
          }),
        },
      }),
    );
    expect(tenancy.status).toBe(403);
    const tenancyBody = await tenancy.json();
    expect(tenancyBody.error.code).toBe("tenancy");
    expect(JSON.stringify(tenancyBody)).not.toContain("42501");

    const published = await handlePublishKnowledgeVersion(
      request("/api/knowledge/review/publish", { sourceVersionId: VERSION }),
      deps(),
    );
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ sourceVersionId: VERSION });

    const revoked = await handleRevokeSource(
      request("/api/knowledge/review/revoke", { sourceId: SOURCE, reason: "stale" }),
      deps(),
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });
  });
});
