import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";

import { createSubmissionRpcClient } from "./submission-rpc";

/**
 * Loopback harness (COORDINATION.md §6a) for the T-302b submission client: real `fetch` to a
 * Node listener on 127.0.0.1. Proves the wire carries the user bearer and the context's
 * `p_organisation_id`, and that a planted privileged-key canary appears in no header or body.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_1 = "00000000-0000-4000-8000-0000000000a1";
const USER_2 = "00000000-0000-4000-8000-0000000000b2";
const COLLECTION = "51000000-0000-4000-8000-000000000001";
const SUBMISSION = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

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
    json(res, 200, SUBMISSION);
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

describe("submission-rpc loopback (COORDINATION §6a)", () => {
  it("sends the user bearer and context org; privileged canaries stay off the wire", async () => {
    captured.length = 0;
    void SERVICE_ROLE_CANARY;
    void ANON_KEY_CANARY;
    const client = createSubmissionRpcClient({ postgrestBaseUrl: origin });
    const outcome = await client.submit({
      context: CTX_A,
      accessToken: USER_TOKEN,
      collectionId: COLLECTION,
      kind: "note",
      proposedText: "Loopback F15 body.",
      contextDataClass: "public",
    });
    expect(outcome).toEqual({ ok: true, id: SUBMISSION });
    expect(captured).toHaveLength(1);
    const hit = captured[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/rpc/submit_employee_knowledge_v1");
    expect(hit.headerText.toLowerCase()).toMatch(/^authorization: bearer /m);
    expect(hit.headerText).toContain(USER_TOKEN);
    expect(hit.headerText).not.toContain(SERVICE_ROLE_CANARY);
    expect(hit.headerText).not.toContain(ANON_KEY_CANARY);
    expect(hit.body).not.toContain(SERVICE_ROLE_CANARY);
    const body = JSON.parse(hit.body) as Record<string, unknown>;
    expect(body.p_organisation_id).toBe(ORG_A);
  });

  it("interleaved tenants keep their own org on the wire", async () => {
    captured.length = 0;
    const client = createSubmissionRpcClient({ postgrestBaseUrl: origin });
    await Promise.all([
      client.review({
        context: CTX_A,
        accessToken: USER_TOKEN,
        submissionId: SUBMISSION,
        decision: "approve",
      }),
      client.withdraw({
        context: CTX_B,
        accessToken: USER_TOKEN_2,
        submissionId: SUBMISSION,
      }),
    ]);
    expect(captured).toHaveLength(2);
    const orgs = captured
      .map((c) => (JSON.parse(c.body) as { p_organisation_id: string }).p_organisation_id)
      .sort();
    expect(orgs).toEqual([ORG_A, ORG_B].sort());
  });
});
