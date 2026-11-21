import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import { createFormsRpcClient } from "./forms-rpc";
import { SEEDED_FORM_TEMPLATE_ROWS } from "./seeded-templates";
import { mapFormTemplateRow } from "./template-schema";

const COMPANY1_ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY2_ORG = "22222222-2222-4222-8222-222222222222";
const SUBMISSION_ID = "aa000000-0000-4000-8000-000000000001";
const SUPERSEDED_ID = "aa000000-0000-4000-8000-000000000000";

const uavTemplate = mapFormTemplateRow(SEEDED_FORM_TEMPLATE_ROWS[0]!);
const gprTemplate = mapFormTemplateRow(SEEDED_FORM_TEMPLATE_ROWS[2]!);

const CTX_1 = createTenantContext({
  organisationId: COMPANY1_ORG,
  host: "company1.terraoi.app",
  userId: "00000000-0000-4000-8000-0000000000a1",
  membershipId: "99000000-0000-4000-8000-000000000001",
  membershipStatus: "active",
  roles: ["admin"],
  permittedServiceKeys: [],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-20T00:00:00Z",
});

const CTX_2 = createTenantContext({
  organisationId: COMPANY2_ORG,
  host: "company2.terraoi.app",
  userId: "00000000-0000-4000-8000-0000000000b1",
  membershipId: "99000000-0000-4000-8000-000000000002",
  membershipStatus: "active",
  roles: ["admin"],
  permittedServiceKeys: [],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-20T00:00:00Z",
});

const VALID_UAV_VALUES = {
  airframe_check: "Tether and props checked",
  battery_pct: 92,
  weather_notes: "Wind 4 m/s, synthetic",
};

describe("forms RPC client (unit)", () => {
  it("refuses invalid values or closed template version locally without calling the socket", async () => {
    const fetchImpl = vi.fn();
    const client = createFormsRpcClient({ postgrestBaseUrl: "https://example.supabase.co/rest/v1", fetchImpl });

    const closed = await client.saveDraft({
      context: CTX_1,
      accessToken: "user-token-1",
      template: uavTemplate,
      templateVersion: "v0",
      values: VALID_UAV_VALUES,
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.kind).toBe("version_closed");

    const invalid = await client.saveDraft({
      context: CTX_1,
      accessToken: "user-token-1",
      template: uavTemplate,
      templateVersion: "v1",
      values: { airframe_check: "only one field" },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.kind).toBe("validation");

    const badSub = await client.submitDraft({
      context: CTX_1,
      accessToken: "user-token-1",
      submissionId: "not-a-uuid",
    });
    expect(badSub.ok).toBe(false);
    if (!badSub.ok) expect(badSub.kind).toBe("validation");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps tenancy SQLSTATEs and backend refusals to safe copy without leaking PostgREST detail", async () => {
    const secretDbMsg = "relation public.form_submissions policy denied org=11111111";
    const client42501 = createFormsRpcClient({
      postgrestBaseUrl: "https://example.supabase.co/rest/v1",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "42501", message: secretDbMsg }), { status: 403 }),
    });

    const denied = await client42501.submitDraft({
      context: CTX_1,
      accessToken: "user-token-1",
      submissionId: SUBMISSION_ID,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.kind).toBe("tenancy");
      expect(denied.message).not.toContain(secretDbMsg);
      expect(denied.message).not.toContain("42501");
    }

    const client22023 = createFormsRpcClient({
      postgrestBaseUrl: "https://example.supabase.co/rest/v1",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "22023", message: "this submission was already captured" }), { status: 400 }),
    });
    const replayed = await client22023.submitDraft({
      context: CTX_1,
      accessToken: "user-token-1",
      submissionId: SUBMISSION_ID,
    });
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.kind).toBe("rejected");
    }
  });

  it("preserves draftSubmissionId when saveAndSubmit saves the draft but submit_form_v1 refuses permission", async () => {
    let calls = 0;
    const client = createFormsRpcClient({
      postgrestBaseUrl: "https://example.supabase.co/rest/v1",
      fetchImpl: async (url) => {
        calls += 1;
        if (url.endsWith("/rpc/save_form_draft_v1")) {
          return new Response(JSON.stringify(SUBMISSION_ID), { status: 200 });
        }
        return new Response(JSON.stringify({ code: "42501", message: "not permitted to publish" }), { status: 403 });
      },
    });

    const outcome = await client.saveAndSubmit({
      context: CTX_1,
      accessToken: "user-token-1",
      template: uavTemplate,
      templateVersion: "v1",
      values: VALID_UAV_VALUES,
    });
    expect(calls).toBe(2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("tenancy");
      expect(outcome.draftSubmissionId).toBe(SUBMISSION_ID);
    }
  });
});

describe("forms RPC client (loopback HTTP harness, COORDINATION §6a)", () => {
  let baseUrl = "";
  const seen: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/rpc/save_form_draft_v1") {
        res.statusCode = 200;
        res.end(JSON.stringify(SUBMISSION_ID));
        return;
      }
      if (req.url === "/rpc/submit_form_v1") {
        res.statusCode = 200;
        res.end(JSON.stringify(body.p_submission_id));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("sends p_organisation_id from TenantContext and bearer token over real HTTP with no cross-tenant bleed", async () => {
    const client = createFormsRpcClient({ postgrestBaseUrl: baseUrl });

    const [first, second] = await Promise.all([
      client.saveDraft({
        context: CTX_1,
        accessToken: "token-company1",
        template: uavTemplate,
        templateVersion: "v1",
        values: VALID_UAV_VALUES,
        supersedesSubmissionId: SUPERSEDED_ID,
      }),
      client.saveDraft({
        context: CTX_2,
        accessToken: "token-company2",
        template: gprTemplate,
        templateVersion: "v1",
        values: { line_id: "L-01", passes: 2 },
      }),
    ]);

    expect(first).toEqual({ ok: true, submissionId: SUBMISSION_ID });
    expect(second).toEqual({ ok: true, submissionId: SUBMISSION_ID });

    const submitted = await client.submitDraft({
      context: CTX_1,
      accessToken: "token-company1",
      submissionId: SUBMISSION_ID,
    });
    expect(submitted).toEqual({ ok: true, submissionId: SUBMISSION_ID });

    const c1Draft = seen.find((r) => r.path === "/rpc/save_form_draft_v1" && r.auth === "Bearer token-company1");
    expect(c1Draft?.body).toEqual({
      p_organisation_id: COMPANY1_ORG,
      p_template_id: uavTemplate.id,
      p_template_version: "v1",
      p_values: VALID_UAV_VALUES,
      p_supersedes_submission_id: SUPERSEDED_ID,
    });

    const c2Draft = seen.find((r) => r.path === "/rpc/save_form_draft_v1" && r.auth === "Bearer token-company2");
    expect(c2Draft?.body).toEqual({
      p_organisation_id: COMPANY2_ORG,
      p_template_id: gprTemplate.id,
      p_template_version: "v1",
      p_values: { line_id: "L-01", passes: 2 },
      p_supersedes_submission_id: null,
    });

    const c1Submit = seen.find((r) => r.path === "/rpc/submit_form_v1");
    expect(c1Submit?.auth).toBe("Bearer token-company1");
    expect(c1Submit?.body).toEqual({
      p_organisation_id: COMPANY1_ORG,
      p_submission_id: SUBMISSION_ID,
    });
  });
});
