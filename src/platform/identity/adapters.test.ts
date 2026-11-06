import { describe, expect, it } from "vitest";

import { buildIdentityPorts, unresolvedTenancyStore, type FetchImpl, type IdentityEnv } from "./adapters";
import { bytesToBase64Url } from "./signed-token";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const BASE = "https://synthetic.supabase.co";
const ANON = "synthetic-anon-publishable-key";
const SERVICE_ROLE_POISON = "poison-service-role-key-never-used";

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

function recorder(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { calls, fetchImpl };
}

const env = {
  IDENTITY_SESSION_KEY: SECRET,
  SUPABASE_URL: BASE,
  SUPABASE_ANON_KEY: ANON,
  IDENTITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: key.startsWith("key") }) },
};

async function sha256Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

const VERIFIER = "synthetic-verifier-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// The only Auth key this repo may use is the publishable/anon one; these tests keep that honest by
// putting a poisoned service-role value in the environment and proving it never reaches a request.
describe("buildIdentityPorts — Supabase magic link (PKCE, anon key only)", () => {
  it("sends the S256 challenge for the verifier this login attempt generated", async () => {
    const { calls, fetchImpl } = recorder({ ok: true, status: 200, json: async () => ({}) });
    const ports = buildIdentityPorts(env, { fetchImpl });
    await ports.sendMagicLink({
      email: "owner1@company1.test",
      redirectTo: "https://company1.terraoi.app/auth/callback?state=abc",
      codeVerifier: VERIFIER,
    });
    const call = calls[0] as Call;
    expect(call.url).toBe(`${BASE}/auth/v1/signup`);
    expect(call.init.method).toBe("POST");
    const body = JSON.parse(call.init.body) as { email: string; options: Record<string, string> };
    expect(body.email).toBe("owner1@company1.test");
    expect(body.options.code_challenge).toBe(await sha256Url(VERIFIER));
    expect(body.options.code_challenge).not.toBe(VERIFIER);
    expect(body.options.code_challenge_method).toBe("s256");
    expect(body.options.email_redirect_to).toBe("https://company1.terraoi.app/auth/callback?state=abc");
  });

  it("authenticates with the publishable key and never with a service-role key", async () => {
    const { calls, fetchImpl } = recorder({ ok: true, status: 200, json: async () => ({}) });
    const poisoned = { ...env, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_POISON } as Partial<IdentityEnv> & Record<string, unknown>;
    const ports = buildIdentityPorts(poisoned as Partial<IdentityEnv>, { fetchImpl });
    await ports.sendMagicLink({ email: "a@b.test", redirectTo: "https://company1.terraoi.app/auth/callback?state=x", codeVerifier: VERIFIER });
    await ports.exchangeLoginCode({ code: "c", state: "s", host: "company1.terraoi.app", codeVerifier: VERIFIER });
    const wire = JSON.stringify(calls);
    expect(wire).not.toContain(SERVICE_ROLE_POISON);
    expect((calls[0] as Call).init.headers.apikey).toBe(ANON);
    expect((calls[0] as Call).init.headers.authorization).toBe(`Bearer ${ANON}`);
  });

  it("exchanges the code with the verifier from the login-state cookie", async () => {
    const user = { id: "00000000-0000-4000-8000-0000000000a1", email: "Owner1@Company1.TEST", email_confirmed_at: "2026-11-05T00:00:00Z" };
    const { calls, fetchImpl } = recorder({ ok: true, status: 200, json: async () => ({ access_token: "synthetic", user }) });
    const ports = buildIdentityPorts(env, { fetchImpl });
    const exchanged = await ports.exchangeLoginCode({ code: "auth-code", state: "state", host: "company1.terraoi.app", codeVerifier: VERIFIER });
    const call = calls[0] as Call;
    expect(call.url).toBe(`${BASE}/auth/v1/token?grant_type=pkce`);
    expect(JSON.parse(call.init.body)).toEqual({ auth_code: "auth-code", code_verifier: VERIFIER });
    // The provider's casing is passed through: canonicalization is the email module's job, once.
    expect(exchanged).toEqual({ ok: true, userId: user.id, email: user.email, emailVerified: true });
  });

  it("reports an identity the provider did not confirm as unverified", async () => {
    const user = { id: "00000000-0000-4000-8000-0000000000a2", email: "field2@company1.test" };
    const { fetchImpl } = recorder({ ok: true, status: 200, json: async () => ({ user }) });
    const ports = buildIdentityPorts(env, { fetchImpl });
    const exchanged = await ports.exchangeLoginCode({ code: "c", state: "s", host: "company1.terraoi.app", codeVerifier: VERIFIER });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    expect(exchanged.emailVerified).toBe(false);
  });

  it("collapses every exchange failure into one safe reason", async () => {
    const cases: Array<{ ok: boolean; status: number; json: () => Promise<unknown> }> = [
      { ok: false, status: 400, json: async () => ({ error: "invalid grant" }) },
      { ok: false, status: 401, json: async () => ({ error: "code used" }) },
      { ok: true, status: 200, json: async () => { throw new Error("not json"); } },
      { ok: true, status: 200, json: async () => ({}) },
      { ok: true, status: 200, json: async () => ({ user: { id: "root", email: "a@b.test", email_confirmed_at: "x" } }) },
      { ok: true, status: 200, json: async () => ({ user: { id: "00000000-0000-4000-8000-0000000000a1" } }) },
    ];
    for (const response of cases) {
      const ports = buildIdentityPorts(env, { fetchImpl: async () => response });
      expect(await ports.exchangeLoginCode({ code: "c", state: "s", host: "company1.terraoi.app", codeVerifier: VERIFIER })).toEqual({
        ok: false,
        reason: "invalid_or_expired",
      });
    }
  });

  it("fails closed when the Auth bindings are missing", async () => {
    for (const partial of [{ ...env, SUPABASE_URL: undefined }, { ...env, SUPABASE_ANON_KEY: undefined }, {}]) {
      const { fetchImpl, calls } = recorder({ ok: true, status: 200, json: async () => ({}) });
      const ports = buildIdentityPorts(partial as never, { fetchImpl });
      await expect(ports.sendMagicLink({ email: "a@b.test", redirectTo: "https://x.test", codeVerifier: VERIFIER })).rejects.toThrow(/SUPABASE/);
      await expect(ports.exchangeLoginCode({ code: "c", state: "s", host: "company1.terraoi.app", codeVerifier: VERIFIER })).rejects.toThrow(/SUPABASE/);
      expect(calls).toHaveLength(0);
    }
  });
});

