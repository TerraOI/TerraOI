import { describe, expect, it, vi } from "vitest";

import type { AdminRpcClient } from "./admin-rpc";
import type { AdminPorts } from "./admin-service";
import {
  handleCreateCollection,
  handleCreateProject,
  handleInviteMember,
  handleMembershipRoleAction,
} from "./admin-service";

function ports(
  overrides: Partial<Pick<AdminRpcClient, "createProject" | "createCollection" | "inviteMember">> = {},
): AdminPorts {
  return {
    now: () => 1_700_000_000,
    signingSecret: () => "a".repeat(32),
    sessionStore: () => null,
    tokenCipher: () => null,
    findHost: async () => null,
    findMembership: async () => null,
    policyRevision: async () => 1,
    adminRpc: {
      grantMembershipRole: vi.fn(),
      revokeMembershipRole: vi.fn(),
      inviteMember: overrides.inviteMember ?? vi.fn(),
      createProject: overrides.createProject ?? vi.fn(),
      addProjectMember: vi.fn(),
      removeProjectMember: vi.fn(),
      createCollection: overrides.createCollection ?? vi.fn(),
    },
  };
}

describe("handleCreateProject (T-202 PR-2b)", () => {
  it("rejects a non-POST method without dialling the RPC", async () => {
    const createProject = vi.fn<AdminRpcClient["createProject"]>();
    const response = await handleCreateProject({
      request: new Request("https://company1.terraoi.test/admin/projects/create", { method: "GET" }),
      ports: ports({ createProject }),
    });
    expect(response.status).toBe(405);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("refuses when session ports are unbound (unavailable, no RPC)", async () => {
    const createProject = vi.fn<AdminRpcClient["createProject"]>();
    const response = await handleCreateProject({
      request: new Request("https://company1.terraoi.test/admin/projects/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://company1.terraoi.test",
        },
        body: JSON.stringify({
          csrfToken: "x",
          key: "site-alpha",
          name: "Site Alpha",
          visibility: "organisation",
        }),
      }),
      ports: ports({ createProject }),
      hostOptions: { developmentHost: "company1.terraoi.test" },
    });
    expect(response.status).toBe(503);
    expect(createProject).not.toHaveBeenCalled();
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unavailable");
  });
});

describe("handleCreateCollection (T-202 PR-2c)", () => {
  it("rejects a non-POST method without dialling create_collection_v1", async () => {
    const createCollection = vi.fn<AdminRpcClient["createCollection"]>();
    const response = await handleCreateCollection({
      request: new Request("https://company1.terraoi.test/admin/collections/create", { method: "GET" }),
      ports: ports({ createCollection }),
    });
    expect(response.status).toBe(405);
    expect(createCollection).not.toHaveBeenCalled();
  });
});

describe("handleMembershipRoleAction (T-202 PR-2e)", () => {
  it("rejects a non-POST method without dialling grant or revoke", async () => {
    const grantMembershipRole = vi.fn<AdminRpcClient["grantMembershipRole"]>();
    const revokeMembershipRole = vi.fn<AdminRpcClient["revokeMembershipRole"]>();
    const response = await handleMembershipRoleAction({
      request: new Request("https://company1.terraoi.test/admin/members/role", { method: "GET" }),
      ports: {
        ...ports(),
        adminRpc: {
          ...ports().adminRpc,
          grantMembershipRole,
          revokeMembershipRole,
        },
      },
    });
    expect(response.status).toBe(405);
    expect(grantMembershipRole).not.toHaveBeenCalled();
    expect(revokeMembershipRole).not.toHaveBeenCalled();
  });
});

describe("handleInviteMember (T-202 PR-2f)", () => {
  it("rejects a non-POST method without dialling invite_member_v1", async () => {
    const inviteMember = vi.fn<AdminRpcClient["inviteMember"]>();
    const response = await handleInviteMember({
      request: new Request("https://company1.terraoi.test/admin/members/invite", { method: "GET" }),
      ports: ports({ inviteMember }),
    });
    expect(response.status).toBe(405);
    expect(inviteMember).not.toHaveBeenCalled();
  });
});
