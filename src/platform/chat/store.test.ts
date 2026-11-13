import { describe, expect, it } from "vitest";

import { withTenantRpc } from "@/platform/tenancy/tenant-rpc";

import { answeredFixture, contextFor, ORG_COMPANY1, ORG_COMPANY2, RUN_ID, USER_ACCESS_TOKEN } from "./chat-fixtures";
import { CHAT_RPCS, createChatStore, type StoreFailure } from "./store";

/**
 * The transport tests for the chat store. What they are really guarding is that this module cannot
 * choose a tenant, cannot choose an actor, and cannot report a database refusal as "no rows" — the
 * three ways a persistence layer quietly becomes an authorization layer.
 *
 * pgTAP `035` is where the SQL's own decisions are pinned; nothing here repeats a policy claim. These
 * cases read the wire: one request per call, one credential, one tenant argument, and the failure
 * vocabulary on the way back.
 */

const BASE = "https://synthetic-project.example";

interface Recorded {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function recordingFetch(responses: Array<{ status: number; body: string }>) {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>,
      headers: init?.headers as Record<string, string>,
    });
    const next = responses[calls.length - 1] ?? { status: 200, body: "null" };
    return new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function storeFor(responses: Array<{ status: number; body: string }>, accessToken: string | null = USER_ACCESS_TOKEN) {
  const transport = recordingFetch(responses);
  const store = createChatStore({ accessToken }, { postgrestBaseUrl: BASE, fetchImpl: transport.fetchImpl });
  return { store, transport };
}

const context = contextFor();

