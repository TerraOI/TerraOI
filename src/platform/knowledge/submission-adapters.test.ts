import { describe, expect, it } from "vitest";

import { cookieName } from "@/platform/identity/cookie";
import {
  SESSION_COOKIE_BASE,
  issueSession,
} from "@/platform/identity/session";
import {
  createTokenCipher,
  type SessionStore,
  type StoredSession,
  type TokenCipher,
} from "@/platform/identity/session-store";

import {
  submissionDeps,
  submissionDepsForRequest,
  type SubmissionIdentityPorts,
} from "./submission-adapters";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "00000000-0000-4000-8000-0000000000a1";
const HOST = "company1.terraoi.app";
const NOW = 1_800_000_000;
const TOKEN_KEY = "synthetic-session-token-key-32b!!!!";
const ACCESS = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhY2Nlc3MifQ.sig";
const REFRESH = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJyZWZyZXNoIn0.sig";
const SUPABASE_URL = "https://example.supabase.co";

function memoryStore(): SessionStore & { rows: Map<string, StoredSession> } {
  const rows = new Map<string, StoredSession>();
  return {
    rows,
    async insert({ sessionKey, session }) {
      rows.set(sessionKey, session);
    },
    async find({ sessionKey }) {
      return rows.get(sessionKey) ?? null;
    },
    async revoke(sessionKey, at) {
      const row = rows.get(sessionKey);
      if (row) rows.set(sessionKey, { ...row, revokedAt: at });
    },
    async replaceTokens(sessionKey, replacement) {
      const row = rows.get(sessionKey);
      if (!row || row.revokedAt !== null) return false;
      rows.set(sessionKey, { ...row, ...replacement });
      return true;
    },
  };
}

function cipher(): TokenCipher {
  return createTokenCipher({ currentVersion: "v1", keys: { v1: TOKEN_KEY } });
}

function ports(store: SessionStore, overrides?: Partial<SubmissionIdentityPorts>): SubmissionIdentityPorts {
  return {
    sessionStore: () => store,
    tokenCipher: () => cipher(),
    now: () => NOW,
    findHost: async (host) =>
      host === HOST
        ? { organisationId: ORG, organisationStatus: "active" as const }
        : null,
    findMembership: async () => ({
      membershipId: "55555555-5555-4555-8555-555555555555",
      status: "active" as const,
      roles: ["member"],
      permittedServiceKeys: [],
      permittedProjectIds: [],
    }),
    policyRevision: async () => 1,
    ...overrides,
  };
}

function request(cookieHeader?: string): Request {
  return new Request(`https://${HOST}/api/knowledge/submissions`, {
    method: "POST",
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

describe("submissionDeps / submissionDepsForRequest", () => {
  it("unbound: empty env returns null (503 seam)", async () => {
    expect(submissionDeps({})).toBeNull();
    expect(await submissionDepsForRequest(request(), {})).toBeNull();
  });

  it("unbound: URL without session store / cipher returns null", async () => {
    expect(
      await submissionDepsForRequest(request(), {
        SUPABASE_URL,
        SESSION_TOKEN_KEY: TOKEN_KEY,
        // no SESSION_DB → buildIdentityPorts.sessionStore() is null
      }),
    ).toBeNull();
  });

  it("bound without session: deps resolve to no_session, not null", async () => {
    const store = memoryStore();
    const deps = await submissionDepsForRequest(
      request(),
      { SUPABASE_URL },
      {},
      ports(store),
    );
    expect(deps).not.toBeNull();
    expect(await deps!.resolveContext(request())).toEqual({ ok: false, reason: "no_session" });
    expect(await deps!.accessToken(request())).toBeNull();
  });

  it("bound with opaque session: seals TenantContext and access token", async () => {
    const store = memoryStore();
    const issued = await issueSession({
      userId: USER,
      host: HOST,
      now: NOW,
      secureTransport: true,
      store,
      cipher: cipher(),
      tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 3600 },
    });
    const cookieHeader = `${cookieName(SESSION_COOKIE_BASE, true)}=${issued.sessionId}`;
    const deps = await submissionDepsForRequest(
      request(cookieHeader),
      { SUPABASE_URL },
      {},
      ports(store),
    );
    expect(deps).not.toBeNull();
    const resolution = await deps!.resolveContext(request(cookieHeader));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok");
    expect(resolution.context.organisationId).toBe(ORG);
    expect(resolution.context.userId).toBe(USER);
    expect(await deps!.accessToken(request(cookieHeader))).toBe(ACCESS);
    expect(deps!.client).toBeDefined();
  });
});
