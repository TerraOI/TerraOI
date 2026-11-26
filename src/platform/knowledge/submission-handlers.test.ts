import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";
import type { TenantResolution } from "@/platform/tenancy/resolve-tenant-context";

import {
  handleCreateSubmission,
  handleReviewSubmission,
  type SubmissionDeps,
} from "./submission-handlers";
import type { SubmissionRpcClient } from "./submission-rpc";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "00000000-0000-4000-8000-0000000000a1";
const COLLECTION = "51000000-0000-4000-8000-000000000001";
const SUBMISSION = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
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
  client?: Partial<SubmissionRpcClient>;
}): SubmissionDeps {
  const resolution: TenantResolution = overrides?.resolution ?? { ok: true, context: context() };
  const client: SubmissionRpcClient = {
    submit: async () => ({ ok: true, id: SUBMISSION }),
    review: async () => ({ ok: true, id: SUBMISSION }),
    withdraw: async () => ({ ok: true, id: SUBMISSION }),
    ...overrides?.client,
  };
  return {
    resolveContext: async () => resolution,
    accessToken: async () => (overrides?.token === undefined ? TOKEN : overrides.token),
    client,
  };
}

describe("submission handlers", () => {
  it("create returns 201 and never takes org from the body", async () => {
    let seenOrg: string | undefined;
    const d = deps({
      client: {
        submit: async (input) => {
          seenOrg = input.context.organisationId;
          return { ok: true, id: SUBMISSION };
        },
      },
    });
    const res = await handleCreateSubmission(
      request("/api/knowledge/submissions", {
        collectionId: COLLECTION,
        kind: "note",
        proposedText: "Synthetic create body.",
        contextDataClass: "public",
        organisationId: "22222222-2222-4222-8222-222222222222",
      }),
      d,
    );
    // strictObject rejects organisationId → invalid_request
    expect(res.status).toBe(400);
    expect(seenOrg).toBeUndefined();

    const ok = await handleCreateSubmission(
      request("/api/knowledge/submissions", {
        collectionId: COLLECTION,
        kind: "note",
        proposedText: "Synthetic create body.",
        contextDataClass: "public",
      }),
      d,
    );
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ submissionId: SUBMISSION });
    expect(seenOrg).toBe(ORG);
  });

  it("refuses origin mismatch and missing session; review maps tenancy", async () => {
    const badOrigin = await handleCreateSubmission(
      request(
        "/api/knowledge/submissions",
        {
          collectionId: COLLECTION,
          kind: "note",
          proposedText: "x",
          contextDataClass: "public",
        },
        "https://evil.test",
      ),
      deps(),
    );
    expect(badOrigin.status).toBe(403);

    const noSession = await handleReviewSubmission(
      request(`/api/knowledge/submissions/${SUBMISSION}/review`, { decision: "approve" }),
      deps({ resolution: { ok: false, reason: "no_session" } }),
      SUBMISSION,
    );
    expect(noSession.status).toBe(401);

    const tenancy = await handleReviewSubmission(
      request(`/api/knowledge/submissions/${SUBMISSION}/review`, { decision: "approve" }),
      deps({
        client: {
          review: async () => ({
            ok: false,
            kind: "tenancy",
            message: "You do not have permission to perform this action in this workspace.",
          }),
        },
      }),
      SUBMISSION,
    );
    expect(tenancy.status).toBe(403);
    expect((await tenancy.json()).error.code).toBe("tenancy");
  });
});
