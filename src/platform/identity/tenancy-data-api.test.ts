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

// T-201 PR-2. The two calls `20261115060000_identity_methods.sql` makes possible. Both carry a **user**
// bearer, because both RPCs decide the caller from that bearer: `redeem_invitation_v1` claims the row
// `auth.uid()` names, and `entra_allowed_issuers_v1` is granted to `authenticated` and not to `anon`
// (slot 012 assertions 23, 38-41). The pgTAP slot tests what the SQL answers; this file tests what this
// module sends, and what it refuses to guess.
describe("the invite claim is the caller's own RPC (T-201 PR-2)", () => {
  it("dials redeem_invitation_v1 with the tenant and the address, and no user id", async () => {
    const { api, calls } = harness(json(true, 200, '"redeemed"'));

    const result = await api.redeemInvitation(ORG, "user@example.test", TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/rpc/redeem_invitation_v1`);
    expect(calls[0]?.method).toBe("POST");
    // No user id in the body: the SQL takes the caller from the bearer, so there is no argument that
    // could name somebody else's invitation. The caller's id never leaves this process on this path.
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ p_organisation_id: ORG, p_email: "user@example.test" });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers.authorization).not.toContain(ANON);
    expect(calls[0]?.headers.apikey).toBe(ANON);
    expect(result).toBe("redeemed");
  });

  it("maps the three answers through, exactly as the SQL gives them", async () => {
    for (const answer of ["redeemed", "not_found", "email_mismatch"] as const) {
      const { api } = harness(json(true, 200, JSON.stringify(answer)));
      await expect(api.redeemInvitation(ORG, "user@example.test", TOKEN)).resolves.toBe(answer);
    }
  });

  it("refuses an answer outside the three rather than choosing one", async () => {
    // The stakes are asymmetric: `signin-completion.ts` re-reads the membership only on `redeemed`, so
    // an invented `not_found` denies somebody their own workspace and an invented `redeemed` grants a
    // claim the database never made.
    for (const body of ["null", "[]", '""', '"revoked"', '"REDEEMED"', '"redeemed "', "<html>gateway</html>"]) {
      const { api } = harness(json(true, 200, body));
      await expect(api.redeemInvitation(ORG, "user@example.test", TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });
    }
  });

  it("refuses before dialling when there is no caller token to claim as", async () => {
    const { api, calls } = harness(json(true, 200, '"redeemed"'));
    await expect(api.redeemInvitation(ORG, "user@example.test", "")).rejects.toSatisfy(isTenancyReadError);
    expect(calls).toHaveLength(0);
  });

  it("keeps the SQL's refusals out of the result vocabulary", async () => {
    // 28000 (the RPC's "there is no subject here to claim for") is an identity answer and joins the
    // existing tenancy vocabulary. 22023 ("that address is not canonical") is a bug on our side of the
    // call. Neither is the RPC's own `not_found`, and flattening them would turn a fault into somebody
    // being told they were never invited.
    const noSubject = harness(json(false, 401, JSON.stringify({ code: "28000", message: "no subject" })));
    await expect(noSubject.api.redeemInvitation(ORG, "user@example.test", TOKEN)).rejects.toMatchObject({ kind: "tenancy" });
    const badArgument = harness(json(false, 400, JSON.stringify({ code: "22023", message: "email must be canonical" })));
    await expect(badArgument.api.redeemInvitation(ORG, "User@Example.test", TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });
  });
});

describe("the Entra issuer allow-list read (T-201 PR-2)", () => {
  const ISSUERS = JSON.stringify(["6f1e0000-0000-4000-8000-0000000000aa", "7a2e0000-0000-4000-8000-0000000000bb"]);

  it("dials entra_allowed_issuers_v1 with only the tenant argument", async () => {
    const { api, calls } = harness(json(true, 200, ISSUERS));

    const allowed = await api.entraIssuers(ORG, TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/rpc/entra_allowed_issuers_v1`);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ p_organisation_id: ORG });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(allowed).toEqual([
      "6f1e0000-0000-4000-8000-0000000000aa",
      "7a2e0000-0000-4000-8000-0000000000bb",
    ]);
  });

  it("answers the empty array for a tenant that has allowed nothing", async () => {
    // The distinction `decideEntraLink` depends on: an empty allow-list is a real configuration answer
    // and refuses as `issuer_not_allowed`, while `policy_unresolved` is reserved for a read that could
    // not be made at all. So an empty body must never be turned into `[]` by this module either.
    const { api } = harness(json(true, 200, "[]"));
    await expect(api.entraIssuers(ORG, TOKEN)).resolves.toEqual([]);
    const emptyBody = harness(json(true, 200, ""));
    await expect(emptyBody.api.entraIssuers(ORG, TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });
  });

  it("throws rather than reporting an empty policy for an unreadable body", async () => {
    for (const body of ["null", '"6f1e0000-0000-4000-8000-0000000000aa"', '{"issuer_tenant_id": "6f1e0000-0000-4000-8000-0000000000aa"}', '["", "ok"]', "<html>gateway</html>"]) {
      const { api } = harness(json(true, 200, body));
      await expect(api.entraIssuers(ORG, TOKEN)).rejects.toMatchObject({ kind: "backend_failure" });
    }
  });

  it("refuses before dialling when there is no identity to read as", async () => {
    const { api, calls } = harness(json(true, 200, ISSUERS));
    await expect(api.entraIssuers(ORG, "")).rejects.toSatisfy(isTenancyReadError);
    expect(calls).toHaveLength(0);
  });

  it("names no schema, table or SQLSTATE when a policy read fails", async () => {
    const { api } = harness(json(false, 500, JSON.stringify({ code: "42501", message: "permission denied for table tenant_entra_issuers in schema public" })));
    const error = await api.entraIssuers(ORG, TOKEN).catch((e: unknown) => e);
    expect(isTenancyReadError(error)).toBe(true);
    const message = String((error as Error).message);
    for (const leak of ["tenant_entra_issuers", "public", "42501"]) expect(message).not.toContain(leak);
  });
});
