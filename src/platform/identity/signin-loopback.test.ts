import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { buildIdentityPorts, type IdentityEnv } from "./adapters";
import { handlePasswordSignIn } from "./password-signin";
import { issueCsrfToken } from "./csrf";
import { SESSION_COOKIE_BASE } from "./session";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";
import { sha256Base64Url } from "./signed-token";

/**
 * Loopback harness (COORDINATION.md §6a) for the cross-tenant and deactivated-member claims of
 * T-201's sign-in methods: a plain Node `http` listener on `127.0.0.1` with `listen(0)`, closed in
 * `afterAll`, driven by the **real** `fetch` — `buildIdentityPorts` is called with no `fetchImpl`
 * injected, so everything asserted below is what actually crossed the socket, not what a fake was
 * asked to remember.
 *
 * What it proves: the organization id that reaches PostgREST is the routed host's and nothing else —
 * a value planted in the form body, the query or a cookie changes no byte on the wire; the credential
 * on the membership read is the signed-in user's own access token, never the anon key and never a
 * privileged one; a `28000` refusal over a real socket ends at the generic surface with **no session
 * cookie** and none of the database's words; and no Supabase-JWT-shaped value reaches the browser even
 * though the provider handed this process real-shaped tokens (ADR-0003 §8).
 *
 * What it does not prove: the session row itself. `toi_identity` is reached over the Hyperdrive
 * `SESSION_DB` binding as `toi_session_worker`, which cannot be dialed from a Node listener, so the
 * row is an in-memory store here and the SQL half of that claim is pgTAP's (slot 014 and this packet's
 * 012) — run only in CI, since no builder machine has Docker (FAQ-0009). And no box naming staging is
 * ticked: the staging runs are owner steps under T-004, blocked repo-wide while #177 is open.
 */

const ORG_COMPANY1 = "11111111-1111-4111-8111-111111111111";
const ORG_COMPANY2 = "22222222-2222-4222-8222-222222222222";
const HOST_COMPANY1 = "company1.terraoi.app";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const LEFT = "00000000-0000-4000-8000-0000000000a3";
const NOW = 1_800_000_000;

