import { describe, expect, it } from "vitest";

import { completeMagicLink, type MagicLinkCallbackPorts } from "./complete-magic-link";
import { createLoginState, LOGIN_STATE_COOKIE_BASE } from "./login-state";
import {
  checkEntraIdentity,
  decideEntraLink,
  handleEntraSignInRequest,
  isEntraIdentity,
  type EntraStartPorts,
} from "./entra-linking";
import { issueCsrfToken } from "./csrf";
import { sha256Base64Url, verifyToken } from "./signed-token";
import { SESSION_COOKIE_BASE } from "./session";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";

/**
 * T-201's Entra items. Supabase's Entra (Azure) provider completes through the *same* PKCE callback
 * as the magic link, so what this packet adds is the linking policy on top of that path — and the
 * policy is where the four rules live (plan §4.2, F02, F05):
 *
 *   * link to the invited `profiles` row **only** on a provider-verified email match;
 *   * an unverified provider email is never auto-linked;
 *   * a verified Microsoft account with no membership row gets only the no-access surface;
 *   * a tenant allow-listed to one Entra tenant ID refuses an account from anywhere else.
 *
 * The allow-list itself is not in the merged schema, so the read is a port that answers "unresolved"
 * until PR-2's migration lands, and unresolved means **refuse**: a tenant with no recorded Entra
 * policy has no permitted Entra issuer, which is the same answer as an empty allow-list.
 */

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000" } };
const NOW = 1_800_000_000;
const HOST_A = "company1.terraoi.app";
const HOST_B = "company2.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const INVITED_USER = "00000000-0000-4000-8000-0000000000c1";
const NOBODY = "00000000-0000-4000-8000-0000000000d1";
const TENANT_ALLOWED = "6f1e0000-0000-4000-8000-0000000000aa";
const TENANT_OUTSIDE = "7a2e0000-0000-4000-8000-0000000000bb";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

function fakeJwt(what: string, sub: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT"}')}.${b64(`{"sub":"${sub}"}`)}.${b64(`synthetic-signature-${what}`)}`;
}
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

interface EntraExchange {
  ok: true;
  userId: string;
  email: string;
  emailVerified: boolean;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  provider?: string;
  issuerTenantId?: string | null;
}

function entraIdentity(overrides: Partial<EntraExchange> = {}): EntraExchange {
  const userId = overrides.userId ?? INVITED_USER;
  return {
    ok: true,
    userId,
    email: "Field2@Company1.test",
    emailVerified: true,
    accessToken: fakeJwt("access", userId),
    refreshToken: fakeJwt("refresh", userId),
    tokenExpiresAt: NOW + 3600,
    provider: "azure",
    issuerTenantId: TENANT_ALLOWED,
    ...overrides,
  };
}

type Membership = {
  membershipId: string;
  status: "invited" | "active" | "suspended" | "removed";
  roles: string[];
  permittedServiceKeys: string[];
  permittedProjectIds: string[];
};
const member = (status: Membership["status"]): Membership => ({
  membershipId: MEMBERSHIP,
  status,
  roles: status === "active" ? ["member"] : [],
  permittedServiceKeys: [],
  permittedProjectIds: [],
});

function memoryStore(): SessionStore & { rows: Map<string, StoredSession> } {
  const rows = new Map<string, StoredSession>();
  return {
    rows,
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
    async replaceTokens(sessionKey, replacement) {
      const row = rows.get(sessionKey);
      if (!row || row.revokedAt !== null) return false;
      rows.set(sessionKey, { ...row, ...replacement });
      return true;
    },
  };
}

