import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { RUN_ID, contextFor } from "./chat-fixtures";
import { CHAT_RPCS, createChatStore } from "./store";

/**
 * Loopback harness (COORDINATION.md §6a) for the chat store: a plain Node `http` listener on
 * 127.0.0.1 with `listen(0)`, closed in `afterAll`, driven by the **real** `fetch` — no transport is
 * injected, so what is asserted arrived on a socket.
 *
 * What it proves, for the chat RPCs specifically: one call is exactly one request; the tenant in the
 * body is the context's; the only credential on the wire is the signed-in user's own access token; a
 * planted privileged-key canary (synthetic, never a real credential — AGENTS.md §4.6) appears in no
 * header and no body; and a scope refusal over a real socket is reported as a refusal, with the
 * database's own words left behind.
 *
 * What it does not prove: a read against the real tenant database on staging. That evidence is owed
 * with the T-004 human wiring steps, and no acceptance box naming staging is ticked.
 */

const CANARY = "synthetic-privileged-key-never-a-credential";

function fakeJwt(sub: string, role: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64(`{"alg":"ES256","typ":"JWT","role":"${role}"}`)}.${b64(`{"sub":"${sub}","exp":1800003600}`)}.${b64(
    `synthetic-signature-${sub}`,
  )}`;
}

/** The signed-in user's own token: the only credential a chat call may send (ADR-0003 §7). */
const USER_TOKEN = fakeJwt("00000000-0000-4000-8000-0000000000a2", "authenticated");

interface Seen {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  raw: string;
}

let server: Server;
let base = "";
const seen: Seen[] = [];
/** Scripted responses, consumed in order; the last one repeats. */
let script: Array<{ status: number; body: string }> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const response = script[Math.min(seen.length, script.length - 1)] ?? { status: 200, body: "null" };
      seen.push({
        path: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(raw === "" ? "null" : raw) as Record<string, unknown>,
        raw,
      });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(response.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the chat store over a real socket", () => {
  it("sends one request per call, to the named RPC only", async () => {
    script = [{ status: 200, body: JSON.stringify(RUN_ID) }];
    seen.length = 0;
    const store = createChatStore({ accessToken: USER_TOKEN }, { postgrestBaseUrl: base });
    const result = await store.startRun(contextFor(), {
      runId: RUN_ID,
      conversationId: "4a000000-0000-4000-8000-000000000001",
      idempotencyKey: "idem-0001",
      expertKey: "gpr-field-officer",
      userMessageId: "4a010000-0000-4000-8000-000000000001",
      dataClass: "internal",
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(`/rpc/${CHAT_RPCS.startRun}`);
  });

  it("the tenant on the wire is the context's, and the credential is the caller's own token", async () => {
    script = [{ status: 200, body: JSON.stringify(RUN_ID) }];
    seen.length = 0;
    const store = createChatStore({ accessToken: USER_TOKEN }, { postgrestBaseUrl: base });
    const context = contextFor();
    await store.getRun(context, { runId: RUN_ID });

    const call = seen[0];
    if (call === undefined) throw new Error("the listener saw nothing");
    expect(call.body.p_organisation_id).toBe(context.organisationId);
    expect(call.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(call.headers.apikey).toBeUndefined();
    expect(call.raw).not.toContain(CANARY);
  });

  it("a scope refusal on a real socket is a refusal, not an empty result", async () => {
    script = [
      {
        status: 401,
        // A PostgREST error body may name a pooler host or a role; only the code is read, and nothing
        // of it is handed on (`tenant-rpc.ts:32-34`).
        body: JSON.stringify({ code: "28000", message: "connection to pooler.internal.example refused for role authenticated" }),
      },
    ];
    seen.length = 0;
    const store = createChatStore({ accessToken: USER_TOKEN }, { postgrestBaseUrl: base });
    const result = await store.loadConversation(contextFor(), { conversationId: "4a000000-0000-4000-8000-000000000001" });
    expect(result).toEqual({ ok: false, kind: "membership", detail: "chat_load_conversation_v1:28000" });
  });

  it("a second call for a second context is a second, independent request (F03)", async () => {
    script = [{ status: 200, body: JSON.stringify(RUN_ID) }];
    seen.length = 0;
    const contextA = contextFor();
    const contextB = contextFor({ organisationId: "22222222-2222-4222-8222-222222222222" });
    const store = createChatStore({ accessToken: USER_TOKEN }, { postgrestBaseUrl: base });
    await store.listConversations(contextA, { limit: 20 });
    await store.listConversations(contextB, { limit: 20 });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.body.p_organisation_id).toBe(contextA.organisationId);
    expect(seen[1]?.body.p_organisation_id).toBe(contextB.organisationId);
    // No session variable, no scope carried over: each request says which tenant it means, and the
    // RPC opens its own scope (FAQ-0011, #163).
    expect(seen[1]?.path).toBe(seen[0]?.path);
  });
});
