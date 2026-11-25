import { describe, expect, it } from "vitest";

import { issueCsrfToken } from "@/platform/identity/csrf";
import { issueSession } from "@/platform/identity/session";
import { createTokenCipher, type SessionStore, type StoredSession } from "@/platform/identity/session-store";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import { buildEvalCaseView, buildEvalReviewListView, handleEvalDecision, type EvalReviewPorts } from "./review-service";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-0000000000" } };
const HOST = "company1.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "00000000-0000-4000-8000-0000000000a2";
const LEFT = "00000000-0000-4000-8000-0000000000a3";
const CASE_ID = "e3030000-0000-4000-8000-000000000001";
const tokenFor = (userId: string) => `synthetic-access-token-for-${userId}`;

function memoryStore(): SessionStore {
  const rows = new Map<string, StoredSession>();
  return {
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
    async replaceTokens() {
      return false;
    },
  };
}

const caseRow = {
  id: CASE_ID,
  case_key: "UAV-D001",
  expert_key: "uav-expert",
  status: "drafted",
  origin: "agent_drafted",
  case_type: "answerable",
  question: "Synthetic question?",
  data_class: "public",
  payload: { expectedAnswerPoints: ["Point."], expectedSource: "SYNTH-UAV-0001 sourceVersionId:71000000-0000-4000-8000-000000000001" },
  approved_by: null,
  approved_at: null,
  updated_at: "2026-11-25T10:00:00+00:00",
  author_is_caller: false,
  sources_valid: true,
  last_decision: null,
  last_decided_at: null,
};

function setup(answer: (rpc: string, body: Record<string, unknown>) => Response) {
  const store = memoryStore();
  const calls: { rpc: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const rpc = url.split("/rpc/")[1] ?? "";
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    calls.push({ rpc, body, auth: headers.get("authorization") });
    return answer(rpc, body);
  };
  const ports: EvalReviewPorts = {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => store,
    tokenCipher: () => createTokenCipher(CIPHER),
    findHost: async (host) => (host === HOST ? { organisationId: C1, organisationStatus: "active" } : null),
    findMembership: async (organisationId, accessToken) =>
      organisationId === C1 && accessToken === tokenFor(REVIEWER)
        ? { membershipId: "55555555-5555-4555-8555-555555555555", status: "active", roles: ["member"], permittedServiceKeys: [], permittedProjectIds: [] }
        : organisationId === C1 && accessToken === tokenFor(LEFT)
          ? { membershipId: "55555555-5555-4555-8555-555555555556", status: "suspended", roles: [], permittedServiceKeys: [], permittedProjectIds: [] }
          : null,
    policyRevision: async () => 1,
    review: { postgrestBaseUrl: "https://db.example.test/rest/v1", fetchImpl },
  };
  return { store, ports, calls };
}

async function cookieFor(store: SessionStore, userId: string) {
  const session = await issueSession({
    userId,
    host: HOST,
    now: NOW,
    secureTransport: true,
    store,
    cipher: createTokenCipher(CIPHER),
    tokens: { accessToken: tokenFor(userId), refreshToken: "synthetic-refresh-token", expiresAt: NOW + 3600 },
  });
  return `${session.cookie.name}=${session.cookie.value}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function post(cookie: string, body: unknown, origin = `https://${HOST}`) {
  return new Request(`https://${HOST}/evals/decide`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("buildEvalReviewListView (T-303)", () => {
  it("lists the queue with the tenant from the host and the user's own token", async () => {
    const { store, ports, calls } = setup(() => json([caseRow]));
    const cookie = await cookieFor(store, REVIEWER);
    const view = await buildEvalReviewListView({
      request: new Request(`https://${HOST}/evals`, { headers: { cookie } }),
      ports,
      status: "drafted",
    });
    expect(view.kind).toBe("ready");
    expect(calls[0]).toEqual({
      rpc: "list_eval_review_queue_v1",
      body: { p_status: "drafted", p_organisation_id: C1 },
      auth: `Bearer ${tokenFor(REVIEWER)}`,
    });
  });

  it("redirects a signed-out visitor and never dials the database", async () => {
    const { ports, calls } = setup(() => json([caseRow]));
    const view = await buildEvalReviewListView({ request: new Request(`https://${HOST}/evals`), ports, status: null });
    expect(view).toEqual({ kind: "redirect", location: "/login" });
    expect(calls).toHaveLength(0);
  });

  it("gives a suspended membership nothing", async () => {
    const { store, ports, calls } = setup(() => json([caseRow]));
    const cookie = await cookieFor(store, LEFT);
    const view = await buildEvalReviewListView({
      request: new Request(`https://${HOST}/evals`, { headers: { cookie } }),
      ports,
      status: null,
    });
    expect(view.kind).toBe("no_access");
    expect(calls).toHaveLength(0);
  });
});

describe("buildEvalCaseView (T-303)", () => {
  it("answers missing for a hidden or foreign case id, with no detail", async () => {
    const { store, ports } = setup(() => json([]));
    const cookie = await cookieFor(store, REVIEWER);
    const view = await buildEvalCaseView({
      request: new Request(`https://${HOST}/evals/${CASE_ID}`, { headers: { cookie } }),
      ports,
      caseId: CASE_ID,
    });
    expect(view).toEqual({ kind: "missing", message: "This case is not available to you." });
  });

  it("returns the case with a CSRF token bound to this host", async () => {
    const { store, ports } = setup(() => json([caseRow]));
    const cookie = await cookieFor(store, REVIEWER);
    const view = await buildEvalCaseView({
      request: new Request(`https://${HOST}/evals/${CASE_ID}`, { headers: { cookie } }),
      ports,
      caseId: CASE_ID,
    });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.case.expectedAnswerPoints).toEqual(["Point."]);
      expect(view.csrfToken.length).toBeGreaterThan(10);
    }
  });
});