interface Harness {
  ports: MagicLinkCallbackPorts;
  store: SessionStore & { rows: Map<string, StoredSession> };
  exchanges: Array<{ code: string; host: string }>;
  memberships: string[];
  redeemed: Array<{ organisationId: string; userId: string; email: string; accessToken: string }>;
  /** Every issuer-policy read: with which organization, and bearing whose credential. */
  issuerReads: Array<{ organisationId: string; accessToken: string }>;
  identity: EntraExchange | { ok: false; reason: "invalid_or_expired" };
  membershipFor: (organisationId: string, userId: string) => Membership | null;
  issuers: readonly string[] | null;
  issuersBoom: boolean;
  boom: boolean;
  /** Set once a claim has "succeeded", so the re-read sees the row as it is now. */
  promoted: boolean;
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const state: Harness = {
    exchanges: [],
    memberships: [],
    redeemed: [],
    issuerReads: [],
    identity: entraIdentity(),
    membershipFor: (organisationId, userId) =>
      organisationId === C1 && userId === INVITED_USER ? member(state.promoted ? "active" : "invited") : null,
    issuers: [TENANT_ALLOWED],
    issuersBoom: false,
    boom: false,
    promoted: false,
    ports: {} as MagicLinkCallbackPorts,
    store: memoryStore(),
  };
  Object.assign(state, overrides);
  state.ports = {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => state.store,
    tokenCipher: () => createTokenCipher(CIPHER),
    findHost: async (host) =>
      host === HOST_A
        ? { organisationId: C1, organisationStatus: "active" }
        : host === HOST_B
          ? { organisationId: C2, organisationStatus: "active" }
          : null,
    exchangeLoginCode: async (input) => {
      if (state.boom) throw new Error("entra provider unavailable");
      state.exchanges.push({ code: input.code, host: input.host });
      return state.identity;
    },
    findMembership: async (organisationId, accessToken) => {
      const userId = state.identity.ok && state.identity.accessToken === accessToken ? state.identity.userId : "";
      state.memberships.push(`${organisationId}:${userId}`);
      return state.membershipFor(organisationId, userId);
    },
    redeemInvitation: async (input) => {
      state.redeemed.push(input);
      // The claim RPC is PR-2's SQL and is tested there (pgTAP slot 012). This fake promotes the row it
      // was handed so what this file tests is the linking decision and not the SQL — and it records the
      // whole input, which is where "the claim carries the caller's own credential" is pinned.
      state.promoted = true;
      return "redeemed";
    },
    allowedEntraIssuers: async (organisationId, accessToken) => {
      state.issuerReads.push({ organisationId, accessToken });
      if (state.issuersBoom) throw new Error("policy read unavailable");
      return organisationId === C1 ? state.issuers : [];
    },
  };
  return state;
}

