import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import {
  SAFE_SOURCE_ACL_MESSAGE,
  authorizeSourceAccess,
  type SourceAclDeps,
} from "./acl";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_1 = "00000000-0000-4000-8000-0000000000a1";
const SITE_A_SOURCE = "61000000-0000-4000-8000-000000000002";

function fakeJwt(sub: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT","role":"authenticated"}')}.${b64(
    `{"sub":"${sub}","exp":1800003600}`,
  )}.${b64(`synthetic-signature-${sub}`)}`;
}

function contextFor(organisationId: string, userId: string): TenantContext {
  return createTenantContext({
    organisationId,
    host: organisationId === ORG_A ? "company1.terraoi.test" : "company2.terraoi.test",
    userId,
    membershipId: "55555555-5555-4555-8555-555555555555",
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: [],
    permittedProjectIds: [],
    policyRevision: 1,
    resolvedAt: "2026-11-11T00:00:00.000Z",
  });
}

const CTX_A = contextFor(ORG_A, USER_1);
const TOKEN_1 = fakeJwt(USER_1);
const BASE = "http://127.0.0.1:1";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function transport(answer: (call: { index: number; body: string }) => Promise<Response> | Response) {
  const sent: Sent[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    sent.push({
      url: input,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body,
    });
    return answer({ index: sent.length - 1, body });
  };
  return { sent, fetchImpl };
}

function deps(fetchImpl: FetchImpl): SourceAclDeps {
  return { postgrestBaseUrl: BASE, fetchImpl };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("authorizeSourceAccess (T-214 PR-1)", () => {
  it("posts through withTenantRpc with purpose and strips forged p_organisation_id", async () => {
    const t = transport(() => jsonResponse(200, true));
    const outcome = await authorizeSourceAccess(
      {
        context: CTX_A,
        accessToken: TOKEN_1,
        sourceId: SITE_A_SOURCE,
        purpose: "retrieve",
      },
      deps(t.fetchImpl),
    );

    expect(outcome).toEqual({ ok: true, authorized: true });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.url).toBe(`${BASE}/rpc/authorize_source_access_v1`);
    const parsed = JSON.parse(t.sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(parsed.p_organisation_id).toBe(ORG_A);
    expect(parsed.p_source_id).toBe(SITE_A_SOURCE);
    expect(parsed.p_purpose).toBe("retrieve");
    expect(Object.keys(parsed)).toEqual(["p_source_id", "p_purpose", "p_organisation_id"]);
  });

  it("parses false without treating it as backend failure", async () => {
    const t = transport(() => jsonResponse(200, false));
    const outcome = await authorizeSourceAccess(
      { context: CTX_A, accessToken: TOKEN_1, sourceId: SITE_A_SOURCE, purpose: "cite" },
      deps(t.fetchImpl),
    );
    expect(outcome).toEqual({ ok: true, authorized: false });
  });

  it("maps 28000 to tenancy", async () => {
    const t = transport(() =>
      jsonResponse(400, { code: "28000", message: "not a member", details: null, hint: null }),
    );
    const outcome = await authorizeSourceAccess(
      { context: CTX_A, accessToken: TOKEN_1, sourceId: SITE_A_SOURCE, purpose: "history" },
      deps(t.fetchImpl),
    );
    expect(outcome).toEqual({ ok: false, kind: "tenancy", message: SAFE_SOURCE_ACL_MESSAGE.tenancy });
  });

  it("maps 42501 to tenancy", async () => {
    const t = transport(() =>
      jsonResponse(403, { code: "42501", message: "insufficient privilege", details: null, hint: null }),
    );
    const outcome = await authorizeSourceAccess(
      { context: CTX_A, accessToken: TOKEN_1, sourceId: SITE_A_SOURCE, purpose: "download" },
      deps(t.fetchImpl),
    );
    expect(outcome).toEqual({ ok: false, kind: "tenancy", message: SAFE_SOURCE_ACL_MESSAGE.tenancy });
  });

  it("rejects invalid purpose before dialing", async () => {
    const t = transport(() => jsonResponse(200, true));
    const outcome = await authorizeSourceAccess(
      {
        context: CTX_A,
        accessToken: TOKEN_1,
        sourceId: SITE_A_SOURCE,
        purpose: "forged" as "retrieve",
      },
      deps(t.fetchImpl),
    );
    expect(outcome).toEqual({ ok: false, kind: "validation", message: SAFE_SOURCE_ACL_MESSAGE.validation });
    expect(t.sent).toHaveLength(0);
  });

  it("rejects invalid source id before dialing", async () => {
    const t = transport(() => jsonResponse(200, true));
    const outcome = await authorizeSourceAccess(
      { context: CTX_A, accessToken: TOKEN_1, sourceId: "not-a-uuid", purpose: "retrieve" },
      deps(t.fetchImpl),
    );
    expect(outcome).toEqual({ ok: false, kind: "validation", message: SAFE_SOURCE_ACL_MESSAGE.validation });
    expect(t.sent).toHaveLength(0);
  });
});