describe("handleEvalDecision (T-303)", () => {
  async function csrf() {
    return issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
  }

  it("approves with the version token and returns the new one", async () => {
    const { store, ports, calls } = setup(() => json("2026-11-25T10:05:00+00:00"));
    const cookie = await cookieFor(store, REVIEWER);
    const response = await handleEvalDecision({
      request: await post(cookie, { csrfToken: await csrf(), caseId: CASE_ID, decision: "approve", expectedUpdatedAt: caseRow.updated_at }),
      ports,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, updatedAt: "2026-11-25T10:05:00+00:00" });
    expect(calls[0]?.body).toEqual({
      p_case_id: CASE_ID,
      p_decision: "approve",
      p_edits: {},
      p_expected_updated_at: caseRow.updated_at,
      p_organisation_id: C1,
    });
  });

  it.each([
    ["a forged reviewer", { reviewerId: REVIEWER }],
    ["a forged organisation", { organisationId: C1 }],
    ["a forged approval time", { approvedAt: "2026-01-01T00:00:00Z" }],
  ])("refuses %s in the body as a validation error without dialling the RPC", async (_label, extra) => {
    const { store, ports, calls } = setup(() => json("2026-11-25T10:05:00+00:00"));
    const cookie = await cookieFor(store, REVIEWER);
    const response = await handleEvalDecision({
      request: await post(cookie, { csrfToken: await csrf(), caseId: CASE_ID, decision: "approve", expectedUpdatedAt: caseRow.updated_at, ...extra }),
      ports,
    });
    expect(response.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("refuses an edit with an unknown case type or an empty answer point before the database", async () => {
    const { store, ports, calls } = setup(() => json("2026-11-25T10:05:00+00:00"));
    const cookie = await cookieFor(store, REVIEWER);
    for (const edits of [{ caseType: "trivia" }, { expectedAnswerPoints: [""] }, {}]) {
      const response = await handleEvalDecision({
        request: await post(cookie, { csrfToken: await csrf(), caseId: CASE_ID, decision: "edit", expectedUpdatedAt: caseRow.updated_at, edits }),
        ports,
      });
      expect(response.status).toBe(422);
    }
    expect(calls).toHaveLength(0);
  });

  it("reports a stale read as 409 conflict and a revoked source as 409 source_invalid", async () => {
    for (const [code, expected] of [["40001", "conflict"], ["55000", "source_invalid"]] as const) {
      const { store, ports } = setup(() => json({ code, message: "raw" }, 500));
      const cookie = await cookieFor(store, REVIEWER);
      const response = await handleEvalDecision({
        request: await post(cookie, { csrfToken: await csrf(), caseId: CASE_ID, decision: "approve", expectedUpdatedAt: caseRow.updated_at }),
        ports,
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe(expected);
      expect(body.message).not.toContain("raw");
    }
  });

  it("refuses a cross-site origin and a bad CSRF token", async () => {
    const { store, ports, calls } = setup(() => json("x"));
    const cookie = await cookieFor(store, REVIEWER);
    const crossSite = await handleEvalDecision({
      request: await post(cookie, { csrfToken: await csrf(), caseId: CASE_ID, decision: "reject", expectedUpdatedAt: "t" }, "https://company2.terraoi.app"),
      ports,
    });
    expect(crossSite.status).toBe(403);
    const badCsrf = await handleEvalDecision({
      request: await post(cookie, { csrfToken: "forged", caseId: CASE_ID, decision: "reject", expectedUpdatedAt: "t" }),
      ports,
    });
    expect(badCsrf.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects GET", async () => {
    const { ports } = setup(() => json("x"));
    const response = await handleEvalDecision({ request: new Request(`https://${HOST}/evals/decide`), ports });
    expect(response.status).toBe(405);
  });
});