async function callback(input: { host?: string; attempt?: "entra"; configure?: (h: Harness) => void } = {}) {
  const h = harness();
  if (input.configure) input.configure(h);
  const host = input.host ?? HOST_A;
  // `attempt: "entra"` is what `handleEntraSignInRequest` writes into the carrier: the fact that **this
  // host** sent this browser to Microsoft, which the callback can rely on and the payload cannot supply.
  const loginState = await createLoginState({ host, secret: SECRET, now: NOW, secureTransport: true, ...(input.attempt ? { provider: input.attempt } : {}) });
  const response = await completeMagicLink({
    request: new Request(`https://${host}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
      headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
    }),
    ports: h.ports,
  });
  return { response, h };
}

const locationOf = (response: Response) => new URL(response.headers.get("location") as string);
const cookiesOf = (response: Response) => response.headers.getSetCookie();
const sessionCookieOf = (response: Response) =>
  cookiesOf(response).find((c) => c.startsWith(SESSION_COOKIE_BASE) || c.startsWith(`__Host-${SESSION_COOKIE_BASE}`)) ?? "";
const outcomeOf = (response: Response) => locationOf(response).searchParams.get("outcome");

describe("decideEntraLink: the policy, in isolation", () => {
  it("links on a provider-verified email from an allow-listed Entra tenant", () => {
    expect(decideEntraLink({ emailVerified: true, issuerTenantId: TENANT_ALLOWED, allowedIssuers: [TENANT_ALLOWED] })).toEqual({ ok: true });
  });

  it("never links on an email the provider did not verify", () => {
    expect(decideEntraLink({ emailVerified: false, issuerTenantId: TENANT_ALLOWED, allowedIssuers: [TENANT_ALLOWED] })).toEqual({
      ok: false,
      reason: "unverified_email",
    });
  });

  it("refuses an issuer outside the allow-list", () => {
    expect(decideEntraLink({ emailVerified: true, issuerTenantId: TENANT_OUTSIDE, allowedIssuers: [TENANT_ALLOWED] })).toEqual({
      ok: false,
      reason: "issuer_not_allowed",
    });
  });

  it("refuses when the identity carries no issuer at all: no claim, no allowance", () => {
    for (const issuer of [null, undefined, ""]) {
      expect(decideEntraLink({ emailVerified: true, issuerTenantId: issuer, allowedIssuers: [TENANT_ALLOWED] })).toEqual({
        ok: false,
        reason: "issuer_unknown",
      });
    }
  });

  it("treats an unresolved or empty policy as no permitted issuer, never as no restriction", () => {
    for (const allowed of [null, []]) {
      expect(decideEntraLink({ emailVerified: true, issuerTenantId: TENANT_ALLOWED, allowedIssuers: allowed })).toEqual({
        ok: false,
        reason: allowed === null ? "policy_unresolved" : "issuer_not_allowed",
      });
    }
  });

  it("compares issuer ids exactly, not by prefix or case", () => {
    for (const lookAlike of [TENANT_ALLOWED.slice(0, -1), TENANT_ALLOWED.toUpperCase(), `${TENANT_ALLOWED}-evil`]) {
      expect(decideEntraLink({ emailVerified: true, issuerTenantId: TENANT_ALLOWED, allowedIssuers: [lookAlike] })).toEqual({
        ok: false,
        reason: "issuer_not_allowed",
      });
    }
  });

  it("recognizes only the Entra provider keys, so an email or Google identity is never gated as Entra", () => {
    expect(isEntraIdentity("azure")).toBe(true);
    expect(isEntraIdentity("microsoft")).toBe(true);
    expect(isEntraIdentity("email")).toBe(false);
    expect(isEntraIdentity(undefined)).toBe(false);
    expect(isEntraIdentity("Azure")).toBe(false);
  });
});

describe("checkEntraIdentity: the policy against its read", () => {
  it("refuses when the read itself fails, instead of treating an outage as no restriction", async () => {
    const identity = entraIdentity();
    const outcome = await checkEntraIdentity({
      identity,
      organisationId: C1,
      accessToken: identity.accessToken,
      ports: { allowedEntraIssuers: async () => { throw new Error("policy read down"); } },
    });
    // Pinned to the reason, not just to "refused": an implementation that reported a failed policy read
    // as `issuer_unknown` would be describing the identity rather than its own outage, and the operator
    // log line that distinguishes the two would be wrong.
    expect(outcome).toEqual({ ok: false, reason: "policy_unresolved" });
  });

  it("refuses when the port has no implementation at all (a deployment with no Data API)", async () => {
    // The shape `buildIdentityPorts` actually produces without `SUPABASE_URL`/`SUPABASE_ANON_KEY`: the
    // port is absent, not present-and-throwing. Absent still refuses, so a half-configured deployment
    // cannot hand an identity past the gate.
    const identity = entraIdentity();
    expect(
      await checkEntraIdentity({ identity, organisationId: C1, accessToken: identity.accessToken, ports: {} }),
    ).toEqual({ ok: false, reason: "policy_unresolved" });
  });
});

describe("the Entra leg of GET /auth/callback", () => {
  it("links an Entra sign-in to the invited row: one identity, one membership, one session", async () => {
    const { response, h } = await callback();
    expect(response.status).toBe(303);
    expect(locationOf(response).pathname).toBe("/");
    expect(locationOf(response).host).toBe(HOST_A);

    // The claim names the existing identity and the host's organization, with the canonical verified
    // address: it links, it does not create.
    expect(h.redeemed).toHaveLength(1);
    const claim = h.redeemed[0] as { organisationId: string; userId: string; email: string; accessToken: string };
    expect(claim).toEqual({
      organisationId: C1,
      userId: INVITED_USER,
      email: "field2@company1.test",
      // The claim is made with the identity the provider just verified, which is the only credential
      // `redeem_invitation_v1` can answer for: it takes no user argument and reads its subject from this
      // bearer (`auth.uid()`), so a call bearing anything else could not claim this row.
      accessToken: fakeJwt("access", INVITED_USER),
    });

    // The issuer policy was read with that same identity's token, once, for the routed organization only
    // — the RPC behind it is granted to `authenticated` and refused to `anon` (012 assertions 39-41).
    expect(h.issuerReads).toEqual([{ organisationId: C1, accessToken: fakeJwt("access", INVITED_USER) }]);

    // One session row, for the identity the provider already had: no second profile, no second id.
    expect(h.store.rows.size).toBe(1);
    const row = [...h.store.rows.values()][0] as StoredSession;
    expect(row.userId).toBe(INVITED_USER);
    expect(row.host).toBe(HOST_A);
    // Only company1 was ever read: the host that was routed, nothing else.
    expect([...new Set(h.memberships.map((m) => m.split(":")[0]))]).toEqual([C1]);
    expect(sessionCookieOf(response)).toMatch(/^__Host-toi_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/);
    expect(cookiesOf(response).join("\n")).not.toMatch(/domain=/i);
  });

  it("an unverified provider email is never auto-linked: no claim, no membership read, no session", async () => {
    const { response, h } = await callback({
      configure: (s) => {
        s.identity = entraIdentity({ emailVerified: false });
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.redeemed).toHaveLength(0);
    expect(h.memberships).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(sessionCookieOf(response)).toBe("");
  });

  it("a Microsoft account with no membership row gets only the no-access surface", async () => {
    const { response, h } = await callback({
      configure: (s) => {
        s.identity = entraIdentity({ userId: NOBODY, email: "someone@else.example.test" });
        s.membershipFor = () => null;
      },
    });
    expect(outcomeOf(response)).toBe("not_a_member");
    expect(locationOf(response).pathname).toBe("/login");
    expect(h.redeemed).toHaveLength(0);
    // Identity proves who, membership decides whether: a live session row and no access.
    expect(h.store.rows.size).toBe(1);
    expect([...h.store.rows.values()][0]?.userId).toBe(NOBODY);
  });

  it("a tenant allow-listed to one Entra tenant ID refuses an outside account, reading nothing", async () => {
    const { response, h } = await callback({
      configure: (s) => {
        s.identity = entraIdentity({ issuerTenantId: TENANT_OUTSIDE });
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.memberships).toHaveLength(0);
    expect(h.redeemed).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(sessionCookieOf(response)).toBe("");
    // The provider was still contacted (it decides who the identity is); no tenant data followed.
    expect(h.exchanges).toHaveLength(1);
  });

  it("a tenant with no Entra policy configured refuses, and so does an unreadable policy", async () => {
    for (const configure of [
      (s: Harness) => {
        s.issuers = [];
      },
      (s: Harness) => {
        s.issuers = null;
      },
      (s: Harness) => {
        s.issuersBoom = true;
      },
    ]) {
      const { response, h } = await callback({ configure });
      expect(outcomeOf(response)).toBe("unavailable");
      expect(h.memberships).toHaveLength(0);
      expect(h.store.rows.size).toBe(0);
      expect(sessionCookieOf(response)).toBe("");
    }
  });

  it("a deployment with no issuer read at all grants nothing: an absent port is still a refusal", async () => {
    // `buildIdentityPorts` installs `allowedEntraIssuers` only where the Data API is configured, so this
    // is the real deployment shape for a host without it — and the callback must not treat "I could not
    // look" as "nothing to check". The SQL half is PR-2's; a missing port is a wiring fact either way.
    const { response, h } = await callback({
      configure: (s) => {
        delete s.ports.allowedEntraIssuers;
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.issuerReads).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(sessionCookieOf(response)).toBe("");
  });

  it("an Entra outage gives the generic failure and no partial session", async () => {
    const { response, h } = await callback({
      configure: (s) => {
        s.boom = true;
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.exchanges).toHaveLength(0);
    expect(h.memberships).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(sessionCookieOf(response)).toBe("");
    const wire = `${await response.text()}${cookiesOf(response).join("\n")}${response.headers.get("location") ?? ""}`;
    expect(wire).not.toMatch(JWT_IN_TEXT);
    expect(wire.toLowerCase()).not.toContain("entra");
  });

  it("a magic-link identity is untouched by the Entra gate: no issuer, no policy read, no refusal", async () => {
    const { response, h } = await callback({
      configure: (s) => {
        s.identity = entraIdentity({ provider: "email", issuerTenantId: null, email: "owner1@company1.test", userId: "00000000-0000-4000-8000-0000000000a1" });
        s.membershipFor = (organisationId, userId) => (organisationId === C1 && userId === "00000000-0000-4000-8000-0000000000a1" ? member("active") : null);
        // No policy read available at all: a mail identity completes anyway, because the email provider
        // has no issuer to allow-list. The gate is keyed on the provider, not on whether a policy exists.
        delete s.ports.allowedEntraIssuers;
      },
    });
    expect(locationOf(response).pathname).toBe("/");
    expect(sessionCookieOf(response)).toContain("__Host-toi_session=");
    expect(h.redeemed).toHaveLength(0);
    expect(h.issuerReads).toHaveLength(0);
  });

  it("an Entra **attempt** whose payload comes back labelled `email` is still gated — the carrier decides, not the label", async () => {
    // The case the payload label alone cannot see: Supabase attaches a Microsoft identity to an account
    // that already exists as a mail one, and `app_metadata.provider` stays `"email"`. The gate is keyed
    // on this host's own record of where it sent the browser, so the issuer policy is consulted — and
    // with no issuer on the payload there is nothing to allow-list, so the identity is refused. The
    // tenant's membership row is not the only thing standing between a non-permitted identity and a
    // session, which is what the packet's fourth policy sentence requires.
    const { response, h } = await callback({
      attempt: "entra",
      configure: (s) => {
        s.identity = entraIdentity({ provider: "email", issuerTenantId: null, email: "owner1@company1.test", userId: "00000000-0000-4000-8000-0000000000a1" });
        s.membershipFor = (organisationId, userId) => (organisationId === C1 && userId === "00000000-0000-4000-8000-0000000000a1" ? member("active") : null);
        s.issuers = [TENANT_ALLOWED]; // a policy that exists and would allow its own tenant
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(sessionCookieOf(response)).toBe("");
    expect(h.store.rows.size).toBe(0);
    // Refused at the gate, so no tenant data was read and no invitation was touched.
    expect(h.memberships).toHaveLength(0);
    expect(h.redeemed).toHaveLength(0);
  });

  it("a payload the provider itself calls `azure` is gated even when the carrier said nothing", async () => {
    // The label can keep the gate open; it can never close it. A `state` from an ordinary (mail) login
    // attempt carrying an Entra-labelled identity is still put through the policy.
    const { response, h } = await callback({
      configure: (s) => {
        s.identity = entraIdentity({ provider: "azure", issuerTenantId: TENANT_OUTSIDE, email: "owner1@company1.test", userId: "00000000-0000-4000-8000-0000000000a1" });
        s.membershipFor = (organisationId, userId) => (organisationId === C1 && userId === "00000000-0000-4000-8000-0000000000a1" ? member("active") : null);
        s.issuers = [TENANT_ALLOWED];
      },
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(h.store.rows.size).toBe(0);
    expect(h.memberships).toHaveLength(0);
  });

  it("an Entra callback for company1 replayed on company2's host never reaches the provider", async () => {
    const loginState = await createLoginState({ host: HOST_A, secret: SECRET, now: NOW, secureTransport: true });
    const h = harness();
    const response = await completeMagicLink({
      request: new Request(`https://${HOST_B}/auth/callback?code=synthetic-code&state=${loginState.nonce}`, {
        headers: new Headers({ cookie: `${loginState.cookie.name}=${loginState.cookie.value}` }),
      }),
      ports: h.ports,
    });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(locationOf(response).host).toBe(HOST_B);
    expect(h.exchanges).toHaveLength(0);
    expect(h.memberships).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(cookiesOf(response).find((c) => c.includes(SESSION_COOKIE_BASE))).toBeUndefined();
  });
});

