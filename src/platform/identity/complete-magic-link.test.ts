import { describe, expect, it } from "vitest";

import { completeMagicLink, type MagicLinkCallbackPorts } from "./complete-magic-link";
import { createLoginState, LOGIN_STATE_COOKIE_BASE } from "./login-state";
import { SESSION_COOKIE_BASE } from "./session";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
const HOST_A = "company1.terraoi.app";
const HOST_B = "company2.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const INVITED = "00000000-0000-4000-8000-0000000000c1";
const LEFT = "00000000-0000-4000-8000-0000000000a3";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

type Membership = { membershipId: string; status: "invited" | "active" | "suspended" | "removed"; roles: string[]; permittedServiceKeys: string[]; permittedProjectIds: string[] };

interface Harness {
  ports: MagicLinkCallbackPorts;
  exchanges: Array<{ code: string; state: string; host: string; codeVerifier: string }>;
  memberships: string[];
  redeemed: Array<{ organisationId: string; userId: string; email: string }>;
  identity: { ok: true; userId: string; email: string; emailVerified: boolean } | { ok: false; reason: "invalid_or_expired" };
  membershipFor: (organisationId: string, userId: string, callIndex: number) => Membership | null;
  redeemResult: "redeemed" | "not_found" | "email_mismatch";
  boom: boolean;
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const state: Harness = {
    exchanges: [],
    memberships: [],
    redeemed: [],
    identity: { ok: true, userId: OWNER1, email: "owner1@company1.test", emailVerified: true },
    membershipFor: (organisationId, userId) =>
      organisationId === C1 && userId === OWNER1
        ? { membershipId: MEMBERSHIP, status: "active", roles: ["member"], permittedServiceKeys: [], permittedProjectIds: [] }
        : organisationId === C1 && userId === LEFT
          ? { membershipId: MEMBERSHIP, status: "suspended", roles: [], permittedServiceKeys: [], permittedProjectIds: [] }
          : organisationId === C1 && userId === INVITED
            ? { membershipId: MEMBERSHIP, status: "invited", roles: [], permittedServiceKeys: [], permittedProjectIds: [] }
            : null,
    redeemResult: "redeemed",
    boom: false,
    ports: {} as MagicLinkCallbackPorts,
  };
  Object.assign(state, overrides);
  state.ports = {
    now: () => NOW,
    signingSecret: () => SECRET,
    findHost: async (host) =>
      host === HOST_A ? { organisationId: C1, organisationStatus: "active" } : host === HOST_B ? { organisationId: C2, organisationStatus: "active" } : null,
    exchangeLoginCode: async (input) => {
      if (state.boom) throw new Error("provider unavailable");
      state.exchanges.push(input);
      return state.identity;
    },
    findMembership: async (organisationId, userId) => {
      if (state.boom) throw new Error("database unavailable");
      state.memberships.push(`${organisationId}:${userId}`);
      return state.membershipFor(organisationId, userId, state.memberships.length);
    },
    redeemInvitation: async (input) => {
      state.redeemed.push(input);
      return state.redeemResult;
    },
  };
  return state;
}

async function callback(input: {
  host?: string;
  code?: string | null;
  state?: string | null;
  cookieHeader?: string | null;
  query?: Record<string, string>;
  configure?: (h: Harness) => void;
}) {
  const h = harness();
  if (input.configure) input.configure(h);

  const host = input.host ?? HOST_A;
  let cookieHeader = input.cookieHeader ?? null;
  let stateParam = input.state ?? null;
  if (input.cookieHeader === undefined && input.state === undefined) {
    // The normal case: this browser asked for the link on this host and got the state cookie then.
    const loginState = await createLoginState({ host, secret: SECRET, now: NOW, secureTransport: true });
    cookieHeader = `${loginState.cookie.name}=${loginState.cookie.value}`;
    stateParam = loginState.nonce;
  }

  const params = new URLSearchParams();
  if (input.code !== null) params.set("code", input.code ?? "synthetic-auth-code");
  if (stateParam !== null) params.set("state", stateParam);
  for (const [key, value] of Object.entries(input.query ?? {})) params.set(key, value);

  const url = `https://${host}/auth/callback${params.size > 0 ? `?${params.toString()}` : ""}`;
  const response = await completeMagicLink({
    request: new Request(url, { headers: cookieHeader === null ? undefined : new Headers({ cookie: cookieHeader }) }),
    ports: h.ports,
  });
  return { response, h };
}

const locationOf = (response: Response) => new URL(response.headers.get("location") as string);
const cookies = (response: Response) => response.headers.getSetCookie();
const sessionCookie = (response: Response) => cookies(response).find((c) => c.startsWith(`${SESSION_COOKIE_BASE}`) || c.startsWith(`__Host-${SESSION_COOKIE_BASE}`)) ?? "";

