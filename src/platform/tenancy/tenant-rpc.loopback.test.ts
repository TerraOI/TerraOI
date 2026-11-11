import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";

import { withTenantRpc, type TenantRpcConfig } from "./tenant-rpc";

/**
 * Loopback harness (COORDINATION.md §6a) for T-101c / FAQ-0011 / #163: a plain Node `http`
 * listener on 127.0.0.1 with `listen(0)`, closed in `afterAll`, driven by the **real** `fetch` —
 * `withTenantRpc` is called with no transport injected. Everything asserted here is what the
 * listener actually received on its socket, not what a fake was asked to remember.
 *
 * What it proves: the credential that crosses the wire is the signed-in user's access token; a
 * planted privileged-key canary (synthetic, never a credential — AGENTS.md §4.6) appears in no
 * header and no body; the body carries exactly the context's `p_organisation_id`; one scoped read is
 * exactly one request; and a tenancy refusal or a 5xx over a real socket is reported without the
 * database's own words.
 *
 * What it does not prove: a read against the real tenant database on staging. That evidence is owed
 * (T-102's sign-in is the T-004 §20.8 human step), and no acceptance box naming staging is ticked.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_1 = "00000000-0000-4000-8000-0000000000a1";
const USER_2 = "00000000-0000-4000-8000-0000000000b2";

function contextFor(organisationId: string, userId: string, host: string): TenantContext {
  return createTenantContext({
    organisationId,
    host,
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

const CTX_A = contextFor(ORG_A, USER_1, "company1.terraoi.test");
const CTX_B = contextFor(ORG_B, USER_2, "company2.terraoi.test");

function fakeJwt(sub: string, role: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64(`{"alg":"ES256","typ":"JWT","role":"${role}"}`)}.${b64(`{"sub":"${sub}","exp":1800003600}`)}.${b64(
    `synthetic-signature-${sub}`,
  )}`;
}

/** The signed-in user's access token: the only credential this helper may send (ADR-0003 §7). */
const USER_TOKEN = fakeJwt(USER_1, "authenticated");
const USER_TOKEN_2 = fakeJwt(USER_2, "authenticated");

// service_role canary — a synthetic JWT in the *shape* of a privileged Supabase key, named canary so
// nobody mistakes it for a credential (AGENTS.md §4.6). It exists so that a future wiring which hands
// a privileged key to this module is reported on the socket instead of caught in review by eye.
const SERVICE_ROLE_CANARY = fakeJwt("service-role-canary", "service_role");
const ANON_KEY_CANARY = "synthetic-anon-key-canary-not-a-real-key";

/** A deployment's binding bag. Only the base URL may be handed to the helper. */
const bindings = { postgrestUrl: "", serviceRoleCanary: SERVICE_ROLE_CANARY, anonKeyCanary: ANON_KEY_CANARY };

const DB_TEXT = "not an active member of this organization (detail: pooler postgres://inner-host:5432/prod)";

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
/** While set, the listener holds every response open — how the concurrency test forces real overlap. */
let holdResponses: Promise<void> | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const rawHeaders = req.rawHeaders ?? [];
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        rawHeaders,
        headerText: rawHeaders.join("\n"),
        body,
      });
      if (holdResponses !== null) await holdResponses;

      const path = req.url ?? "";
      if (path.includes("refuse_28000")) return json(res, 401, { code: "28000", message: DB_TEXT, details: DB_TEXT });
      if (path.includes("refuse_42501")) return json(res, 403, { code: "42501", message: DB_TEXT });
      if (path.includes("boom")) return json(res, 500, { code: "XX000", message: DB_TEXT });
      const organisation = (JSON.parse(body || "{}") as Record<string, unknown>)["p_organisation_id"];
      return json(res, 200, { organisation_seen: organisation ?? null });
    })().catch(() => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  bindings.postgrestUrl = origin;
});

afterAll(() => {
  server?.close();
});

function headerValues(call: Captured, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < call.rawHeaders.length; i += 2) {
    if ((call.rawHeaders[i] as string).toLowerCase() === name) out.push(call.rawHeaders[i + 1] as string);
  }
  return out;
}

function wireText(call: Captured): string {
  return [call.method, call.url, call.headerText, call.body].join("\n");
}

function config(): TenantRpcConfig {
  // Deliberately no `fetchImpl`: the helper's own `fetch` dials the socket, which is the point of §6a.
  return { postgrestBaseUrl: bindings.postgrestUrl };
}

