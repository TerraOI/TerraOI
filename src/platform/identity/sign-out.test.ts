import { describe, expect, it } from "vitest";

import { handleSignOut } from "./sign-out";
import { issueSession } from "./session";
import { issueCsrfToken } from "./csrf";

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
const HOST = "company1.terraoi.app";
const OTHER = "company2.terraoi.app";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const C1 = "11111111-1111-4111-8111-111111111111";

const ports = {
  now: () => NOW,
  signingSecret: () => SECRET,
  findHost: async (host: string) => (host === HOST ? { organisationId: C1, organisationStatus: "active" as const } : null),
};

async function post(host: string, options: { origin?: string | null; csrf?: string | null; cookie?: string | null } = {}) {
  const fields = new URLSearchParams();
  if (options.csrf !== null) fields.set("csrf_token", options.csrf ?? (await issueCsrfToken({ host, secret: SECRET, now: NOW })));
  return new Request(`https://${host}/auth/sign-out`, {
    method: "POST",
    headers: {
      ...(options.origin === null ? {} : { origin: options.origin ?? `https://${host}` }),
      "content-type": "application/x-www-form-urlencoded",
      ...(options.cookie === null || options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: fields.toString(),
  });
}

async function signedOut(host = HOST) {
  const session = await issueSession({ userId: OWNER1, host, secret: SECRET, now: NOW, secureTransport: true });
  return `${session.cookie.name}=${session.cookie.value}`;
}

// A stateless cookie cannot be revoked server-side, so sign-out has to be exact about what it does:
// clear the browser's copy of this host's session, and refuse to do even that on a request that did
// not come from this origin with a valid token.
describe("handleSignOut (POST /auth/sign-out)", () => {
  it("clears the session cookie, host-only, and returns to the login surface", async () => {
    const response = await handleSignOut({ request: await post(HOST, { cookie: await signedOut() }), ports });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") as string);
    expect(location.host).toBe(HOST);
    expect(location.pathname).toBe("/login");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const cleared = response.headers.getSetCookie();
    expect(cleared).toContain("__Host-toi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    expect(cleared.join("\n")).not.toMatch(/domain=/i);
    expect(cleared.join("\n")).not.toContain("Max-Age=28800");
  });

  it("still clears when the request carried no session at all", async () => {
    const response = await handleSignOut({ request: await post(HOST, { cookie: null }), ports });
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toContain("__Host-toi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  });

  it("refuses a request that is not exactly same-origin", async () => {
    for (const origin of [null, "https://company2.terraoi.app", "http://company1.terraoi.app"]) {
      const response = await handleSignOut({ request: await post(HOST, { origin, cookie: await signedOut() }), ports });
      expect(response.status, String(origin)).toBe(403);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
  });

  it("refuses without a valid host-bound CSRF token", async () => {
    const foreign = await issueCsrfToken({ host: OTHER, secret: SECRET, now: NOW });
    for (const csrf of [null, "forged", foreign]) {
      const response = await handleSignOut({ request: await post(HOST, { csrf, cookie: await signedOut() }), ports });
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
  });

  it("refuses the wrong method and a host that is not a live tenant", async () => {
    const get = await handleSignOut({ request: new Request(`https://${HOST}/auth/sign-out`), ports });
    expect(get.status).toBe(405);

    const unknown = await handleSignOut({ request: await post("nosuch.terraoi.app"), ports });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.getSetCookie()).toHaveLength(0);
  });

  it("without a signing secret it reports unavailable and clears nothing", async () => {
    const response = await handleSignOut({
      request: await post(HOST, { cookie: await signedOut() }),
      ports: { ...ports, signingSecret: () => null },
    });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") as string).searchParams.get("outcome")).toBe("unavailable");
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });
});
