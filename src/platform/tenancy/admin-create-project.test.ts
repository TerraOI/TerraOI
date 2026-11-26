import { describe, expect, it, vi } from "vitest";

import { issueCsrfToken } from "@/platform/identity/csrf";
import { SESSION_COOKIE_BASE, issueSession } from "@/platform/identity/session";
import { cookieName } from "@/platform/identity/cookie";
import {
  createTokenCipher,
  type SessionStore,
  type StoredSession,
} from "@/platform/identity/session-store";

import type { AdminRpcClient } from "./admin-rpc";
import { handleCreateProject, type AdminPorts } from "./admin-service";

// Supervisor round 1 on #233: every guard on POST /admin/projects/create (origin, content type,
// CSRF, strict body, RPC failure mapping) is exercised on an authenticated request, so removing one
// fails a test. Synthetic ids, keys and tokens only.

const HOST = "company1.terraoi.app";
const ORG = "00000000-0000-4000-8000-0000000000c1";
const USER = "00000000-0000-4000-8000-0000000000a1";
const NOW = 1_800_000_000;
const SECRET = "synthetic-signing-secret-0123456789abcdef";
const CIPHER = createTokenCipher({
  currentVersion: "v1",
  keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000000" },
});

function fakeJwt(subject: string): string {
  const b64 = (value: string) =>
    Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"none"}')}.${b64(JSON.stringify({ sub: subject }))}.c2ln`;
}

function memoryStore(): SessionStore {
  const rows = new Map<string, StoredSession>();
  return {
    async insert({ sessionKey, session }) {
      rows.set(sessionKey, session);
    },
    async find({ sessionKey }) {
      return rows.get(sessionKey) ?? null;
    },
    async revoke() {},
    async replaceTokens() {
      return false;
    },
  };
}

type CreateProject = AdminRpcClient["createProject"];

async function harness(
  createProject: CreateProject = vi.fn<CreateProject>(async () => ({
    ok: true,
    id: ORG,
  })),
) {
  const store = memoryStore();
  const issued = await issueSession({
    userId: USER,
    host: HOST,
    now: NOW,
    secureTransport: true,
    store,
    cipher: CIPHER,
    tokens: {
      accessToken: fakeJwt("access"),
      refreshToken: fakeJwt("refresh"),
      expiresAt: NOW + 3600,
    },
  });
  const ports: AdminPorts = {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => store,
    tokenCipher: () => CIPHER,
    findHost: async (host) =>
      host === HOST
        ? { organisationId: ORG, organisationStatus: "active" }
        : null,
    findMembership: async () => ({
      membershipId: "00000000-0000-4000-8000-0000000000b1",
      status: "active",
      roles: ["tenant_admin"],
      permittedServiceKeys: [],
      permittedProjectIds: [],
    }),
    policyRevision: async () => 1,
    adminRpc: {
      grantMembershipRole: vi.fn(),
      revokeMembershipRole: vi.fn(),
      createProject,
      addProjectMember: vi.fn(),
      removeProjectMember: vi.fn(),
      createCollection: vi.fn(),
    } as unknown as AdminRpcClient,
  };
  const csrfToken = await issueCsrfToken({
    host: HOST,
    secret: SECRET,
    now: NOW,
  });
  const cookie = `${cookieName(SESSION_COOKIE_BASE, true)}=${issued.sessionId}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleCreateProject({
      request: new Request(`https://${HOST}/admin/projects/create`, {
        method: "POST",
        headers: {
          cookie,
          origin: `https://${HOST}`,
          "content-type": "application/json",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      ports,
    });
  return { post, csrfToken, createProject };
}

const BODY = {
  key: "site-alpha",
  name: "Site Alpha",
  visibility: "organisation",
} as const;

describe("POST /admin/projects/create guards (T-202 PR-2b)", () => {
  it("creates a project in the host's organisation, never one named by the body", async () => {
    const h = await harness();
    const response = await h.post({ ...BODY, csrfToken: h.csrfToken });
    expect(response.status).toBe(201);
    expect(h.createProject).toHaveBeenCalledOnce();
    const call = vi.mocked(h.createProject).mock.calls[0]?.[0];
    expect(call?.context.organisationId).toBe(ORG);
    expect(call).toMatchObject({
      key: "site-alpha",
      name: "Site Alpha",
      visibility: "organisation",
    });
  });

  it("refuses a body that names an organisation (strict schema)", async () => {
    const h = await harness();
    const response = await h.post({
      ...BODY,
      csrfToken: h.csrfToken,
      organisationId: ORG,
    });
    expect(response.status).toBe(400);
    expect(h.createProject).not.toHaveBeenCalled();
  });

  it("refuses a missing or foreign Origin", async () => {
    const h = await harness();
    for (const origin of ["https://company2.terraoi.app", "null"]) {
      const response = await h.post(
        { ...BODY, csrfToken: h.csrfToken },
        { origin },
      );
      expect(response.status).toBe(403);
    }
    expect(h.createProject).not.toHaveBeenCalled();
  });

  it("refuses a forged or other-host CSRF token", async () => {
    const h = await harness();
    const otherHost = await issueCsrfToken({
      host: "company2.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    for (const csrfToken of ["forged", otherHost]) {
      const response = await h.post({ ...BODY, csrfToken });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe(
        "csrf_invalid",
      );
    }
    expect(h.createProject).not.toHaveBeenCalled();
  });

  it("refuses a non-JSON content type and an oversized body", async () => {
    const h = await harness();
    expect(
      (
        await h.post(
          { ...BODY, csrfToken: h.csrfToken },
          { "content-type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    expect((await h.post(`{"pad":"${"x".repeat(17 * 1024)}"}`)).status).toBe(
      413,
    );
    expect(h.createProject).not.toHaveBeenCalled();
  });

  it("maps RPC failures to fixed messages and statuses", async () => {
    const createProject = vi.fn<CreateProject>(async () => ({
      ok: false,
      kind: "tenancy",
      message: "You do not have access to this workspace.",
    }));
    const h = await harness(createProject);
    const response = await h.post({ ...BODY, csrfToken: h.csrfToken });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      code: "tenancy",
      message: "You do not have access to this workspace.",
    });
  });
});