describe("handleEntraSignInRequest (POST /auth/entra)", () => {
  const BASE = "https://synthetic-project.supabase.co";

  function startPorts(overrides: Partial<EntraStartPorts> = {}): EntraStartPorts {
    return {
      now: () => NOW,
      signingSecret: () => SECRET,
      findHost: async (host) =>
        host === HOST_A ? { organisationId: C1, organisationStatus: "active" } : host === HOST_B ? { organisationId: C2, organisationStatus: "active" } : null,
      rateLimitKey: async ({ host }) => `${host}|entra`,
      allowRequest: async () => true,
      supabaseBaseUrl: () => BASE,
      // Present here so the *guard* and *redirect-building* tests exercise a wired deployment; the
      // unwired state — the one the production adapter is in until PR-2 — has its own test below.
      allowedEntraIssuers: async () => [TENANT_ALLOWED],
      ...overrides,
    };
  }

  async function start(input: { host?: string; csrf?: string | null; extra?: Record<string, string>; origin?: string | null; ports?: EntraStartPorts } = {}) {
    const host = input.host ?? HOST_A;
    const csrf = input.csrf === null ? undefined : (input.csrf ?? (await issueCsrfToken({ host, secret: SECRET, now: NOW })));
    const params = new URLSearchParams(input.extra ?? {});
    if (csrf !== undefined) params.set("csrf_token", csrf);
    const headers = new Headers();
    if (input.origin !== null) headers.set("origin", input.origin ?? `https://${host}`);
    headers.set("content-type", "application/x-www-form-urlencoded");
    const response = await handleEntraSignInRequest({
      request: new Request(`https://${host}/auth/entra`, { method: "POST", headers, body: params.toString() }),
      ports: input.ports ?? startPorts(),
    });
    return { response };
  }

  it("sends the browser to the project's Entra authorize URL with a host-exact callback and PKCE", async () => {
    const { response } = await start();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${BASE}/auth/v1/authorize`);
    expect(location.searchParams.get("provider")).toBe("azure");
    const redirectTo = location.searchParams.get("redirect_to") as string;
    // F05: the callback URL is registered exactly — this host, this path, nothing the request chose.
    expect(new URL(redirectTo).origin).toBe(`https://${HOST_A}`);
    expect(new URL(redirectTo).pathname).toBe("/auth/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("s256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stateCookie = cookiesOf(response).find((c) => c.startsWith(`__Host-${LOGIN_STATE_COOKIE_BASE}=`)) ?? "";
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toMatch(/Max-Age=600/);
    expect(stateCookie).not.toMatch(/domain=/i);
    // The state the authorize URL carries is the one the issued cookie binds to — and the cookie is a
    // signed envelope, so the check decodes it rather than looking for a substring.
    const nonce = new URL(redirectTo).searchParams.get("state") as string;
    expect(nonce.length).toBeGreaterThan(20);
    // Verified, not merely decoded: the cookie the start sets must be a login state this host's own key
    // signs, bound to this host, whose `jti` is exactly the `state` the authorize URL carries.
    const cookieValue = stateCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    expect(cookieValue.length).toBeGreaterThan(0);
    const claims = await verifyToken(cookieValue, SECRET);
    expect(claims).not.toBeNull();
    expect(claims?.jti).toBe(nonce);
    expect(claims?.host).toBe(HOST_A);
    expect(claims?.typ).toBe("login_state");
    expect(claims?.flow).toBeUndefined();
    // This host's own record of where it sent the browser, which the callback's issuer gate is keyed
    // on. Not something the request or the provider payload can supply.
    expect(claims?.provider).toBe("entra");
    // And the challenge the IdP is given is *this* attempt's verifier, hashed — not merely the same
    // shape. A challenge that drifted from the verifier is how a PKCE exchange stops meaning anything.
    const pkce = claims?.pkce;
    expect(typeof pkce).toBe("string");
    expect(location.searchParams.get("code_challenge")).toBe(await sha256Base64Url(pkce as string));
  });

  it("with no issuer read available there is no hand-off to Microsoft and no half-set state", async () => {
    // The deployment shape `buildIdentityPorts` produces without `SUPABASE_URL`/`SUPABASE_ANON_KEY`: the
    // port is absent, so the policy cannot be read, and the attempt would end at a refusal *after* a
    // round trip through the IdP. Refusing here is what keeps that trip from being taken on the user's
    // behalf. The SQL half landed in PR-2; what stays conditional is the wiring, and the port stays
    // optional rather than becoming a stub that throws.
    const { response } = await start({ ports: startPorts({ allowedEntraIssuers: undefined }) });
    expect(outcomeOf(response)).toBe("unavailable");
    expect(response.headers.get("location")).toContain("/login");
    expect(cookiesOf(response)).toHaveLength(0);
    const wire = `${response.headers.get("location") ?? ""}${cookiesOf(response).join("\n")}`;
    expect(wire).not.toContain("supabase.co");
    expect(wire).not.toMatch(JWT_IN_TEXT);
  });

  it("takes nothing about the destination from the request", async () => {
    const { response } = await start({
      extra: { redirect_to: "https://evil.example/auth/callback", provider: "google", tenant: TENANT_OUTSIDE, next: "//evil.example" },
    });
    const location = new URL(response.headers.get("location") as string);
    expect(location.searchParams.get("provider")).toBe("azure");
    expect(location.searchParams.get("redirect_to")).toContain(`https://${HOST_A}/auth/callback`);
    expect(location.searchParams.get("tenant")).toBeNull();
    expect(`${location.origin}${location.pathname}`).toBe(`${BASE}/auth/v1/authorize`);
    expect(cookiesOf(response).join("\n")).not.toContain("evil.example");
  });

  it("without a configured project URL there is no redirect and no half-set state", async () => {
    for (const bad of [() => null, () => "not a url", () => "http://insecure.example"]) {
      const { response } = await start({ ports: startPorts({ supabaseBaseUrl: bad }) });
      expect(outcomeOf(response)).toBe("unavailable");
      expect(response.status).toBe(303);
      expect(cookiesOf(response)).toHaveLength(0);
    }
  });

  it("keeps the same guard chain as every other sign-in start", async () => {
    expect((await start({ origin: "https://evil.example" })).response.status).toBe(403);
    expect((await start({ csrf: null })).response.status).toBe(403);
    expect((await start({ host: "nosuch.terraoi.app" })).response.status).toBe(404);
    const limited = await start({ ports: startPorts({ allowRequest: async () => false }) });
    expect(outcomeOf(limited.response)).toBe("rate_limited");
    expect(limited.response.status).toBe(303);
  });
});
