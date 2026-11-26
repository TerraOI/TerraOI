import { describe, expect, it, vi } from "vitest";

import type { AdminPorts } from "./admin-service";
import { handleCreateProject } from "./admin-service";

function ports(createProject = vi.fn()): AdminPorts {
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
      createProject,
      addProjectMember: vi.fn(),
      removeProjectMember: vi.fn(),
      createCollection: vi.fn(),
    },
  };
}

describe("handleCreateProject (T-202 PR-2b)", () => {
  it("rejects a non-POST method without dialling the RPC", async () => {
    const createProject = vi.fn();
    const response = await handleCreateProject({
      request: new Request("https://company1.terraoi.test/admin/projects/create", { method: "GET" }),
      ports: ports(createProject),
    });
    expect(response.status).toBe(405);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("refuses when session ports are unbound (unavailable, no RPC)", async () => {
    const createProject = vi.fn();
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
      ports: ports(createProject),
      hostOptions: { developmentHost: "company1.terraoi.test" },
    });
    expect(response.status).toBe(503);
    expect(createProject).not.toHaveBeenCalled();
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unavailable");
  });
});