const SIGNING_KEY = "synthetic-loopback-signing-key-not-a-real-key-0000";
const ANON_KEY_CANARY = "synthetic-anon-key-canary-not-a-real-key";
// A synthetic JWT in the *shape* of a privileged Supabase key, named canary so nobody reads it as a
// credential (AGENTS.md §4.6). It exists so a wiring that hands a privileged key to a sign-in call is
// reported on the socket instead of caught by eye in review.
function fakeJwt(sub: string, role: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64(`{"alg":"ES256","typ":"JWT","role":"${role}"}`)}.${b64(`{"sub":"${sub}","exp":1800003600}`)}.${b64(`synthetic-signature-${sub}`)}`;
}
const SERVICE_ROLE_CANARY = fakeJwt("service-role-canary", "service_role");
const DB_TEXT = "not an active member of this organization (detail: pooler postgres://inner-host:5432/prod)";
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

interface Captured {
  method: string;
  url: string;
  rawHeaders: string[];
  headerText: string;
  body: string;
}

let server: Server;
let origin = "";
const captured: Captured[] = [];
/** Which identity the fake provider hands back, and which organization the membership read answers for. */
let providerUser: { id: string; email: string; confirmed: boolean } = { id: OWNER1, email: "Owner1@Company1.test", confirmed: true };
let providerRefuses = false;
let membershipStatus: "active" | "suspended" | "removed" = "active";
let membershipRefuses = false;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const rawHeaders = req.rawHeaders ?? [];
      captured.push({ method: req.method ?? "", url: req.url ?? "", rawHeaders, headerText: rawHeaders.join("\n"), body });

      const path = req.url ?? "";
      if (path.startsWith("/auth/v1/token")) {
        if (providerRefuses) return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        return send(res, 200, {
          access_token: fakeJwt(providerUser.id, "authenticated"),
          refresh_token: fakeJwt(`${providerUser.id}-refresh`, "authenticated"),
          expires_in: 3600,
          token_type: "bearer",
          user: {
            id: providerUser.id,
            email: providerUser.email,
            email_confirmed_at: providerUser.confirmed ? new Date().toISOString() : null,
            app_metadata: { provider: "email" },
          },
        });
      }
      // Recovery (#201 / #181 B4): accept so the loopback can pin the exact recover query and body.
      if (path.startsWith("/auth/v1/recover")) {
        return send(res, 200, {});
      }
      if (path.startsWith("/rpc/resolve_tenant_host")) {
        const host = (JSON.parse(body || "{}") as Record<string, unknown>)["p_host"];
        if (host !== HOST_COMPANY1) return send(res, 200, []);
        return send(res, 200, [{ organisation_id: ORG_COMPANY1, organisation_status: "active" }]);
      }
      if (path.startsWith("/rpc/current_membership_v1")) {
        const organisation = (JSON.parse(body || "{}") as Record<string, unknown>)["p_organisation_id"];
        if (membershipRefuses || organisation !== ORG_COMPANY1) {
          return send(res, 401, { code: "28000", message: DB_TEXT, details: DB_TEXT });
        }
        return send(res, 200, [{ membership_id: "55555555-5555-4555-8555-555555555555", organisation_id: organisation, status: membershipStatus }]);
      }
      return send(res, 404, { code: "404", message: "no such path on this listener" });
    })().catch(() => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
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

/**
 * The real deployment wiring over a real socket; only the session row is swapped for an in-memory
 * store, because `SESSION_DB` is a Hyperdrive binding a Node listener cannot answer. Everything else —
 * host resolution, the credential exchange, the membership read — is `buildIdentityPorts` with its own
 * `fetch`.
 */
function ports(store: SessionStore & { rows: Map<string, StoredSession> }) {
  const env: Partial<IdentityEnv> & { SUPABASE_SERVICE_ROLE_KEY: string } = {
    SUPABASE_URL: origin,
    SUPABASE_ANON_KEY: ANON_KEY_CANARY,
    IDENTITY_SESSION_KEY: SIGNING_KEY,
    IDENTITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SESSION_TOKEN_KEY: "synthetic-loopback-token-key-not-a-real-key-0000",
    // Planted on purpose, and unused by `buildIdentityPorts` (it has no such binding). Without it the
    // "no service-role key on the wire" assertion would be a tautology — nothing could have put one
    // there. With it, the assertion checks what this call path actually sends, and the day someone
    // wires a privileged key into sign-in, this is the test that notices.
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_CANARY,
  };
  const built = buildIdentityPorts(env, {});
  return {
    ...built,
    sessionStore: () => store,
    tokenCipher: () => createTokenCipher({ currentVersion: "v1", keys: { v1: "synthetic-loopback-token-key-not-a-real-key-0000" } }),
  };
}

async function signInPost(input: { fields?: Record<string, string>; extraQuery?: string; cookieHeader?: string } = {}) {
  const store = memoryStore();
  const csrf = await issueCsrfToken({ host: HOST_COMPANY1, secret: SIGNING_KEY, now: NOW });
  const params = new URLSearchParams({ email: "owner1@company1.test", password: "correct horse battery staple", csrf_token: csrf, ...input.fields });
  const response = await handlePasswordSignIn({
    request: new Request(`https://${HOST_COMPANY1}/auth/password${input.extraQuery ?? ""}`, {
      method: "POST",
      headers: {
        origin: `https://${HOST_COMPANY1}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(input.cookieHeader ? { cookie: input.cookieHeader } : {}),
      },
      body: params.toString(),
    }),
    ports: ports(store),
  });
  return { response, store };
}

function headerValues(call: Captured, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < call.rawHeaders.length; i += 2) {
    if ((call.rawHeaders[i] as string).toLowerCase() === name) out.push(call.rawHeaders[i + 1] as string);
  }
  return out;
}

const callsTo = (path: string) => captured.filter((call) => call.url.startsWith(path));
const wireText = (call: Captured) => [call.method, call.url, call.headerText, call.body].join("\n");
const cookiesOf = (response: Response) => response.headers.getSetCookie();
const sessionCookieOf = (response: Response) =>
  cookiesOf(response).find((c) => c.startsWith(SESSION_COOKIE_BASE) || c.startsWith(`__Host-${SESSION_COOKIE_BASE}`)) ?? "";
const outcomeOf = (response: Response) => new URL(response.headers.get("location") as string).searchParams.get("outcome");

beforeAll(() => {
  captured.length = 0;
  providerUser = { id: OWNER1, email: "Owner1@Company1.test", confirmed: true };
  providerRefuses = false;
  membershipStatus = "active";
  membershipRefuses = false;
});

describe("loopback: what a password sign-in actually puts on the wire", () => {
  it("the credential exchange is one POST to GoTrue's password grant, with the canonical address", async () => {
    captured.length = 0;
    const { response } = await signInPost({ fields: { email: " Owner1@Company1.test " } });
    expect(response.status).toBe(303);
    const exchanges = callsTo("/auth/v1/token");
    expect(exchanges).toHaveLength(1);
    const call = exchanges[0] as Captured;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/auth/v1/token?grant_type=password");
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body["email"]).toBe("owner1@company1.test");
    expect(body["email"]).not.toBe(" Owner1@Company1.test ");
    expect(body["password"]).toBe("correct horse battery staple");
  });

  it("the only organization id that reaches PostgREST is the routed host's, whatever the request planted", async () => {
    captured.length = 0;
    await signInPost({
      fields: { organisation_id: ORG_COMPANY2, p_organisation_id: ORG_COMPANY2, host: "company2.terraoi.app", tenant: "company2" },
      extraQuery: `?organisation_id=${ORG_COMPANY2}&host=company2.terraoi.app`,
      cookieHeader: `org=${ORG_COMPANY2}; tenant_hint=company2`,
    });
    const reads = callsTo("/rpc/current_membership_v1");
    expect(reads).toHaveLength(1);
    const bodies = reads.map((call) => JSON.parse(call.body) as Record<string, unknown>);
    expect(bodies).toEqual([{ p_organisation_id: ORG_COMPANY1 }]);
    const hostReads = callsTo("/rpc/resolve_tenant_host").map((call) => JSON.parse(call.body) as Record<string, unknown>);
    expect(hostReads).toEqual([{ p_host: HOST_COMPANY1 }]);
    // No second read aimed at the planted organization: one host, one membership read.
    expect(reads.length + callsTo("/rpc/current_policy_revision_v1").length).toBe(1);
  });

  it("the membership read carries the user's own access token, and no privileged key is on the wire", async () => {
    captured.length = 0;
    await signInPost();
    const read = callsTo("/rpc/current_membership_v1")[0] as Captured;
    const bearer = headerValues(read, "authorization");
    expect(bearer).toHaveLength(1);
    const token = (bearer[0] as string).replace(/^Bearer /, "");
    expect(JWT_IN_TEXT.test(token)).toBe(true);
    // The token is the one this exchange returned for this user, not the anon key and not a service key.
    expect(token).not.toBe(ANON_KEY_CANARY);
    const everyWireByte = captured.map(wireText).join("\n");
    expect(everyWireByte).not.toContain(SERVICE_ROLE_CANARY);
    expect(everyWireByte).not.toContain("service_role");
    expect(headerValues(read, "apikey")).toEqual([ANON_KEY_CANARY]);
  });

  it("a 28000 over a real socket ends at the generic surface with no session cookie and none of the database's words", async () => {
    captured.length = 0;
    membershipRefuses = true;
    try {
      const { response, store } = await signInPost();
      expect(outcomeOf(response)).toBe("unavailable");
      expect(sessionCookieOf(response)).toBe("");
      expect(cookiesOf(response).find((c) => c.includes(SESSION_COOKIE_BASE))).toBeUndefined();
      expect(store.rows.size).toBe(0);
      const browserWire = `${await response.text()}${cookiesOf(response).join("\n")}${response.headers.get("location") ?? ""}`;
      expect(browserWire).not.toContain(DB_TEXT);
      expect(browserWire).not.toMatch(/28000|postgres:\/\/|pooler|active member|organisation_memberships/i);
    } finally {
      membershipRefuses = false;
    }
  });

  it("a suspended membership gets a session and the no-access surface, having read only its own tenant", async () => {
    captured.length = 0;
    membershipStatus = "suspended";
    providerUser = { id: LEFT, email: "left@company1.test", confirmed: true };
    try {
      const { response, store } = await signInPost({ fields: { email: "left@company1.test" } });
      expect(outcomeOf(response)).toBe("not_a_member");
      expect(new URL(response.headers.get("location") as string).host).toBe(HOST_COMPANY1);
      expect(sessionCookieOf(response)).toMatch(/HttpOnly/);
      expect(sessionCookieOf(response)).toMatch(/Secure/);
      expect(sessionCookieOf(response)).toMatch(/SameSite=Lax/);
      expect(cookiesOf(response).join("\n")).not.toMatch(/domain=/i);
      expect(store.rows.size).toBe(1);
      expect(callsTo("/rpc/current_membership_v1")).toHaveLength(1);
      expect(JSON.parse((callsTo("/rpc/current_membership_v1")[0] as Captured).body)).toEqual({ p_organisation_id: ORG_COMPANY1 });
    } finally {
      membershipStatus = "active";
      providerUser = { id: OWNER1, email: "Owner1@Company1.test", confirmed: true };
    }
  });

  it("no token-shaped value reaches the browser, though the provider handed this process real-shaped ones", async () => {
    captured.length = 0;
    const { response } = await signInPost();
    const body = await response.text();
    const everyHeader = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
    const browserWire = `${everyHeader}\n${body}\n${cookiesOf(response).join("\n")}`;
    expect(browserWire).not.toMatch(JWT_IN_TEXT);
    // And the tokens did exist on the wire in the other direction, so this is not a vacuous pass.
    const providerWire = captured.map(wireText).join("\n");
    expect(providerWire).toMatch(JWT_IN_TEXT);
    expect(providerWire.length).toBeGreaterThan(browserWire.length);
  });

  it("an invalid credential over a real socket is the same answer for every address, with no second read", async () => {
    captured.length = 0;
    providerRefuses = true;
    try {
      const known = await signInPost({ fields: { email: "owner1@company1.test" } });
      const after = captured.length;
      const unknown = await signInPost({ fields: { email: "nobody@nowhere.example" } });
      expect(outcomeOf(known.response)).toBe("invalid_credentials");
      expect(known.response.headers.get("location")).toBe(unknown.response.headers.get("location"));
      expect(unknown.response.status).toBe(known.response.status);
      expect(callsTo("/rpc/current_membership_v1")).toHaveLength(0);
      // Exactly one provider call per attempt: no retry, no second probe.
      expect(after).toBe(2); // host read + token call
      expect(captured.filter((call) => call.url.startsWith("/auth/v1/token"))).toHaveLength(2);
    } finally {
      providerRefuses = false;
    }
  });
});

describe("loopback: GoTrue recover wire (#201 / #181 B4)", () => {
  const RECOVER_VERIFIER = "synthetic-verifier-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const RECOVER_REDIRECT = `https://${HOST_COMPANY1}/auth/callback?state=synthetic-nonce`;

  it("posts flat PKCE fields and puts redirect_to on the query, never under options", async () => {
    captured.length = 0;
    const store = memoryStore();
    await ports(store).sendPasswordRecovery({
      email: "owner1@company1.test",
      redirectTo: RECOVER_REDIRECT,
      codeVerifier: RECOVER_VERIFIER,
    });
    const recoveries = callsTo("/auth/v1/recover");
    expect(recoveries).toHaveLength(1);
    const call = recoveries[0] as Captured;
    expect(call.method).toBe("POST");
    // Exact query string: redirect_to is the only parameter, URL-encoded once.
    expect(call.url).toBe(`/auth/v1/recover?redirect_to=${encodeURIComponent(RECOVER_REDIRECT)}`);
    expect(new URL(call.url, origin).searchParams.get("redirect_to")).toBe(RECOVER_REDIRECT);
    // Exact body: email + top-level PKCE. No `options`, no `email_redirect_to`.
    expect(JSON.parse(call.body)).toEqual({
      email: "owner1@company1.test",
      code_challenge: await sha256Base64Url(RECOVER_VERIFIER),
      code_challenge_method: "s256",
    });
    expect(call.body).not.toContain("options");
    expect(call.body).not.toContain("email_redirect_to");
  });
});
