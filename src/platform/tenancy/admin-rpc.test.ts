import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@/contracts/tenant-context";

import { createAdminRpcClient, SAFE_ADMIN_RPC_MESSAGE } from "./admin-rpc";
import type { FetchImpl } from "./tenant-rpc";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER = "00000000-0000-4000-8000-0000000000a1";
const ROLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";

const CTX: TenantContext = {
  organisationId: ORG,
  host: "company1.terraoi.test",
  userId: USER,
  membershipId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  membershipStatus: "active",
  roles: ["admin"],
  permittedServiceKeys: ["uav", "gpr"],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-21T20:00:00.000Z",
};

function recordingFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): {
  fetchImpl: FetchImpl;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function okResponse(data: unknown = null): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(code: string, status = 400): Response {
  return new Response(JSON.stringify({ code, message: "hidden detail" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createAdminRpcClient (T-202)", () => {
  it("injects p_organisation_id from TenantContext and never from caller fields", async () => {
    const { fetchImpl, calls } = recordingFetch(async () => okResponse());
    const client = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl,
    });
    await client.grantMembershipRole({
      context: CTX,
      accessToken: TOKEN,
      userId: USER,
      roleId: ROLE,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/rpc/grant_membership_role_v1");
    expect(calls[0]?.body.p_organisation_id).toBe(ORG);
    expect(calls[0]?.body.p_user_id).toBe(USER);
    expect(calls[0]?.body.p_role_id).toBe(ROLE);
    expect(JSON.stringify(calls[0]?.body)).not.toContain(ORG_B);
  });

  it("refuses invalid uuids before dialling", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const client = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl,
    });
    const outcome = await client.revokeMembershipRole({
      context: CTX,
      accessToken: TOKEN,
      userId: "not-a-uuid",
      roleId: ROLE,
    });
    expect(outcome).toEqual({
      ok: false,
      kind: "validation",
      message: SAFE_ADMIN_RPC_MESSAGE.validation,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("createProject returns the new id and validates key/visibility", async () => {
    const { fetchImpl, calls } = recordingFetch(async () => okResponse(PROJECT));
    const client = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl,
    });
    await expect(
      client.createProject({
        context: CTX,
        accessToken: TOKEN,
        key: "alpha-1",
        name: "Alpha",
        visibility: "organisation",
      }),
    ).resolves.toEqual({ ok: true, id: PROJECT });
    expect(calls[0]?.url).toContain("/rpc/create_project_v1");
    expect(calls[0]?.body).toMatchObject({
      p_key: "alpha-1",
      p_name: "Alpha",
      p_visibility: "organisation",
      p_organisation_id: ORG,
    });

    const bad = await client.createProject({
      context: CTX,
      accessToken: TOKEN,
      key: "BAD KEY",
      name: "Alpha",
      visibility: "organisation",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("validation");
  });

  it("maps 42501 to tenancy and 23514 to last_admin copy", async () => {
    const denied = recordingFetch(async () => errorResponse("42501"));
    const lastAdmin = recordingFetch(async () => errorResponse("23514"));
    const deniedClient = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl: denied.fetchImpl,
    });
    const lastAdminClient = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl: lastAdmin.fetchImpl,
    });

    await expect(
      deniedClient.addProjectMember({
        context: CTX,
        accessToken: TOKEN,
        projectId: PROJECT,
        userId: USER,
      }),
    ).resolves.toEqual({
      ok: false,
      kind: "tenancy",
      message: SAFE_ADMIN_RPC_MESSAGE.tenancy,
    });

    await expect(
      lastAdminClient.revokeMembershipRole({
        context: CTX,
        accessToken: TOKEN,
        userId: USER,
        roleId: ROLE,
      }),
    ).resolves.toEqual({
      ok: false,
      kind: "last_admin",
      message: SAFE_ADMIN_RPC_MESSAGE.last_admin,
    });
  });

  it("reads 23514 as last-admin only for revoke: elsewhere it is an ordinary refused value", async () => {
    const check = recordingFetch(async () => errorResponse("23514"));
    const client = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl: check.fetchImpl,
    });
    const project = await client.createProject({
      context: CTX,
      accessToken: TOKEN,
      key: "site-z",
      name: "Site Z",
      visibility: "project",
    });
    const collection = await client.createCollection({
      context: CTX,
      accessToken: TOKEN,
      key: "site-z-docs",
      name: "Site Z documents",
      service: "uav",
      dataClass: "internal",
      projectId: null,
    });
    for (const outcome of [project, collection]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.kind).not.toBe("last_admin");
      expect(outcome.kind).toBe("validation");
    }
  });

  it("maps 22023 from a grant to a suspended or removed member as target_inactive", async () => {
    const inactive = recordingFetch(async () => errorResponse("22023"));
    const client = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl: inactive.fetchImpl,
    });
    await expect(
      client.grantMembershipRole({ context: CTX, accessToken: TOKEN, userId: USER, roleId: ROLE }),
    ).resolves.toEqual({
      ok: false,
      kind: "target_inactive",
      message: SAFE_ADMIN_RPC_MESSAGE.target_inactive,
    });
  });

  it("createCollection refuses client_confidential without a project before dialling", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const client = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl,
    });
    const outcome = await client.createCollection({
      context: CTX,
      accessToken: TOKEN,
      key: "gpr-notes",
      name: "GPR notes",
      service: "gpr",
      dataClass: "client_confidential",
      projectId: null,
    });
    expect(outcome).toEqual({
      ok: false,
      kind: "validation",
      message: "A client-confidential collection must belong to a project.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("createCollection dials create_collection_v1 with T-111b argument names", async () => {
    const { fetchImpl, calls } = recordingFetch(async () => okResponse(PROJECT));
    const client = createAdminRpcClient({
      postgrestBaseUrl: "https://db.example/rest/v1",
      fetchImpl,
    });
    await expect(
      client.createCollection({
        context: CTX,
        accessToken: TOKEN,
        key: "uav-ops",
        name: "UAV ops",
        service: "uav",
        dataClass: "internal",
        projectId: null,
      }),
    ).resolves.toEqual({ ok: true, id: PROJECT });
    expect(calls[0]?.url).toContain("/rpc/create_collection_v1");
    expect(calls[0]?.body).toMatchObject({
      p_key: "uav-ops",
      p_name: "UAV ops",
      p_service: "uav",
      p_project_id: null,
      p_data_class: "internal",
      p_organisation_id: ORG,
    });
  });
});
