import { describe, expect, it } from "vitest";

import { issueCsrfToken } from "./csrf";
import { issueSession, SESSION_COOKIE_BASE } from "./session";
import {
  buildSetPasswordView,
  handleSetPassword,
  MIN_PASSWORD_LENGTH,
  SET_PASSWORD_PATH,
  type SetPasswordPorts,
} from "./set-password";
import { createTokenCipher, type SessionStore, type StoredSession } from "./session-store";

/**
 * T-201 / #181 B1: the set-password half of recovery. A completed recovery link issues a session and
 * lands here; this surface calls GoTrue's `PUT /auth/v1/user` with that session's access token so
 * the forgotten password is actually replaced.
 */

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const CIPHER = { currentVersion: "v1", keys: { v1: "synthetic-keyring-v1-not-a-real-key-000000000" } };
const NOW = 1_800_000_000;
const HOST_A = "company1.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";
const NEW_PASSWORD = "correct-horse-battery-staple";

function fakeJwt(what: string, sub: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT"}')}.${b64(`{"sub":"${sub}"}`)}.${b64(`synthetic-signature-${what}`)}`;
}
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

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
  ports: SetPasswordPorts;
  store: SessionStore & { rows: Map<string, StoredSession> };
  updates: Array<{ accessToken: string; password: string }>;
  updateResult: "updated" | "rejected";
  boom: boolean;
  membershipStatus: "active" | "suspended" | null;
  allowRequest: boolean;
  limiterKeys: Array<{ host: string; material: string }>;
  sessionCookie: string;
}

async function harness(overrides: Partial<Harness> = {}): Promise<Harness> {
  const store = memoryStore();
  const cipher = createTokenCipher(CIPHER);
  const issued = await issueSession({
    userId: OWNER1,
    host: HOST_A,
    tokens: {
      accessToken: fakeJwt("access", OWNER1),
      refreshToken: fakeJwt("refresh", OWNER1),
      expiresAt: NOW + 3600,
    },
    store,
    cipher,
    now: NOW,
    secureTransport: true,
  });
  const state: Harness = {
    ports: {} as SetPasswordPorts,
    store,
    updates: [],
    updateResult: "updated",
    boom: false,
    membershipStatus: "active",
    allowRequest: true,
    limiterKeys: [],
    sessionCookie: `${issued.cookie.name}=${issued.cookie.value}`,
    ...overrides,
  };
  state.ports = {
    now: () => NOW,
    signingSecret: () => SECRET,
    sessionStore: () => state.store,
    tokenCipher: () => cipher,
    findHost: async (host) => (host === HOST_A ? { organisationId: C1, organisationStatus: "active" } : null),
    findMembership: async () =>
      state.membershipStatus === null
        ? null
        : {
            membershipId: MEMBERSHIP,
            status: state.membershipStatus,
            roles: state.membershipStatus === "active" ? ["member"] : [],
            permittedServiceKeys: [],
            permittedProjectIds: [],
          },
    updatePassword: async (input) => {
      if (state.boom) throw new Error("provider unavailable");
      state.updates.push(input);
      return state.updateResult;
    },
    rateLimitKey: async (input) => {
      state.limiterKeys.push(input);
      return `${input.host}|${input.material}`;
    },
    allowRequest: async () => state.allowRequest,
  };
  return state;
}

const locationOf = (response: Response) => new URL(response.headers.get("location") as string);
const outcomeOf = (response: Response) => locationOf(response).searchParams.get("outcome");

async function post(input: {
  password?: string;
  confirm?: string;
  csrf?: string | null;
  origin?: string | null;
  cookie?: string | null;
  configure?: (h: Harness) => void;
} = {}) {
  const h = await harness();
  if (input.configure) input.configure(h);
  const csrf =
    input.csrf === null ? undefined : (input.csrf ?? (await issueCsrfToken({ host: HOST_A, secret: SECRET, now: NOW })));
  const params = new URLSearchParams();
  if (input.password !== undefined) params.set("password", input.password);
  else params.set("password", NEW_PASSWORD);
  if (input.confirm !== undefined) params.set("confirm", input.confirm);
  else params.set("confirm", input.password ?? NEW_PASSWORD);
  if (csrf !== undefined) params.set("csrf_token", csrf);

  const headers = new Headers();
  if (input.origin !== null) headers.set("origin", input.origin ?? `https://${HOST_A}`);
  headers.set("content-type", "application/x-www-form-urlencoded");
  if (input.cookie !== null) headers.set("cookie", input.cookie ?? h.sessionCookie);

  const response = await handleSetPassword({
    request: new Request(`https://${HOST_A}/auth/set-password`, {
      method: "POST",
      headers,
      body: params.toString(),
    }),
    ports: h.ports,
  });
  return { response, h };
}

