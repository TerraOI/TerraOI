import { describe, expect, it } from "vitest";

import {
  createTenancyDataApi,
  isTenancyReadError,
  type TenancyFetch,
} from "./tenancy-data-api";

const BASE = "https://staging-projects.supabase.co";
const ANON = "anon-key-not-a-secret";
const ORG = "11111111-1111-4111-8111-111111111111";
const ORG2 = "22222222-2222-4222-8222-222222222222";
const TOKEN = "eyJhbGciOi.user-access-token";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** Records every request the module dials, and answers with a scripted response. */
function harness(responder: (call: Call) => { ok: boolean; status: number; body: string }) {
  const calls: Call[] = [];
  const fetchImpl: TenancyFetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    };
    calls.push(call);
    const answered = responder(call);
    return {
      ok: answered.ok,
      status: answered.status,
      text: async () => answered.body,
    };
  };
  const api = createTenancyDataApi({ supabaseUrl: BASE, anonKey: ANON, fetchImpl });
  return { api, calls };
}

function json(ok: boolean, status: number, body: string) {
  return () => ({ ok, status, body });
}

describe("the membership read is an RPC, not a table select", () => {
  it("dials current_membership_v1 with only the tenant argument", async () => {
    const { api, calls } = harness(json(true, 200, JSON.stringify([
      { membership_id: "9c0f6b1e-6d0a-4d59-9c1a-2f1a0b6e0a11", organisation_id: ORG, status: "active" },
    ])));

    const found = await api.findMembership(ORG, TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/rpc/current_membership_v1`);
    expect(calls[0]?.method).toBe("POST");
    // The body names the tenant and nothing else: there is no key that could ask for another user's
    // membership, which is what the direct table read made possible.
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ p_organisation_id: ORG });
    expect(found?.membershipId).toBe("9c0f6b1e-6d0a-4d59-9c1a-2f1a0b6e0a11");
    expect(found?.status).toBe("active");
  });

  it("never dials a direct table endpoint", async () => {
    const { api, calls } = harness(json(true, 200, "[]"));
    await api.findMembership(ORG, TOKEN);
    await expect(api.policyRevision(ORG, TOKEN)).rejects.toSatisfy(isTenancyReadError);

    for (const call of calls) {
      expect(call.url).not.toContain("/organisation_memberships");
      expect(call.url).not.toContain("/organisations?");
    }
  });

  it("carries the user's own token as the bearer, never the anon key", async () => {
    const { api, calls } = harness(json(true, 200, "[]"));
    await api.findMembership(ORG, TOKEN);

    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers.authorization).not.toContain(ANON);
  });

  it("refuses before dialling when there is no user token to act as", async () => {
    const { api, calls } = harness(json(true, 200, "[]"));
    await expect(api.findMembership(ORG, "")).rejects.toSatisfy(isTenancyReadError);
    expect(calls).toHaveLength(0);
  });

  it("answers null when the caller simply holds no membership there", async () => {
    const { api } = harness(json(true, 200, "[]"));
    await expect(api.findMembership(ORG2, TOKEN)).resolves.toBeNull();
  });

  it("refuses rather than answering null when the database refused the caller", async () => {
    // "no rows" and "not allowed" are different answers (tenancy-rpc.ts:40-41). Collapsing them is how
    // a tenancy bug reads as a quiet sign-in prompt.
    const { api } = harness(json(false, 403, JSON.stringify({ code: "28000", message: "not an active member" })));
    await expect(api.findMembership(ORG, TOKEN)).rejects.toMatchObject({ kind: "tenancy" });
  });

  it("refuses an unreadable row shape instead of guessing a status", async () => {
    const { api } = harness(json(true, 200, JSON.stringify([{ membership_id: ORG, organisation_id: ORG, status: "superuser" }])));
    await expect(api.findMembership(ORG, TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });
  });
});

describe("the policy revision read is scoped RPC per FAQ-0011", () => {
  it("dials current_policy_revision_v1 with only the tenant argument and returns the value", async () => {
    const { api, calls } = harness(json(true, 200, "3"));
    const revision = await api.policyRevision(ORG, TOKEN);

    expect(calls[0]?.url).toBe(`${BASE}/rpc/current_policy_revision_v1`);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ p_organisation_id: ORG });
    expect(revision).toBe(3);
  });

  it("never answers 0 for a missing value", async () => {
    const { api } = harness(json(true, 200, ""));
    await expect(api.policyRevision(ORG, TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });
  });

  it("classifies a scope refusal as tenancy, and an outage as backend failure", async () => {
    const refused = harness(json(false, 401, JSON.stringify({ code: "PGRST301" })));
    await expect(refused.api.policyRevision(ORG, TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });

    const denied = harness(json(false, 500, JSON.stringify({ code: "42501" })));
    await expect(denied.api.policyRevision(ORG, TOKEN)).rejects.toMatchObject({ kind: "tenancy" });
  });
});

describe("the host read stays on its anon RPC", () => {
  it("resolves through resolve_tenant_host and validates the row", async () => {
    const { api, calls } = harness(json(true, 200, JSON.stringify([
      { organisation_id: ORG, organisation_status: "active" },
    ])));

    const host = await api.findHost("company1.terraoi.app");

    expect(calls[0]?.url).toBe(`${BASE}/rpc/resolve_tenant_host`);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ p_host: "company1.terraoi.app" });
    expect(host?.organisationId).toBe(ORG);
  });

  it("answers null for a host the registry does not know", async () => {
    const { api } = harness(json(true, 200, "[]"));
    await expect(api.findHost("evil.terraoi.app")).resolves.toBeNull();
  });
});

describe("the failure vocabulary is closed and safe", () => {
  it("names no table, no SQLSTATE and no provider in the thrown message", async () => {
    const { api } = harness(json(false, 500, JSON.stringify({
      code: "42501",
      message: `permission denied for table organisation_memberships in schema public on pooler.internal:6543`,
    })));

    const error = await api.policyRevision(ORG, TOKEN).catch((e: unknown) => e);
    expect(isTenancyReadError(error)).toBe(true);
    const message = String((error as Error).message);
    for (const leak of ["organisation_memberships", "pooler.internal", "42501", "public"]) {
      expect(message).not.toContain(leak);
    }
    expect(error).toMatchObject({ kind: "tenancy" });
  });

  it("treats a non-JSON success as a backend failure, not as empty data", async () => {
    const { api } = harness(json(true, 200, "<html>gateway</html>"));
    await expect(api.findMembership(ORG, TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });
  });
});
