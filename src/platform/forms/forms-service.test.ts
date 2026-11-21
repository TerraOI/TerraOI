import { describe, expect, it, vi } from "vitest";

import { issueCsrfToken } from "@/platform/identity/csrf";
import { issueSession } from "@/platform/identity/session";
import { createTokenCipher, type SessionStore, type StoredSession } from "@/platform/identity/session-store";

import {
  buildFormDetailView,
  buildFormsListView,
  handleFormAction,
  type FormsPorts,
} from "./forms-service";
import { findSeededTemplateForTenant, listSeededTemplatesForTenant } from "./seeded-templates";

const COMPANY1_ORG = "11111111-1111-4111-8111-111111111111";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP_ID = "99000000-0000-4000-8000-000000000001";
const UAV_TEMPLATE_ID = "80000000-0000-4000-8000-000000000001";
const GPR_TEMPLATE_ID = "80000000-0000-4000-8000-000000000003";
const SUBMISSION_ID = "aa000000-0000-4000-8000-000000000001";
const NOW = 1_763_600_000;
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN_KEY = "fedcba9876543210fedcba9876543210";

function memorySessionStore(): SessionStore {
  const rows = new Map<string, StoredSession>();
  return {
    insert: async ({ sessionKey, session }) => {
      rows.set(sessionKey, session);
    },
    find: async ({ sessionKey }) => rows.get(sessionKey) ?? null,
    revoke: async (sessionKey, now) => {
      const existing = rows.get(sessionKey);
      if (existing) rows.set(sessionKey, { ...existing, revokedAt: now });
    },
    replaceTokens: async () => true,
  };
}

async function setupFixture(overrides: Partial<FormsPorts> = {}) {
  const store = memorySessionStore();
  const cipher = createTokenCipher({ currentVersion: "v1", keys: { v1: TOKEN_KEY } });
  const issued = await issueSession({
    userId: USER_ID,
    host: "company1.terraoi.app",
    tokens: { accessToken: "supa-access-1", refreshToken: "supa-refresh-1", expiresAt: NOW + 3600 },
    store,
    cipher,
    now: NOW,
    secureTransport: true,
  });
  const cookieHeader = `${issued.cookie.name}=${issued.cookie.value}`;
  const csrfToken = await issueCsrfToken({ host: "company1.terraoi.app", secret: SIGNING_SECRET, now: NOW });

  const saveDraft = vi.fn().mockResolvedValue({ ok: true, submissionId: SUBMISSION_ID });
  const submitDraft = vi.fn().mockResolvedValue({ ok: true, submissionId: SUBMISSION_ID });
  const saveAndSubmit = vi.fn().mockResolvedValue({ ok: true, submissionId: SUBMISSION_ID });

  const ports: FormsPorts = {
    now: () => NOW,
    signingSecret: () => SIGNING_SECRET,
    sessionStore: () => store,
    tokenCipher: () => cipher,
    findHost: async (host) =>
      host === "company1.terraoi.app"
        ? { organisationId: COMPANY1_ORG, organisationStatus: "active" }
        : null,
    findMembership: async () => ({
      membershipId: MEMBERSHIP_ID,
      status: "active",
      roles: ["admin"],
      permittedServiceKeys: [],
      permittedProjectIds: [],
    }),
    policyRevision: async () => 1,
    listTemplates: async (ctx) => listSeededTemplatesForTenant(ctx),
    findTemplate: async (ctx, id) => findSeededTemplateForTenant(ctx, id),
    formsRpc: { saveDraft, submitDraft, saveAndSubmit },
    ...overrides,
  };

  return { ports, cookieHeader, csrfToken, saveDraft, submitDraft, saveAndSubmit };
}

describe("forms views (GET /forms, GET /forms/:id)", () => {
  it("lists authorized tenant templates for an active member and hides foreign templates", async () => {
    const { ports, cookieHeader } = await setupFixture();
    const listView = await buildFormsListView({
      request: new Request("https://company1.terraoi.app/forms", { headers: { cookie: cookieHeader } }),
      ports,
    });
    expect(listView.kind).toBe("ready");
    if (listView.kind === "ready") {
      expect(listView.templates.map((t) => t.id)).toEqual([UAV_TEMPLATE_ID]);
    }

    const foreignDetail = await buildFormDetailView({
      request: new Request(`https://company1.terraoi.app/forms/${GPR_TEMPLATE_ID}`, {
        headers: { cookie: cookieHeader },
      }),
      templateId: GPR_TEMPLATE_ID,
      ports,
    });
    expect(foreignDetail.kind).toBe("not_found");
  });

  it("redirects signed-out visitors to /login and refuses suspended members with no_access", async () => {
    const { ports, cookieHeader } = await setupFixture();

    const anon = await buildFormsListView({
      request: new Request("https://company1.terraoi.app/forms"),
      ports,
    });
    expect(anon.kind).toBe("redirect");

    const suspended = await buildFormsListView({
      request: new Request("https://company1.terraoi.app/forms", { headers: { cookie: cookieHeader } }),
      ports: {
        ...ports,
        findMembership: async () => ({
          membershipId: MEMBERSHIP_ID,
          status: "suspended",
          roles: [],
          permittedServiceKeys: [],
          permittedProjectIds: [],
        }),
      },
    });
    expect(suspended.kind).toBe("no_access");
  });
});

