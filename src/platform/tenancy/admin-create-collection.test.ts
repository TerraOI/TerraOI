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
import { handleCreateCollection, type AdminPorts } from "./admin-service";

// Supervisor round 1 on #234: POST /admin/collections/create runs the same guard pipeline as the
// project route, exercised on an authenticated request. Synthetic ids, keys and tokens only.

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

type CreateCollection = AdminRpcClient["createCollection"];

async function harness(
  createCollection: CreateCollection = vi.fn<CreateCollection>(async () => ({
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
      createProject: vi.fn(),
      addProjectMember: vi.fn(),
      removeProjectMember: vi.fn(),
      createCollection,
    } as unknown as AdminRpcClient,
  };
  const csrfToken = await issueCsrfToken({
    host: HOST,
    secret: SECRET,
    now: NOW,
  });
  const cookie = `${cookieName(SESSION_COOKIE_BASE, true)}=${issued.sessionId}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleCreateCollection({
      request: new Request(`https://${HOST}/admin/collections/create`, {
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
  return { post, csrfToken, createCollection };
}

const PROJECT = "00000000-0000-4000-8000-0000000000d1";
const BODY = {
  key: "uav-ops",
  name: "UAV ops",
  service: "uav",
  dataClass: "internal",
  projectId: null,
} as const;

describe("POST /admin/collections/create guards (T-202 PR-2c)", () => {
  it("creates a collection in the host's organisation, never one named by the body", async () => {
    const h = await harness();
    const response = await h.post({ ...BODY, dataClass: "client_confidential", projectId: PROJECT, csrfToken: h.csrfToken });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, collectionId: ORG });
    const call = vi.mocked(h.createCollection).mock.calls[0]?.[0];
    expect(call?.context.organisationId).toBe(ORG);
    expect(call).toMatchObject({ key: "uav-ops", dataClass: "client_confidential", projectId: PROJECT });
  });

  it("refuses a body that names an organisation, or a project id that is not a UUID", async () => {
    const h = await harness();
    for (const body of [
      { ...BODY, csrfToken: h.csrfToken, organisationId: ORG },
      { ...BODY, csrfToken: h.csrfToken, projectId: "site-alpha" },
      { ...BODY, csrfToken: h.csrfToken, dataClass: "secret" },
    ]) {
      expect((await h.post(body)).status).toBe(400);
    }
    expect(h.createCollection).not.toHaveBeenCalled();
  });

  it("refuses a foreign Origin and a forged CSRF token", async () => {
    const h = await harness();
    expect((await h.post({ ...BODY, csrfToken: h.csrfToken }, { origin: "https://company2.terraoi.app" })).status).toBe(403);
    const forged = await h.post({ ...BODY, csrfToken: "forged" });
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { code: string }).code).toBe("csrf_invalid");
    expect(h.createCollection).not.toHaveBeenCalled();
  });

  it("refuses a non-JSON content type and an oversized body", async () => {
    const h = await harness();
    expect((await h.post({ ...BODY, csrfToken: h.csrfToken }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await h.post(`{"pad":"${"x".repeat(17 * 1024)}"}`)).status).toBe(413);
    expect(h.createCollection).not.toHaveBeenCalled();
  });

  it("maps a validation failure from the RPC client to 422 with its fixed message", async () => {
    const createCollection = vi.fn<CreateCollection>(async () => ({
      ok: false,
      kind: "validation",
      message: "A client-confidential collection must belong to a project.",
    }));
    const h = await harness(createCollection);
    const response = await h.post({ ...BODY, dataClass: "client_confidential", csrfToken: h.csrfToken });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      code: "validation",
      message: "A client-confidential collection must belong to a project.",
    });
  });
});