describe("one call, one RPC, one tenant argument", () => {
  it("dials exactly the named function and nothing else", async () => {
    const { store, transport } = storeFor([{ status: 200, body: JSON.stringify(RUN_ID) }]);
    const result = await store.startRun(context, {
      runId: RUN_ID,
      conversationId: "4a000000-0000-4000-8000-000000000001",
      idempotencyKey: "idem-0001",
      expertKey: "gpr-field-officer",
      userMessageId: "4a010000-0000-4000-8000-000000000001",
      dataClass: "internal",
    });

    expect(result.ok).toBe(true);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(`${BASE}/rpc/chat_start_run_v1`);
    expect(transport.calls[0]?.body).toEqual({
      p_run_id: RUN_ID,
      p_conversation_id: "4a000000-0000-4000-8000-000000000001",
      p_idempotency_key: "idem-0001",
      p_expert_key: "gpr-field-officer",
      p_user_message_id: "4a010000-0000-4000-8000-000000000001",
      p_data_class: "internal",
      // The context's organisation, supplied by the helper and by nobody else (FAQ-0011, #163).
      p_organisation_id: ORG_COMPANY1,
    });
  });

  it("carries exactly one credential: the signed-in user's own access token", async () => {
    const { store, transport } = storeFor([{ status: 200, body: JSON.stringify(RUN_ID) }]);
    await store.getRun(context, { runId: RUN_ID });
    const headers = transport.calls[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${USER_ACCESS_TOKEN}`);
    // No privileged key, no anon key, no apikey header: `withTenantRpc` sends one credential and this
    // module adds none (ADR-0003 §7). A hosted gateway that needs a second header is the supervisor's
    // call, and adding one here would be making it.
    expect(Object.keys(headers)).toEqual(["accept", "content-type", "authorization"]);
  });

  it("names no user parameter on any call: the actor comes from the bearer, not from a field", async () => {
    const { store, transport } = storeFor([
      { status: 200, body: JSON.stringify("4a000000-0000-4000-8000-000000000001") },
      { status: 200, body: JSON.stringify("4a010000-0000-4000-8000-000000000001") },
    ]);
    await store.ensureConversation(context, {
      conversationId: "4a000000-0000-4000-8000-000000000001",
      expertKey: "gpr-field-officer",
      projectId: null,
    });
    await store.appendUserMessage(context, {
      conversationId: "4a000000-0000-4000-8000-000000000001",
      clientMessageId: "cm-0001",
      bodyText: "Which grid was surveyed twice?",
      dataClass: "internal",
    });
    for (const call of transport.calls) {
      const keys = Object.keys(call.body);
      expect(keys.filter((key) => key.includes("user"))).toEqual([]);
      expect(keys).toContain("p_organisation_id");
    }
  });

  it("the seven methods dial the seven RPCs this migration creates, and no other name", async () => {
    const uuid = "4a000000-0000-4000-8000-000000000001";
    const { store, transport } = storeFor([
      { status: 200, body: JSON.stringify(uuid) },
      { status: 200, body: JSON.stringify(uuid) },
      { status: 200, body: JSON.stringify(uuid) },
      {
        status: 200,
        body: JSON.stringify({
          runId: RUN_ID,
          conversationId: uuid,
          messageId: uuid,
          status: "answered",
          dataClass: "client_confidential",
          completedAt: "2026-11-13 09:00:00+00",
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          id: RUN_ID,
          conversationId: uuid,
          status: "answered",
          answerStatus: "answered",
          dataClass: "internal",
          policyRevision: 1,
          expertKey: "gpr-field-officer",
          expertVersions: ["gpr-field-officer@provisional-v0-unevaluated"],
          corpusGenerations: [],
          asOf: "2026-11-13 09:00:00+00",
          answer: answeredFixture(RUN_ID),
          startedAt: "2026-11-13 09:00:00+00",
          completedAt: "2026-11-13 09:00:00+00",
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          conversation: {
            id: uuid,
            expertKey: "gpr-field-officer",
            projectId: null,
            status: "open",
            createdAt: "2026-11-13 09:00:00+00",
            lastActivityAt: "2026-11-13 09:00:00+00",
          },
          messages: [],
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          conversations: [
            {
              id: uuid,
              expertKey: "gpr-field-officer",
              projectId: null,
              status: "open",
              createdAt: "2026-11-13 09:00:00+00",
              lastActivityAt: "2026-11-13 09:00:00+00",
            },
          ],
        }),
      },
    ]);

    await store.ensureConversation(context, { conversationId: uuid, expertKey: "gpr-field-officer", projectId: null });
    await store.appendUserMessage(context, {
      conversationId: uuid,
      clientMessageId: "cm-0001",
      bodyText: "Which grid was surveyed twice?",
      dataClass: "internal",
    });
    await store.startRun(context, {
      runId: RUN_ID,
      conversationId: uuid,
      idempotencyKey: "idem-0001",
      expertKey: "gpr-field-officer",
      userMessageId: uuid,
      dataClass: "internal",
    });
    await store.completeRun(context, { runId: RUN_ID, answer: answeredFixture(RUN_ID) });
    const run = await store.getRun(context, { runId: RUN_ID });
    const history = await store.loadConversation(context, { conversationId: uuid });
    const list = await store.listConversations(context, { limit: 20 });

    expect(transport.calls.map((call) => call.url.replace(`${BASE}/rpc/`, ""))).toEqual(Object.values(CHAT_RPCS));
    expect(transport.calls).toHaveLength(7);
    // A persisted answer reads back as the contract, not as a bag of jsonb.
    expect(run.ok && run.value.answer?.status).toBe("answered");
    expect(history.ok && history.value.conversation.id).toBe(uuid);
    expect(list.ok && list.value.conversations).toHaveLength(1);
  });
});

describe("the tenant cannot be chosen by the caller", () => {
  it("a `p_organisation_id` in the arguments is a compile error, pinned so the pin cannot rot", async () => {
    // `TenantRpcArgs` types that key as `never` (tenant-rpc.ts:58-64), and the helper spreads the
    // context's value last (tenant-rpc.ts:200-202). An unused directive is itself a typecheck failure,
    // so this line keeps failing if the compile-time guard is ever loosened.
    let sent: Record<string, unknown> | null = null;
    const outcome = await withTenantRpc(
      context,
      CHAT_RPCS.getRun,
      {
        p_run_id: RUN_ID,
        // @ts-expect-error choosing the tenant is not a caller's argument.
        p_organisation_id: ORG_COMPANY2,
      },
      USER_ACCESS_TOKEN,
      // Injected so this pin cannot open a socket: the point is the type, and the transport is not
      // what is under test here.
      {
        postgrestBaseUrl: BASE,
        fetchImpl: async (_url: string, init?: RequestInit) => {
          sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response("null", { status: 200 });
        },
      },
    );
    expect(outcome.ok).toBe(true);
    // Even reached through a cast, the context's organisation is what leaves the process: the helper
    // spreads the caller's arguments first and the tenant last (tenant-rpc.ts:200-202).
    expect(sent).toEqual({ p_run_id: RUN_ID, p_organisation_id: ORG_COMPANY1 });
    expect(JSON.stringify(sent)).not.toContain(ORG_COMPANY2);
  });

  it("no ChatStore method takes an organisation at all", () => {
    const methodNames = Object.keys(createChatStore({ accessToken: null }, { postgrestBaseUrl: BASE }));
    expect(methodNames.sort()).toEqual([
      "appendUserMessage",
      "completeRun",
      "ensureConversation",
      "getRun",
      "listConversations",
      "loadConversation",
      "startRun",
    ]);
  });

  it("an unbound PostgREST base is a named refusal with nothing dialled", async () => {
    const { transport } = storeFor([]);
    const unbound = createChatStore({ accessToken: USER_ACCESS_TOKEN }, { postgrestBaseUrl: undefined, fetchImpl: transport.fetchImpl });
    const result = await unbound.getRun(context, { runId: RUN_ID });
    expect(result).toEqual({ ok: false, kind: "not_configured", detail: "chat_get_run_v1:postgrest_base_unbound" });
    expect(transport.calls).toHaveLength(0);
  });

  it("no access token means no request: a chat call is never made unauthenticated or as another role", async () => {
    const { store, transport } = storeFor([], null);
    const result = await store.listConversations(context, { limit: 20 });
    expect(result).toEqual({ ok: false, kind: "not_configured", detail: "chat_list_conversations_v1:access_token_unbound" });
    expect(transport.calls).toHaveLength(0);
  });
});

describe("a database refusal is named, not smoothed into an empty result", () => {
  const cases: Array<{ code: string; status: number; kind: StoreFailure; detail: string }> = [
    // Not a member of this tenant: the sign-in surface, not an empty history page.
    { code: "28000", status: 403, kind: "membership", detail: "chat_load_conversation_v1:28000" },
    // Not this caller's row, or a citation it cannot re-authorize: a refusal, still not "nothing here".
    { code: "42501", status: 400, kind: "refused", detail: "chat_load_conversation_v1:42501" },
  ];

  for (const testCase of cases) {
    it(`SQLSTATE ${testCase.code} becomes ${testCase.kind}`, async () => {
      const { store } = storeFor([{ status: testCase.status, body: JSON.stringify({ code: testCase.code, message: "synthetic" }) }]);
      const result = await store.loadConversation(context, { conversationId: "4a000000-0000-4000-8000-000000000001" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect({ kind: result.kind, detail: result.detail }).toEqual({ kind: testCase.kind, detail: testCase.detail });
    });
  }

  it("a 5xx is a backend failure and the database's own words stop here", async () => {
    const leaky = JSON.stringify({ code: "PGRST-internal", details: "connection to pooler.internal.example refused" });
    const { store } = storeFor([{ status: 503, body: leaky }]);
    const result = await store.getRun(context, { runId: RUN_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("backend");
      expect(result.detail).toBe("chat_get_run_v1:server_error");
      expect(result.detail).not.toContain("pooler");
    }
  });

  it("a success body that does not match the contract never becomes a half-answer", async () => {
    const { store } = storeFor([{ status: 200, body: JSON.stringify({ id: RUN_ID }) }]);
    const result = await store.getRun(context, { runId: RUN_ID });
    expect(result).toEqual({ ok: false, kind: "backend", detail: "chat_get_run_v1:unparsable" });
  });

  it("an answer that carries a provider name or a signed URL is refused at the read boundary too", async () => {
    // The migration guards the write (035 tests 70-72); this guards the read, so a row that predates
    // the guard — or a future column — cannot put infrastructure identity in front of an employee.
    const smuggled = {
      ...answeredFixture(RUN_ID),
      claims: [{ ...(answeredFixture(RUN_ID).claims[0] as object), model: "hosted-gamma" }],
    };
    const { store } = storeFor([
      {
        status: 200,
        body: JSON.stringify({
          id: RUN_ID,
          conversationId: "4a000000-0000-4000-8000-000000000001",
          status: "answered",
          answerStatus: "answered",
          dataClass: "internal",
          policyRevision: 1,
          expertKey: "gpr-field-officer",
          expertVersions: [],
          corpusGenerations: [],
          asOf: "2026-11-13 09:00:00+00",
          answer: smuggled,
          startedAt: "2026-11-13 09:00:00+00",
          completedAt: "2026-11-13 09:00:00+00",
        }),
      },
    ]);
    const result = await store.getRun(context, { runId: RUN_ID });
    expect(result).toEqual({ ok: false, kind: "backend", detail: "chat_get_run_v1:unparsable" });
  });
});