describe("SET_PASSWORD_PATH", () => {
  it("is the account surface the packet owns", () => {
    expect(SET_PASSWORD_PATH).toBe("/account/set-password");
  });
});

describe("buildSetPasswordView", () => {
  it("issues a CSRF token when the recovery session is live on this host", async () => {
    const h = await harness();
    const view = await buildSetPasswordView({
      request: new Request(`https://${HOST_A}${SET_PASSWORD_PATH}`, {
        headers: { cookie: h.sessionCookie },
      }),
      ports: h.ports,
    });
    expect(view.kind).toBe("form");
    if (view.kind !== "form") return;
    expect(view.host).toBe(HOST_A);
    expect(view.csrfToken.length).toBeGreaterThan(20);
    expect(view.outcome).toBeNull();
  });

  it("without a session redirects to login, never a form for nobody", async () => {
    const h = await harness();
    const view = await buildSetPasswordView({
      request: new Request(`https://${HOST_A}${SET_PASSWORD_PATH}`),
      ports: h.ports,
    });
    expect(view.kind).toBe("redirect");
    if (view.kind !== "redirect") return;
    expect(outcomeOf(view.response)).toBe("unavailable");
  });
});

describe("handleSetPassword (POST /auth/set-password)", () => {
  it("updates the password through GoTrue with the session access token and sends an active member home", async () => {
    const { response, h } = await post();
    expect(response.status).toBe(303);
    expect(locationOf(response).pathname).toBe("/");
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.password).toBe(NEW_PASSWORD);
    expect(h.updates[0]?.accessToken).toMatch(/^eyJ/);
    expect(h.limiterKeys).toEqual([{ host: HOST_A, material: `set-password|${OWNER1}` }]);
    const wire = `${await response.text()}${response.headers.getSetCookie().join("\n")}`;
    expect(wire).not.toMatch(JWT_IN_TEXT);
    expect(wire.toLowerCase()).not.toContain(NEW_PASSWORD);
  });

  it("a non-active membership lands on the no-access surface after a successful update", async () => {
    const { response, h } = await post({ configure: (s) => { s.membershipStatus = null; } });
    expect(outcomeOf(response)).toBe("not_a_member");
    expect(h.updates).toHaveLength(1);
  });

  it("a too-short or mismatched password never reaches the provider", async () => {
    const short = await post({ password: "x".repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(locationOf(short.response).pathname).toBe(SET_PASSWORD_PATH);
    expect(outcomeOf(short.response)).toBe("rejected");
    expect(short.h.updates).toHaveLength(0);

    const mismatch = await post({ password: NEW_PASSWORD, confirm: "something-else-entirely" });
    expect(outcomeOf(mismatch.response)).toBe("rejected");
    expect(mismatch.h.updates).toHaveLength(0);
  });

  it("keeps the guard chain: origin, CSRF, session", async () => {
    expect((await post({ origin: "https://evil.example" })).response.status).toBe(403);
    expect((await post({ csrf: null })).response.status).toBe(403);
    const noSession = await post({ cookie: null });
    expect(outcomeOf(noSession.response)).toBe("unavailable");
    expect(noSession.h.updates).toHaveLength(0);
  });

  it("a provider rejection or outage stays on the set-password surface", async () => {
    const rejected = await post({ configure: (s) => { s.updateResult = "rejected"; } });
    expect(locationOf(rejected.response).pathname).toBe(SET_PASSWORD_PATH);
    expect(outcomeOf(rejected.response)).toBe("rejected");

    const boom = await post({ configure: (s) => { s.boom = true; } });
    expect(outcomeOf(boom.response)).toBe("unavailable");
  });
});