describe("loopback: what crossed the socket is the user's own credential", () => {
  it("the authorization header on the wire is the user's bearer token, and one request only", async () => {
    captured.length = 0;
    const outcome = await withTenantRpc(CTX_A, "list_sources_v1", { p_limit: 5 }, USER_TOKEN, config());
    expect(outcome).toEqual({ ok: true, data: { organisation_seen: ORG_A } });
    expect(captured).toHaveLength(1);
    const call = captured[0] as Captured;

    expect(call.method).toBe("POST");
    expect(call.url).toBe("/rpc/list_sources_v1");
    expect(headerValues(call, "authorization")).toEqual([`Bearer ${USER_TOKEN}`]);

    // The organisation reaches the call only in the body, and only as the context's value.
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toEqual({ p_limit: 5, p_organisation_id: ORG_A });

    // No second credential of any kind reached the listener.
    expect(call.headerText.toLowerCase()).not.toMatch(/apikey|cookie|service|admin|supabase|anon/);
  });

  it("a planted privileged-key canary never appears in any header or body", async () => {
    captured.length = 0;
    await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "gpr" }, USER_TOKEN, config());
    await withTenantRpc(CTX_B, "search_corpus_v1", { p_query: "uav" }, USER_TOKEN_2, config());
    const everyWireByte = captured.map(wireText).join("\n");
    expect(everyWireByte).not.toContain(bindings.serviceRoleCanary);
    expect(everyWireByte).not.toContain(bindings.anonKeyCanary);
    expect(everyWireByte).not.toContain("service_role");
    // The only JWT-shaped values on the wire are the two callers' own access tokens.
    const jwtShaped = everyWireByte.match(/eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g) ?? [];
    expect(new Set(jwtShaped)).toEqual(new Set([USER_TOKEN, USER_TOKEN_2]));
  });

  it("two interleaved contexts keep their own organisation on their own sockets", async () => {
    captured.length = 0;
    // Both responses stay open until both requests have landed, so the two calls are genuinely in
    // flight at once — the F03 case a per-process or per-connection scope would fail.
    let release: () => void = () => undefined;
    holdResponses = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bothArrived = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (captured.length >= 2) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
      const fallback = setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, 1_000);
      fallback.unref();
    });

    const first = withTenantRpc(CTX_A, "list_sources_v1", { p_query: "one" }, USER_TOKEN, config());
    const second = withTenantRpc(CTX_B, "list_sources_v1", { p_query: "two" }, USER_TOKEN_2, config());
    await bothArrived;
    release();
    const [a, b] = await Promise.all([first, second]);
    holdResponses = null;

    expect(captured).toHaveLength(2); // two reads are two RPC calls: no scope-setting request of its own
    const bodies = captured.map((call) => JSON.parse(call.body) as Record<string, unknown>);
    const organisations = bodies.map((body) => body["p_organisation_id"]);
    expect(organisations).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
    expect(organisations).not.toContain(undefined);
    const authOnWire = captured.flatMap((call) => headerValues(call, "authorization"));
    expect(authOnWire.sort()).toEqual([`Bearer ${USER_TOKEN}`, `Bearer ${USER_TOKEN_2}`].sort());
    expect(captured.map((call) => call.url)).toEqual(["/rpc/list_sources_v1", "/rpc/list_sources_v1"]);

    expect(a).toEqual({ ok: true, data: { organisation_seen: ORG_A } });
    expect(b).toEqual({ ok: true, data: { organisation_seen: ORG_B } });
  });

  it("a 28000 refusal over a real socket is a tenancy refusal carrying none of the database's words", async () => {
    const outcome = await withTenantRpc(CTX_A, "refuse_28000_v1", {}, USER_TOKEN, config());
    expect(outcome).toEqual({ ok: false, kind: "tenancy", sqlstate: "28000" });
    expect(JSON.stringify(outcome)).not.toContain(DB_TEXT);
    expect(JSON.stringify(outcome)).not.toMatch(/postgres:\/\/|pooler|active member/);
  });

  it("a 42501 refusal over a real socket maps the same way, never as an empty result", async () => {
    const outcome = await withTenantRpc(CTX_A, "refuse_42501_v1", {}, USER_TOKEN, config());
    if (outcome.ok) throw new Error(`tenancy refusal arrived as data: ${JSON.stringify(outcome)}`);
    expect(outcome).toEqual({ ok: false, kind: "tenancy", sqlstate: "42501" });
  });

  it("a 500 and a connection failure both become backend_failure with the response text held back", async () => {
    const serverSide = await withTenantRpc(CTX_A, "boom_v1", {}, USER_TOKEN, config());
    expect(serverSide).toMatchObject({ ok: false, kind: "backend_failure", reason: "server_error" });
    expect(JSON.stringify(serverSide)).not.toContain(DB_TEXT);

    // A real connection failure: dial a port that was bound and then closed, so `fetch` itself fails.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = await withTenantRpc(CTX_A, "list_sources_v1", {}, USER_TOKEN, {
      postgrestBaseUrl: `http://127.0.0.1:${deadPort}`,
    });
    expect(unreachable).toMatchObject({ ok: false, kind: "backend_failure", reason: "transport" });
    expect(JSON.stringify(unreachable)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });
});