// The callback is the piece an attacker can hand to a victim: a link, plus maybe a code. Everything
// here is checked before the provider is contacted, and no failure path produces a session or reads
// tenant data (plan §4.2 tests: cross-tenant callback replay, invite for tenant A on tenant B's host).
describe("completeMagicLink (GET /auth/callback)", () => {
  it("establishes a host-only session for an active member", async () => {
    const { response, h } = await callback({});
    expect(response.status).toBe(303);
    expect(locationOf(response).host).toBe(HOST_A);
    expect(locationOf(response).pathname).toBe("/");

    const cookie = sessionCookie(response);
    expect(cookie).toMatch(/^__Host-toi_session=[A-Za-z0-9_.-]+; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/);
    expect(cookie).not.toMatch(/domain=/i);
    expect(h.exchanges).toHaveLength(1);
    expect(h.exchanges[0]?.host).toBe(HOST_A);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("consumes the login state so the same callback URL cannot be replayed in this browser", async () => {
    const { response } = await callback({});
    const cleared = cookies(response).find((c) => c.startsWith(`__Host-${LOGIN_STATE_COOKIE_BASE}=`)) ?? "";
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).not.toMatch(/domain=/i);
  });

  // Acceptance item: a callback URL for tenant A replayed on tenant B's host fails, without the
  // provider ever being contacted.
  it("refuses tenant A's link and state cookie on tenant B's host", async () => {
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const { response, h } = await callback({
      host: HOST_B,
      cookieHeader: `${loginState.cookie.name}=${loginState.cookie.value}`,
      state: loginState.nonce,
    });
    expect(response.status).toBe(303);
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(locationOf(response).host).toBe(HOST_B);
    expect(h.exchanges).toHaveLength(0);
    expect(h.memberships).toHaveLength(0);
    expect(sessionCookie(response)).toBe("");
  });

  it("refuses a link opened in a browser that never asked for one", async () => {
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    for (const cookieHeader of [null, "theme=dark"]) {
      const { response, h } = await callback({ cookieHeader, state: loginState.nonce });
      expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
      expect(h.exchanges).toHaveLength(0);
      expect(sessionCookie(response)).toBe("");
    }
  });

  it("refuses a callback whose state parameter was swapped for another", async () => {
    const mine = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const theirs = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const { response, h } = await callback({
      cookieHeader: `${mine.cookie.name}=${mine.cookie.value}`,
      state: theirs.nonce,
    });
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(h.exchanges).toHaveLength(0);
  });

  it("refuses an expired login state", async () => {
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const h = harness();
    h.ports = { ...h.ports, now: () => NOW + 601 };
    const response = await completeMagicLink({
      request: new Request(`https://${HOST_A}/auth/callback?code=synthetic&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
      }),
      ports: h.ports,
    });
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(h.exchanges).toHaveLength(0);
  });

  // Acceptance item: an expired or already-used link gives a safe error, no session, no tenant data.
  it("an invalid, expired or already-used code grants nothing", async () => {
    const { response, h } = await callback({ configure: (state) => { state.identity = { ok: false, reason: "invalid_or_expired" }; } });
    expect(response.status).toBe(303);
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(locationOf(response).pathname).toBe("/login");
    expect(sessionCookie(response)).toBe("");
    expect(h.memberships).toHaveLength(0);
    expect(cookies(response).join("\n")).not.toContain("toi_session");
  });

  it("refuses a callback with no code, or with no state parameter", async () => {
    const noCode = await callback({ code: null });
    expect(locationOf(noCode.response).searchParams.get("outcome")).toBe("unavailable");
    expect(noCode.h.exchanges).toHaveLength(0);
    expect(sessionCookie(noCode.response)).toBe("");

    const noState = await callback({ state: null });
    expect(locationOf(noState.response).searchParams.get("outcome")).toBe("unavailable");
    expect(noState.h.exchanges).toHaveLength(0);
    expect(sessionCookie(noState.response)).toBe("");
  });

  it("refuses an identity whose email the provider did not verify", async () => {
    const { response, h } = await callback({
      configure: (state) => {
        state.identity = { ok: true, userId: INVITED, email: "user@example.test", emailVerified: false };
      },
    });
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(sessionCookie(response)).toBe("");
    expect(h.memberships).toHaveLength(0);
    expect(h.redeemed).toHaveLength(0);
  });

  it("claims an invited membership with the canonical address, never the raw one", async () => {
    const { response, h } = await callback({
      configure: (state) => {
        state.identity = { ok: true, userId: INVITED, email: " User@Example.test ", emailVerified: true };
        state.membershipFor = (organisationId, userId, callIndex) =>
          organisationId === C1 && userId === INVITED
            ? { membershipId: MEMBERSHIP, status: callIndex > 1 ? "active" : "invited", roles: ["member"], permittedServiceKeys: [], permittedProjectIds: [] }
            : null;
      },
    });
    expect(h.redeemed).toHaveLength(1);
    const claim = h.redeemed[0] as { organisationId: string; userId: string; email: string };
    expect(claim.email).toBe("user@example.test");
    expect(claim.email).toBe(claim.email.trim().toLowerCase());
    expect(claim.organisationId).toBe(C1);
    expect(claim.userId).toBe(INVITED);
    // The handler does not take "redeemed" on trust: it re-reads current membership state.
    expect(h.memberships.length).toBeGreaterThanOrEqual(2);
    expect(locationOf(response).pathname).toBe("/");
    expect(sessionCookie(response)).toContain("__Host-toi_session=");
  });

  it("an invite cannot be redeemed on another tenant", async () => {
    const { response, h } = await callback({
      host: HOST_B,
      configure: (state) => {
        state.identity = { ok: true, userId: INVITED, email: "user@example.test", emailVerified: true };
      },
    });
    expect(locationOf(response).searchParams.get("outcome")).toBe("not_a_member");
    // company2 is the organization under discussion, because company2 is the host that was routed.
    expect(h.memberships).toEqual([`${C2}:${INVITED}`]);
    expect(h.redeemed).toHaveLength(0);
    expect(locationOf(response).pathname).toBe("/login");
    expect(locationOf(response).host).toBe(HOST_B);
  });

  it("a failed invite claim still grants only a session, never access", async () => {
    const { response, h } = await callback({
      configure: (state) => {
        state.identity = { ok: true, userId: INVITED, email: "someone@example.test", emailVerified: true };
        state.redeemResult = "email_mismatch";
      },
    });
    expect(h.redeemed).toHaveLength(1);
    expect(locationOf(response).searchParams.get("outcome")).toBe("not_a_member");
    expect(locationOf(response).pathname).toBe("/login");
    expect(sessionCookie(response)).toContain("__Host-toi_session=");
  });

  it("a suspended membership gets the no-access outcome and no redemption attempt", async () => {
    const { response, h } = await callback({
      configure: (state) => {
        state.identity = { ok: true, userId: LEFT, email: "left@company1.test", emailVerified: true };
      },
    });
    expect(locationOf(response).searchParams.get("outcome")).toBe("not_a_member");
    expect(h.redeemed).toHaveLength(0);
    expect(sessionCookie(response)).toContain("__Host-toi_session=");
  });

  it("ignores a redirect target carried in the callback query", async () => {
    const { response } = await callback({ query: { redirect_to: "https://evil.example/x", next: "//evil.example" } });
    expect(locationOf(response).host).toBe(HOST_A);
    expect(locationOf(response).pathname).toBe("/");
    expect(response.headers.getSetCookie().join("\n")).not.toContain("evil.example");
  });

  it("takes the PKCE verifier from the login-state cookie and never from the request", async () => {
    const { h } = await callback({ query: { code_verifier: "attacker-supplied-verifier-00000000000000000" } });
    expect(h.exchanges).toHaveLength(1);
    const verifier = h.exchanges[0]?.codeVerifier as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(verifier).not.toContain("attacker");
  });

  it("gives a host that is not a live tenant nothing at all", async () => {
    const { response, h } = await callback({ host: "nosuch.terraoi.app" });
    expect(response.status).toBe(404);
    expect(h.exchanges).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("a provider or database failure fails closed with no session", async () => {
    const { response, h } = await callback({ configure: (state) => { state.boom = true; } });
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(h.exchanges).toHaveLength(0);
    expect(sessionCookie(response)).toBe("");
  });

  it("without a signing secret nobody is signed in", async () => {
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const h = harness();
    h.ports = { ...h.ports, signingSecret: () => null };
    const response = await completeMagicLink({
      request: new Request(`https://${HOST_A}/auth/callback?code=synthetic&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
      }),
      ports: h.ports,
    });
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(h.exchanges).toHaveLength(0);
    expect(sessionCookie(response)).toBe("");
  });

  it("the session it issues is scoped to the host that was routed, not to the parent domain", async () => {
    const { response } = await callback({});
    const setCookies = cookies(response).join("\n");
    expect(setCookies).not.toMatch(/domain=/i);
    expect(setCookies).toContain("__Host-");
    const session = sessionCookie(response).split(";")[0] as string;
    const read = await import("./session");
    const outcome = await read.readSession({ cookieHeader: session, host: HOST_B, secret: SECRET, now: NOW });
    expect(outcome).toEqual({ ok: false, reason: "host_mismatch" });
  });
});
