import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";

import { withTenantRpc, SAFE_TENANT_RPC_MESSAGE, type FetchImpl, type TenantRpcConfig } from "./tenant-rpc";

/**
 * T-101c acceptance tests (FAQ-0011, plan §4.3:245-249, §11 F03, decided in #163).
 *
 * The rule under test: one tenant-scoped RPC is **one** PostgREST call that carries the
 * organisation from `TenantContext` and the **signed-in user's** access token, and the scope lives
 * only inside that call. A unit test can prove the shape of the request the helper builds; what it
 * cannot prove is what crosses a socket, so the same properties are re-run against a real listener
 * in `tenant-rpc.loopback.test.ts` (COORDINATION.md §6a).
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_1 = "00000000-0000-4000-8000-0000000000a1";
const USER_2 = "00000000-0000-4000-8000-0000000000b2";

function contextFor(organisationId: string, userId: string): TenantContext {
  return createTenantContext({
    organisationId,
    host: organisationId === ORG_A ? "company1.terraoi.test" : "company2.terraoi.test",
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

const CTX_A = contextFor(ORG_A, USER_1);
const CTX_B = contextFor(ORG_B, USER_2);

/** JWT-shaped on purpose (the `browser-leak.test.ts` reason): "tok123" would pass while a real token leaked. */
function fakeJwt(what: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT","role":"authenticated"}')}.${b64(
    `{"sub":"${what}","exp":1800003600}`,
  )}.${b64(`synthetic-signature-${what}`)}`;
}
const TOKEN_1 = fakeJwt(USER_1);
const TOKEN_2 = fakeJwt(USER_2);

const BASE = "http://127.0.0.1:1"; // never dialled: every test here drives `fetchImpl`

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  hasSignal: boolean;
}

/** The transport, recorded: url, method, headers, body. A fake that answers whatever the test scripts. */
function transport(answer: (call: { index: number }) => Promise<Response> | Response) {
  const sent: Sent[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: input,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : "",
      hasSignal: init?.signal != null,
    });
    return answer({ index: sent.length - 1 });
  };
  return { sent, fetchImpl };
}

function configFor(fetchImpl: FetchImpl): TenantRpcConfig {
  return { postgrestBaseUrl: BASE, fetchImpl };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Planted database text. If any of it reaches a caller, the leak assertions below fail. */
const DB_MESSAGE = "not an active member of this organization; detail=dsn=postgres://inner:5432/prod";

describe("the call shape: one request, the org from TenantContext, the user's own token", () => {
  it("posts /rpc/<name> once with p_organisation_id from the context and the other args unchanged", async () => {
    const t = transport(() => jsonResponse(200, [{ hit: true }]));
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "gpr survey", p_limit: 10 }, TOKEN_1, configFor(t.fetchImpl));

    expect(outcome).toEqual({ ok: true, data: [{ hit: true }] });
    expect(t.sent).toHaveLength(1);
    const call = t.sent[0] as Sent;
    expect(call.url).toBe(`${BASE}/rpc/search_corpus_v1`);
    expect(call.method).toBe("POST");
    expect(call.hasSignal).toBe(true); // bounded: a hung PostgREST must not pin a Worker request forever
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toEqual({ p_query: "gpr survey", p_limit: 10, p_organisation_id: ORG_A });
    expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN_1}`);
  });

  it("leaves the caller's args object untouched and never re-points the context", async () => {
    const t = transport(() => jsonResponse(200, null));
    const args = { p_query: "keep me", nested: { a: 1 } };
    await withTenantRpc(CTX_A, "read_something_v1", args, TOKEN_1, configFor(t.fetchImpl));
    expect(args).toEqual({ p_query: "keep me", nested: { a: 1 } });
    const body = JSON.parse((t.sent[0] as Sent).body) as Record<string, unknown>;
    expect(body["nested"]).toEqual({ a: 1 });
    expect(body["p_organisation_id"]).toBe(ORG_A);
    expect(CTX_A.organisationId).toBe(ORG_A);
  });

  it("sends no credential but the user's token: no apikey, no privileged header, no cookie", async () => {
    const t = transport(() => jsonResponse(200, null));
    await withTenantRpc(CTX_A, "read_something_v1", {}, TOKEN_1, configFor(t.fetchImpl));
    const call = t.sent[0] as Sent;
    expect(Object.keys(call.headers).sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN_1}`);
  });

  it("an args object that carries p_organisation_id is a compile error, not a runtime override", async () => {
    // The packet's ruling (#163 ruling (b)): a caller cannot choose the tenant. `tsc` failing on the
    // line below is the evidence; an unused directive is itself a typecheck error, so this pin cannot
    // go stale silently.
    const t = transport(() => jsonResponse(200, null));
    // @ts-expect-error p_organisation_id is the helper's own key and is not an allowed argument
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_organisation_id: ORG_B, p_query: "x" }, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome.ok).toBe(true);
    const body = JSON.parse((t.sent[0] as Sent).body) as Record<string, unknown>;
    expect(body["p_organisation_id"]).toBe(ORG_A);
    expect(body["p_query"]).toBe("x");
  });

  it("even a poisoned args object that got past the compiler cannot pick the tenant", async () => {
    const t = transport(() => jsonResponse(200, null));
    const forged = { p_query: "x", p_organisation_id: ORG_B } as unknown as Record<string, unknown>;
    await withTenantRpc(CTX_A, "search_corpus_v1", forged, TOKEN_1, configFor(t.fetchImpl));
    const body = JSON.parse((t.sent[0] as Sent).body) as Record<string, unknown>;
    expect(body["p_organisation_id"]).toBe(ORG_A);
    expect(JSON.stringify(body)).not.toContain(ORG_B);
  });

  it("an RPC name that is not a bare identifier sends nothing at all", async () => {
    for (const name of ["search corpus", "../other", "rpc;x", "Search_Corpus", "", "set_tenant_scope"]) {
      const t = transport(() => jsonResponse(200, null));
      const outcome = await withTenantRpc(CTX_A, name, { p_query: "x" }, TOKEN_1, configFor(t.fetchImpl));
      expect(outcome, name).toMatchObject({ ok: false, kind: "not_configured", reason: "rpc_name_invalid" });
      expect(t.sent, name).toHaveLength(0);
    }
  });

  it("the PostgREST base is configuration: unbound means no request, with a named reason", async () => {
    const t = transport(() => jsonResponse(200, null));
    for (const base of [undefined, "", "   "]) {
      const outcome = await withTenantRpc(CTX_A, "read_something_v1", {}, TOKEN_1, { postgrestBaseUrl: base, fetchImpl: t.fetchImpl });
      expect(outcome, String(base)).toMatchObject({ ok: false, kind: "not_configured", reason: "postgrest_base_unbound" });
    }
    expect(t.sent).toHaveLength(0);
  });

  it("no access token means no request: a scoped read is never attempted unauthenticated", async () => {
    const t = transport(() => jsonResponse(200, null));
    for (const token of [undefined, null, ""]) {
      const outcome = await withTenantRpc(CTX_A, "read_something_v1", {}, token, configFor(t.fetchImpl));
      expect(outcome, String(token)).toMatchObject({ ok: false, kind: "not_configured", reason: "access_token_unbound" });
    }
    expect(t.sent).toHaveLength(0);
  });
});

describe("failures: tenancy is a refusal, everything else is backend_failure, and nothing leaks", () => {
  it("SQLSTATE 28000 becomes a typed tenancy refusal, never an empty result", async () => {
    const t = transport(() => jsonResponse(401, { code: "28000", message: DB_MESSAGE, details: DB_MESSAGE, hint: DB_MESSAGE }));
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "x" }, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome).toEqual({ ok: false, kind: "tenancy", sqlstate: "28000" });
    const rendered = JSON.stringify(outcome);
    expect(rendered).not.toContain("dsn");
    expect(rendered).not.toContain("not an active member");
    expect(SAFE_TENANT_RPC_MESSAGE.tenancy).not.toMatch(/postgres|sqlstate|28000|organization/i);
  });

  it("SQLSTATE 42501 becomes the same tenancy refusal, and no text from the body travels out", async () => {
    const t = transport(() => jsonResponse(403, { code: "42501", message: `grant denied: ${DB_MESSAGE}` }));
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "x" }, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome).toEqual({ ok: false, kind: "tenancy", sqlstate: "42501" });
    expect(JSON.stringify(outcome)).not.toContain("grant denied");
  });

  it("a tenancy refusal is never an empty page of results", async () => {
    for (const status of [401, 403]) {
      const t = transport(() => jsonResponse(status, { code: status === 401 ? "28000" : "42501", message: DB_MESSAGE }));
      const outcome = await withTenantRpc(CTX_A, "list_sources_v1", {}, TOKEN_1, configFor(t.fetchImpl));
      if (outcome.ok) throw new Error(`a tenancy refusal arrived as data: ${JSON.stringify(outcome)}`);
      expect(outcome.kind).toBe("tenancy");
      expect("data" in outcome).toBe(false);
    }
  });

  it("any other error code is backend_failure, so the tenancy map stays narrow", async () => {
    const t = transport(() => jsonResponse(400, { code: "P0001", message: "raise_exception: the query argument is required" }));
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", {}, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome).toMatchObject({ ok: false, kind: "backend_failure" });
    expect(JSON.stringify(outcome)).not.toContain("query argument is required");
  });

  it("a 500 becomes backend_failure with the response text held back", async () => {
    const t = transport(() => new Response(`Internal Server Error: ${DB_MESSAGE}`, { status: 500 }));
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "x" }, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome).toMatchObject({ ok: false, kind: "backend_failure", reason: "server_error" });
    expect(JSON.stringify(outcome)).not.toContain("Internal Server Error");
    expect(JSON.stringify(outcome)).not.toContain("postgres://");
  });

  it("a connection failure becomes backend_failure with nothing from the transport", async () => {
    const t = transport(() => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.7:5432 postgres://inner:5432/prod");
    });
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "x" }, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome).toMatchObject({ ok: false, kind: "backend_failure", reason: "transport" });
    expect(JSON.stringify(outcome)).not.toMatch(/ECONNREFUSED|postgres:\/\//);
  });

  it("a timeout is a bounded backend_failure, not a hung call", async () => {
    const fetchImpl: FetchImpl = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "TimeoutError"));
        });
      });
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "x" }, TOKEN_1, {
      postgrestBaseUrl: BASE,
      fetchImpl,
      timeoutMs: 25,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "backend_failure", reason: "timeout" });
  });

  it("a 2xx body that is not JSON is a failure, never an empty success", async () => {
    const t = transport(() => new Response("<html>upstream said no</html>", { status: 200 }));
    const outcome = await withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "x" }, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome).toMatchObject({ ok: false, kind: "backend_failure", reason: "invalid_response" });
    expect(JSON.stringify(outcome)).not.toContain("upstream said no");
  });

  it("a void RPC (204, no body) is a success carrying null, so the caller still knows the call ran", async () => {
    const t = transport(() => new Response(null, { status: 204 }));
    const outcome = await withTenantRpc(CTX_A, "clear_something_v1", {}, TOKEN_1, configFor(t.fetchImpl));
    expect(outcome).toEqual({ ok: true, data: null });
  });
});

describe("concurrency (F03): two contexts through the same helper stay independent", () => {
  it("interleaved calls each carry their own organisation and their own token, and one request apiece", async () => {
    // Released in reverse order: the second call answers first, so a helper that shared a slot
    // between calls would mix the two here rather than by luck.
    const gates: Array<() => void> = [];
    const t = transport(({ index }) => {
      return new Promise<Response>((resolve) => {
        gates.push(() => resolve(jsonResponse(200, { org: index === 0 ? ORG_A : ORG_B })));
      });
    });

    const first = withTenantRpc(CTX_A, "search_corpus_v1", { p_query: "one" }, TOKEN_1, configFor(t.fetchImpl));
    const second = withTenantRpc(CTX_B, "search_corpus_v1", { p_query: "two" }, TOKEN_2, configFor(t.fetchImpl));

    expect(t.sent).toHaveLength(2);
    const bodies = t.sent.map((call) => JSON.parse(call.body) as Record<string, unknown>);
    expect(bodies[0]?.["p_organisation_id"]).toBe(ORG_A);
    expect(bodies[1]?.["p_organisation_id"]).toBe(ORG_B);
    expect(t.sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN_1}`);
    expect(t.sent[1]?.headers["authorization"]).toBe(`Bearer ${TOKEN_2}`);

    gates.forEach((open) => open());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ ok: true, data: { org: ORG_A } });
    expect(b).toEqual({ ok: true, data: { org: ORG_B } });

    // One call is one transaction (FAQ-0011): two reads are two RPC requests, never three, and
    // `set_tenant_scope` is never dialled as a request of its own.
    expect(t.sent.map((call) => call.url)).toEqual([`${BASE}/rpc/search_corpus_v1`, `${BASE}/rpc/search_corpus_v1`]);
    expect(JSON.stringify(t.sent)).not.toContain("set_tenant_scope");
  });
});

describe("the module keeps the rules it claims (the `provider-boundary.test.ts` idiom)", () => {
  const source = readFileSync(fileURLToPath(new URL("./tenant-rpc.ts", import.meta.url)), "utf8");

  it("never dials set_tenant_scope, never sets a session variable, and keeps no module-level mutable", () => {
    expect(source).not.toMatch(/set_tenant_scope/);
    expect(source).not.toMatch(/set_config|request\.jwt/i);
    expect(source).not.toMatch(/^(?:let|var)\s/m); // no per-process scope: a module-level mutable is a review finding
  });

  it("reads no credential of its own and carries no default host", () => {
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/service[_-]?role|apikey|anon[_-]?key/i);
    expect(source).not.toMatch(/terraoi\.app/); // the PostgREST base is configuration, never a built-in default
  });
});
