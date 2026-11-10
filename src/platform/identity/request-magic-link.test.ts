import { describe, expect, it } from "vitest";

import { verifyLoginState } from "./login-state";
import { handleMagicLinkRequest, type MagicLinkRequestPorts } from "./request-magic-link";
import { issueCsrfToken } from "./csrf";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
const HOST = "company1.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";

interface Harness {
  ports: MagicLinkRequestPorts;
  sent: Array<{ email: string; redirectTo: string; codeVerifier: string }>;
  limiterKeys: Array<{ host: string; email: string }>;
  requestKeys: string[];
  allowed: boolean;
  sendFails: boolean;
}

function harness(): Harness {
  const state: Harness = {
    sent: [],
    limiterKeys: [],
    requestKeys: [],
    allowed: true,
    sendFails: false,
    ports: {} as MagicLinkRequestPorts,
  };
  state.ports = {
    now: () => NOW,
    signingSecret: () => SECRET,
    findHost: async (host) => (host === HOST ? { organisationId: C1, organisationStatus: "active" } : null),
    rateLimitKey: async (input) => {
      state.limiterKeys.push(input);
      // A real adapter returns an HMAC; a fixed marker keeps the assertions about *what reaches it*.
      return `key-${input.host.length}-${input.email.length}`;
    },
    allowRequest: async (key) => {
      state.requestKeys.push(key);
      return state.allowed;
    },
    sendMagicLink: async (call) => {
      if (state.sendFails) throw new Error("provider unavailable");
      state.sent.push(call);
    },
  };
  return state;
}