describe("handleFormAction (POST /forms/submit)", () => {
  it("rejects cross-origin posts, missing CSRF, and client-supplied organisationId", async () => {
    const { ports, cookieHeader, csrfToken, saveDraft } = await setupFixture();

    const badOrigin = await handleFormAction({
      request: new Request("https://company1.terraoi.app/forms/submit", {
        method: "POST",
        headers: {
          origin: "https://company2.terraoi.app",
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          action: "draft",
          csrfToken,
          templateId: UAV_TEMPLATE_ID,
          templateVersion: "v1",
          values: { airframe_check: "ok", battery_pct: 90, weather_notes: "clear" },
        }),
      }),
      ports,
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get("cache-control")).toBe("no-store");

    const forgedOrg = await handleFormAction({
      request: new Request("https://company1.terraoi.app/forms/submit", {
        method: "POST",
        headers: {
          origin: "https://company1.terraoi.app",
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          action: "draft",
          csrfToken,
          organisationId: "22222222-2222-4222-8222-222222222222",
          templateId: UAV_TEMPLATE_ID,
          templateVersion: "v1",
          values: { airframe_check: "ok", battery_pct: 90, weather_notes: "clear" },
        }),
      }),
      ports,
    });
    expect(forgedOrg.status).toBe(400);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("saves a draft and submits a form using TenantContext and the user's access token", async () => {
    const { ports, cookieHeader, csrfToken, saveDraft, submitDraft } = await setupFixture();

    const draftRes = await handleFormAction({
      request: new Request("https://company1.terraoi.app/forms/submit", {
        method: "POST",
        headers: {
          origin: "https://company1.terraoi.app",
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          action: "draft",
          csrfToken,
          templateId: UAV_TEMPLATE_ID,
          templateVersion: "v1",
          values: { airframe_check: "Tether checked", battery_pct: 91, weather_notes: "Calm" },
        }),
      }),
      ports,
    });
    expect(draftRes.status).toBe(201);
    expect(draftRes.headers.get("cache-control")).toBe("no-store");
    const draftJson = (await draftRes.json()) as { ok: boolean; state: string; submissionId: string };
    expect(draftJson).toMatchObject({ ok: true, state: "draft", submissionId: SUBMISSION_ID });
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "supa-access-1",
        templateVersion: "v1",
        context: expect.objectContaining({ organisationId: COMPANY1_ORG }),
      }),
    );

    // Submitting an existing draft calls submitDraft directly (no duplicate draft).
    const submitExistingRes = await handleFormAction({
      request: new Request("https://company1.terraoi.app/forms/submit", {
        method: "POST",
        headers: {
          origin: "https://company1.terraoi.app",
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          action: "submit",
          csrfToken,
          templateId: UAV_TEMPLATE_ID,
          templateVersion: "v1",
          submissionId: SUBMISSION_ID,
          values: { airframe_check: "Tether checked", battery_pct: 91, weather_notes: "Calm" },
        }),
      }),
      ports,
    });
    expect(submitExistingRes.status).toBe(200);
    const submitJson = (await submitExistingRes.json()) as { ok: boolean; state: string; submissionId: string };
    expect(submitJson).toMatchObject({ ok: true, state: "submitted", submissionId: SUBMISSION_ID });
    expect(submitDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "supa-access-1",
        submissionId: SUBMISSION_ID,
        context: expect.objectContaining({ organisationId: COMPANY1_ORG }),
      }),
    );
  });

  it("refuses a mismatched template version with 409 naming the version validated", async () => {
    const { ports, cookieHeader, csrfToken, saveDraft } = await setupFixture();
    const res = await handleFormAction({
      request: new Request("https://company1.terraoi.app/forms/submit", {
        method: "POST",
        headers: {
          origin: "https://company1.terraoi.app",
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          action: "draft",
          csrfToken,
          templateId: UAV_TEMPLATE_ID,
          templateVersion: "v0",
          values: { airframe_check: "Tether checked", battery_pct: 91, weather_notes: "Calm" },
        }),
      }),
      ports,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("version_closed");
    expect(body.message).toContain("v0");
    expect(saveDraft).not.toHaveBeenCalled();
  });
});