describe("buildIdentityPorts — limiter, secrets and the #37 seam", () => {
  it("signs the limiter identity with the deployment key and keeps the address out of the key", async () => {
    const ports = buildIdentityPorts(env);
    const a = await ports.rateLimitKey({ host: "company1.terraoi.app", email: "user@example.test" });
    const same = await ports.rateLimitKey({ host: "company1.terraoi.app", email: "user@example.test" });
    const otherHost = await ports.rateLimitKey({ host: "company2.terraoi.app", email: "user@example.test" });
    expect(a).toBe(same);
    expect(a).not.toBe(otherHost);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toContain("@");
    expect(a).not.toContain("example.test");
  });

  it("refuses to rate limit without a limiter binding instead of allowing everything", async () => {
    const ports = buildIdentityPorts({ ...env, IDENTITY_RATE_LIMITER: undefined });
    await expect(ports.allowRequest("key-abc")).rejects.toThrow(/IDENTITY_RATE_LIMITER/);
    const wired = buildIdentityPorts(env);
    expect(await wired.allowRequest("key-abc")).toBe(true);
    expect(await wired.allowRequest("other")).toBe(false);
  });

  it("reports no signing secret when the binding is absent", () => {
    expect(buildIdentityPorts({}).signingSecret()).toBeNull();
    expect(buildIdentityPorts({ IDENTITY_SESSION_KEY: SECRET }).signingSecret()).toBe(SECRET);
  });

  // The visible gap: nothing in this slice invents a way to carry identity into Postgres.
  it("the tenancy store refuses rather than guessing a carrier", async () => {
    const store = unresolvedTenancyStore();
    for (const call of [store.findHost("company1.terraoi.app"), store.findMembership("11111111-1111-4111-8111-111111111111", "00000000-0000-4000-8000-0000000000a1"), store.policyRevision("11111111-1111-4111-8111-111111111111")]) {
      await expect(call).rejects.toThrow(/#37/);
    }
    const ports = buildIdentityPorts(env);
    await expect(ports.findHost("company1.terraoi.app")).rejects.toThrow(/#37/);
  });

  it("invite redemption is not silently available before its RPC lands", async () => {
    const ports = buildIdentityPorts(env);
    await expect(
      ports.redeemInvitation({ organisationId: "11111111-1111-4111-8111-111111111111", userId: "00000000-0000-4000-8000-0000000000a1", email: "user@example.test" }),
    ).rejects.toThrow(/t-102e-identity-invites-sql/);
  });
});