async function post(host: string, fields: Record<string, string>, options: { origin?: string | null; contentType?: string } = {}) {
  return new Request(`https://${host}/auth/magic-link`, {
    method: "POST",
    headers: {
      ...(options.origin === null ? {} : { origin: options.origin ?? `https://${host}` }),
      "content-type": options.contentType ?? "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** POST the way the login page does: a valid CSRF token for this host plus the form fields. */
async function request(host: string, fields: Record<string, string>, configure: (state: Harness) => void = () => {}) {
  const state = harness();
  configure(state);
  const response = await handleMagicLinkRequest({
    request: await post(host, { csrf_token: await issueCsrfToken({ host, secret: SECRET, now: NOW }), ...fields }),
    ports: state.ports,
  });
  return { response, state };
}

const locationOf = (response: Response) => new URL(response.headers.get("location") as string);
const cookieOf = (response: Response, index = 0) => (response.headers.getSetCookie()[index] as string | undefined) ?? "";

// Plan §4.2: "require exact Origin validation and CSRF protection for state-changing endpoints" and
// "use explicit HTTPS tenant callback URLs … do not use broad wildcard auth redirects or
// URL-carried session tokens".
describe("handleMagicLinkRequest (POST /auth/magic-link)", () => {
  it("issues a link and hands this browser a host-only, short-lived state cookie", async () => {
    const { response, state } = await request(HOST, { email: "owner1@company1.test" });
    expect(response.status).toBe(303);
    expect(locationOf(response).host).toBe(HOST);
    expect(locationOf(response).pathname).toBe("/login");
    expect(locationOf(response).searchParams.get("outcome")).toBe("link_sent");

    const cookie = cookieOf(response);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(cookie).toMatch(/^__Host-toi_login_state=[A-Za-z0-9_.-]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    expect(cookie).not.toMatch(/domain=/i);
    expect(state.sent).toHaveLength(1);
  });

  it("binds the callback state to the cookie it just set, on this host only", async () => {
    const { response, state } = await request(HOST, { email: "owner1@company1.test" });
    const redirectTo = new URL(state.sent[0]?.redirectTo as string);
    expect(redirectTo.origin).toBe(`https://${HOST}`);
    expect(redirectTo.pathname).toBe("/auth/callback");

    const check = await verifyLoginState({
      cookieHeader: cookieOf(response).split(";")[0],
      presentedState: redirectTo.searchParams.get("state"),
      host: HOST,
      secret: SECRET,
      now: NOW,
    });
    expect(check).toEqual({ ok: true, codeVerifier: expect.any(String) });
    // The provider was given the challenge for exactly the verifier this browser's cookie carries.
    expect(state.sent[0]?.codeVerifier).toBe(check.ok ? check.codeVerifier : undefined);
    if (!check.ok) return;
    expect(state.sent[0]?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const elsewhere = await verifyLoginState({
      cookieHeader: cookieOf(response).split(";")[0],
      presentedState: redirectTo.searchParams.get("state"),
      host: "company2.terraoi.app",
      secret: SECRET,
      now: NOW,
    });
    expect(elsewhere).toEqual({ ok: false, reason: "host_mismatch" });
  });

  it("derives the callback URL from the routed host and ignores any redirect target in the body", async () => {
    const { response, state } = await request(HOST, {
      email: "owner1@company1.test",
      redirect_to: "https://evil.example/steal",
      next: "https://evil.example",
      host: "company2.terraoi.app",
      organisation_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.redirectTo.startsWith(`https://${HOST}/auth/callback`)).toBe(true);
    expect(JSON.stringify(state.sent)).not.toContain("evil.example");
    expect(JSON.stringify(state.sent)).not.toContain("22222222");
    expect(locationOf(response).host).toBe(HOST);
  });

  it("never sets a session cookie at this step, and always answers no-store", async () => {
    const { response } = await request(HOST, { email: "owner1@company1.test" });
    expect(response.headers.getSetCookie().join("\n")).not.toContain("toi_session");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a POST with no Origin at all before anything is sent", async () => {
    const state = harness();
    const response = await handleMagicLinkRequest({
      request: await post(HOST, { csrf_token: await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW }), email: "owner1@company1.test" }, { origin: null }),
      ports: state.ports,
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.sent).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  // A POST that *looks* same-site but arrives from a sibling tenant origin is the attack §4.2 names.
  it("rejects an Origin that is not exactly this host over https", async () => {
    const token = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
    for (const origin of [
      "https://company2.terraoi.app",
      "http://company1.terraoi.app",
      "https://company1.terraoi.app:8443",
      "null",
      "https://company1.terraoi.app.evil.example",
    ]) {
      const state = harness();
      const response = await handleMagicLinkRequest({
        request: await post(HOST, { csrf_token: token, email: "owner1@company1.test" }, { origin }),
        ports: state.ports,
      });
      expect(response.status, origin).toBe(403);
      expect(response.headers.getSetCookie(), origin).toHaveLength(0);
      expect(state.sent, origin).toHaveLength(0);
      expect(state.requestKeys, origin).toHaveLength(0);
    }
  });

  it("rejects a missing, forged, foreign-host or expired CSRF token", async () => {
    const foreignToken = await issueCsrfToken({ host: "company2.terraoi.app", secret: SECRET, now: NOW });

    const missing = await handleMagicLinkRequest({
      request: await post(HOST, { email: "owner1@company1.test" }),
      ports: harness().ports,
    });
    expect(missing.status).toBe(403);

    const forged = await handleMagicLinkRequest({
      request: await post(HOST, { email: "owner1@company1.test", csrf_token: "not-a-token" }),
      ports: harness().ports,
    });
    expect(forged.status).toBe(403);

    const foreign = await handleMagicLinkRequest({
      request: await post(HOST, { email: "owner1@company1.test", csrf_token: foreignToken }),
      ports: harness().ports,
    });
    expect(foreign.status).toBe(403);

    const expiredState = harness();
    expiredState.ports = { ...expiredState.ports, now: () => NOW + 3_600 };
    const expired = await handleMagicLinkRequest({
      request: await post(HOST, { email: "owner1@company1.test", csrf_token: await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW }) }),
      ports: expiredState.ports,
    });
    expect(expired.status).toBe(403);
    expect(expiredState.sent).toHaveLength(0);
  });

  it("refuses the wrong method and the wrong content type", async () => {
    const notPost = await handleMagicLinkRequest({
      request: new Request(`https://${HOST}/auth/magic-link`),
      ports: harness().ports,
    });
    expect(notPost.status).toBe(405);

    const json = await handleMagicLinkRequest({
      request: new Request(`https://${HOST}/auth/magic-link`, {
        method: "POST",
        headers: { origin: `https://${HOST}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "owner1@company1.test" }),
      }),
      ports: harness().ports,
    });
    expect(json.status).toBe(415);
  });

  it("refuses an oversized form body before parsing it", async () => {
    const state = harness();
    const huge: Record<string, string> = { csrf_token: await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW }) };
    for (let i = 0; i < 400; i += 1) huge[`filler${i}`] = "x".repeat(40);
    const response = await handleMagicLinkRequest({ request: await post(HOST, huge), ports: state.ports });
    expect(response.status).toBe(413);
    expect(state.sent).toHaveLength(0);
  });

  it("gives a host that is not a live tenant nothing at all", async () => {
    for (const host of ["nosuch.terraoi.app", "admin.terraoi.app", "my-app.workers.dev"]) {
      const { response, state } = await request(host, { email: "owner1@company1.test" });
      expect(response.status, host).toBe(404);
      expect(state.sent, host).toHaveLength(0);
      expect(response.headers.getSetCookie(), host).toHaveLength(0);
    }
  });

  // Acceptance item: the answer never reveals whether an address is invited, limited or failing.
  it("answers an invited address and a stranger identically, and identically again when rate limited", async () => {
    const shape = async (email: string, allowed: boolean) => {
      const { response, state } = await request(HOST, { email }, (h) => {
        h.allowed = allowed;
      });
      return {
        status: response.status,
        location: response.headers.get("location"),
        cookieCount: response.headers.getSetCookie().length,
        body: await response.text(),
        sent: state.sent.length,
      };
    };
    expect(await shape("owner1@company1.test", true)).toEqual(await shape("nobody@nowhere.example", true));

    const limitedInvited = await shape("owner1@company1.test", false);
    const limitedStranger = await shape("nobody@nowhere.example", false);
    expect(limitedInvited).toEqual(limitedStranger);
    expect(limitedInvited.status).toBe(303);
    expect(new URL(limitedInvited.location as string).searchParams.get("outcome")).toBe("rate_limited");
  });

  it("normalizes the address before the limiter sees it, so case tricks do not buy budget", async () => {
    const state = harness();
    for (const email of ["user@example.test", " User@Example.TEST ", "USER@example.test"]) {
      await handleMagicLinkRequest({
        request: await post(HOST, {
          csrf_token: await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW }),
          email,
        }),
        ports: state.ports,
      });
    }
    expect(state.limiterKeys.map((entry) => entry.email)).toEqual(["user@example.test", "user@example.test", "user@example.test"]);
    expect(state.limiterKeys.every((entry) => entry.host === HOST)).toBe(true);
    expect(state.requestKeys.every((key) => !key.includes("@"))).toBe(true);
  });

  it("does not send for an address that is not an address, and the answer is unchanged", async () => {
    const good = await request(HOST, { email: "owner1@company1.test" });
    const bad = await request(HOST, { email: "not an email" });
    expect(bad.state.sent).toHaveLength(0);
    expect(bad.response.status).toBe(good.response.status);
    expect(bad.response.headers.get("location")).toBe(good.response.headers.get("location"));
  });

  it("a provider failure is the same safe answer whatever the address", async () => {
    const configure = (h: Harness) => {
      h.sendFails = true;
    };
    const invited = await request(HOST, { email: "owner1@company1.test" }, configure);
    const stranger = await request(HOST, { email: "nobody@nowhere.example" }, configure);
    expect(invited.response.status).toBe(303);
    expect(locationOf(invited.response).searchParams.get("outcome")).toBe("unavailable");
    expect(invited.response.headers.get("location")).toBe(stranger.response.headers.get("location"));
  });

  it("without a signing secret the endpoint refuses instead of issuing unprotected cookies", async () => {
    const { response, state } = await request(HOST, { email: "owner1@company1.test" }, (h) => {
      h.ports = { ...h.ports, signingSecret: () => null };
    });
    expect(response.status).toBe(303);
    expect(locationOf(response).searchParams.get("outcome")).toBe("unavailable");
    expect(state.sent).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  // ADR-0006 rule 3: the header the proxy writes for pages is not a host source for a handler. The
  // proxy runs on `/auth/magic-link` too, so the header really can be present here — and a client
  // can also put its own candidates in. Only `request.url` may decide the organization.
  it("takes its tenant from request.url and ignores x-toi-routed-host even when the proxy set it", async () => {
    const state = harness();
    const request = new Request(`https://${HOST}/auth/magic-link`, {
      method: "POST",
      headers: {
        origin: `https://${HOST}`,
        "content-type": "application/x-www-form-urlencoded",
        // A value a client forged, and the same header the proxy would have written for a request
        // routed to company2. `findHost` above only knows company1, so if either header decided the
        // host this request would end in 404 instead of a issued link.
        "x-toi-routed-host": "company2.terraoi.app",
        host: "company2.terraoi.app",
        "x-forwarded-host": "company2.terraoi.app",
      },
      body: new URLSearchParams({
        csrf_token: await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW }),
        email: "owner1@company1.test",
      }).toString(),
    });

    const response = await handleMagicLinkRequest({ request, ports: state.ports });

    expect(response.status).toBe(303);
    expect(state.limiterKeys).toEqual([{ host: HOST, email: "owner1@company1.test" }]);
    expect(state.sent[0]?.redirectTo.startsWith(`https://${HOST}/auth/callback`)).toBe(true);
    // The hostile headers are not echoed into any decision the handler makes or returns.
    expect(response.headers.get("location")).not.toContain("company2");
    expect(response.headers.get("x-toi-routed-host")).toBeNull();
  });
});
