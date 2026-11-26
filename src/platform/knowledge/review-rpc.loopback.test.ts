import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";

import { createReviewRpcClient } from "./review-rpc";

/**
 * Loopback harness (COORDINATION.md §6a) for the T-213 review client: real `fetch` to a Node
 * listener on 127.0.0.1. Proves the wire carries the user bearer and the context's
 * `p_organisation_id`, and that a planted privileged-key canary appears in no header or body.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_1 = "00000000-0000-4000-8000-0000000000a1";
const USER_2 = "00000000-0000-4000-8000-0000000000b2";
const VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const DECISION_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const COLLECTION = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const AUDIT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";

function contextFor(organisationId: string, userId: string, host: string): TenantContext {
  return createTenantContext({
    organisationId,
    host,
    userId,
    membershipId: "55555555-5555-4555-8555-555555555555",
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: [],
    permittedProjectIds: [],
    policyRevision: 1,
    resolvedAt: "2026-11-23T00:00:00.000Z",
  });
}

const CTX_A = contextFor(ORG_A, USER_1, "company1.terraoi.test");
const CTX_B = contextFor(ORG_B, USER_2, "company2.terraoi.test");

function fakeJwt(sub: string, role: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64(`{"alg":"ES256","typ":"JWT","role":"${role}"}`)}.${b64(`{"sub":"${sub}","exp":1800003600}`)}.${b64(
    `synthetic-signature-${sub}`,
  )}`;
}

const USER_TOKEN = fakeJwt(USER_1, "authenticated");
const USER_TOKEN_2 = fakeJwt(USER_2, "authenticated");
const SERVICE_ROLE_CANARY = fakeJwt("service-role-canary", "service_role");
const ANON_KEY_CANARY = "synthetic-anon-key-canary-not-a-real-key";

interface Captured {
  method: string;
  url: string;
  headerText: string;
  body: string;
}

let server: Server;
let origin = "";
const captured: Captured[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const headerText = Object.entries(req.headers)
      .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v ?? ""}`]))
      .join("\n");
    captured.push({ method: req.method ?? "", url: req.url ?? "", headerText, body });

    if (req.url?.includes("refuse_42501")) {
      json(res, 401, { code: "42501", message: "not permitted to review knowledge" });
      return;
    }
    if (req.url?.includes("revoke_source_v1")) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.includes("review_reclass_v1")) {
      json(res, 200, AUDIT_ID);
      return;
    }
    json(res, 200, DECISION_ID);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("review-rpc loopback (COORDINATION §6a)", () => {
  it("sends the user bearer and context org; privileged canaries stay off the wire", async () => {
    captured.length = 0;
    void SERVICE_ROLE_CANARY;
    void ANON_KEY_CANARY;
    const client = createReviewRpcClient({ postgrestBaseUrl: origin });
    const outcome = await client.reviewDecision({
      context: CTX_A,
      accessToken: USER_TOKEN,
      sourceVersionId: VERSION,
      decision: "approve",
    });
    expect(outcome).toEqual({ ok: true, id: DECISION_ID });
    expect(captured).toHaveLength(1);
    const hit = captured[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/rpc/review_decision_v1");
    expect(hit.headerText.toLowerCase()).toMatch(/^authorization: bearer /m);
    expect(hit.headerText).toContain(USER_TOKEN);
    expect(hit.headerText).not.toContain(SERVICE_ROLE_CANARY);
    expect(hit.headerText).not.toContain(ANON_KEY_CANARY);
    expect(hit.body).not.toContain(SERVICE_ROLE_CANARY);
    expect(hit.body).not.toContain(ANON_KEY_CANARY);
    const body = JSON.parse(hit.body) as Record<string, unknown>;
    expect(body.p_organisation_id).toBe(ORG_A);
    expect(body).not.toHaveProperty("organisation_id");
  });

  it("interleaved tenants keep their own org on the wire", async () => {
    captured.length = 0;
    const client = createReviewRpcClient({ postgrestBaseUrl: origin });
    await Promise.all([
      client.publishKnowledgeVersion({
        context: CTX_A,
        accessToken: USER_TOKEN,
        sourceVersionId: VERSION,
      }),
      client.revokeSource({
        context: CTX_B,
        accessToken: USER_TOKEN_2,
        sourceId: SOURCE,
      }),
      client.reclassCollection({
        context: CTX_A,
        accessToken: USER_TOKEN,
        collectionId: COLLECTION,
        newDataClass: "internal",
      }),
    ]);
    expect(captured).toHaveLength(3);
    const orgs = captured.map((c) => (JSON.parse(c.body) as { p_organisation_id: string }).p_organisation_id).sort();
    expect(orgs).toEqual([ORG_A, ORG_A, ORG_B].sort());
    const tokens = captured.map((c) => {
      const line = c.headerText.split("\n").find((h) => h.toLowerCase().startsWith("authorization:"));
      return line?.slice("authorization: Bearer ".length);
    });
    expect(tokens).toContain(USER_TOKEN);
    expect(tokens).toContain(USER_TOKEN_2);
    const reclass = captured.find((c) => c.url.includes("review_reclass_v1"));
    expect(reclass).toBeDefined();
    expect(JSON.parse(reclass!.body).p_new_data_class).toBe("internal");
  });

  it("maps a tenancy SQLSTATE without repeating the database text", async () => {
    const refuseCaptured: Captured[] = [];
    const refuseServer = createServer(async (req, res) => {
      const body = await readBody(req);
      refuseCaptured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headerText: "",
        body,
      });
      json(res, 401, { code: "42501", message: "not permitted to review knowledge (detail: company2)" });
    });
    await new Promise<void>((resolve) => {
      refuseServer.listen(0, "127.0.0.1", () => resolve());
    });
    const refuseOrigin = `http://127.0.0.1:${(refuseServer.address() as AddressInfo).port}`;
    try {
      const refuseClient = createReviewRpcClient({ postgrestBaseUrl: refuseOrigin });
      const outcome = await refuseClient.reviewDecision({
        context: CTX_A,
        accessToken: USER_TOKEN,
        sourceVersionId: VERSION,
        decision: "approve",
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind).toBe("tenancy");
      expect(outcome.message).not.toContain("company2");
      expect(outcome.message).not.toContain("not permitted");
      expect(refuseCaptured).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        refuseServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
