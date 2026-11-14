import { describe, expect, it } from "vitest";

import {
  CONVERSATION_ID,
  RecordingStore,
  USER_ACCESS_TOKEN,
  catalogWith,
  contextFor,
  searchReturning,
} from "./chat-fixtures";
import type { TenantFailureReason } from "@/platform/tenancy/resolve-tenant-context";
import type { ChatHttpDeps, ChatSessionRead } from "./http";
import { MAX_CHAT_BODY_BYTES, chatRequest } from "./http";
import type { ExpertCatalog } from "./deps";

/**
 * The HTTP surface (packet: "a client that posts `organisationId`, `userId`, `role` or `host` gets a
 * 400, and those keys never reach the run"). Every case here is checked twice: on the status the
 * employee gets, and on the count of store constructions — because a request that reached the store
 * has already cost a tenant lookup, a row, or a model call, and a malformed or unpermitted request
 * must cost none of that.
 *
 * The bodies are checked for what they must **not** contain: a SQLSTATE, a table name, a provider, a
 * model, an organisation id. A status code is allowed to be coarse; an error body is not allowed to
 * be a diagnosis (plan §8.2, `SAFE_FAILURE_MESSAGE`).
 */

const KEY = "gpr-field-officer";
const GRANT = { expertKey: KEY, serviceKey: "uav-compliance" };
const QUESTION = "Was grid four surveyed twice?";

function body(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: CONVERSATION_ID,
    clientMessageId: "cm-0001",
    idempotencyKey: "idem-0001",
    expertKey: KEY,
    messages: [{ role: "user", parts: [{ type: "text", text: QUESTION }] }],
    ...overrides,
  };
}

function post(payload: unknown, init: { headers?: Record<string, string> } = {}): Request {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Request("https://company1.terraoi.app/api/chat", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** Everything one request exposes to a test: what the employee sees, and what it cost. */
interface AskResult {
  text: string;
  status: number;
  json: Record<string, string>;
  outcome: unknown;
  refusedFrames: number;
  /** How many times the handler built per-request run deps: 0 for any request it refused. */
  runDepsCalls: () => number;
}

interface HttpHarness {
  deps: ChatHttpDeps;
  store: RecordingStore;
  runDepsCalls: () => number;
  ask: (payload: unknown) => Promise<AskResult>;
}

function httpHarness(
  options: {
    session?: () => Promise<ChatSessionRead>;
    catalog?: ExpertCatalog;
    store?: RecordingStore;
  } = {},
): HttpHarness {
  const store = options.store ?? new RecordingStore();
  let built = 0;
  const deps: ChatHttpDeps = {
    session:
      options.session ??
      (async () => ({ ok: true as const, context: contextFor(), accessToken: USER_ACCESS_TOKEN })),
    catalog: options.catalog ?? catalogWith(GRANT),
    runDeps: () => {
      built += 1;
      return { store, search: searchReturning({ packs: [] }), gateway: null };
    },
  };
  return {
    deps,
    store,
    runDepsCalls: () => built,
    ask: async (payload: unknown) => {
      const handled = await chatRequest(post(payload), deps);
      const text = await handled.response.text();
      const outcome = await handled.outcome;
      const json = text.length > 0 && handled.response.headers.get("content-type")?.includes("json")
        ? (JSON.parse(text) as Record<string, string>)
        : {};
      return {
        text,
        status: handled.response.status,
        json,
        outcome,
        refusedFrames: handled.refusedFrames(),
        // Read from the same closure the deps were built in: a refusal that built no store never got
        // as far as a credential, a row or a provider.
        runDepsCalls: () => built,
      };
    },
  };
}

describe("a posted identity is refused before anything happens", () => {
  const FORGED: Array<Record<string, unknown>> = [
    { organisationId: "11111111-1111-4111-8111-111111111111" },
    { userId: "00000000-0000-4000-8000-0000000000a2" },
    { role: "admin" },
    { host: "company2.terraoi.app" },
    { membershipId: "6a000000-0000-4000-8000-000000000001" },
    { policyRevision: 99 },
  ];

  for (const forged of FORGED) {
    const key = Object.keys(forged)[0] as string;
    it(`400s a body carrying ${key}, and builds no store for it`, async () => {
      const h = httpHarness();
      const result = await h.ask(body(forged));
      expect(result.status).toBe(400);
      expect(result.json.error).toBe("invalid_envelope");
      expect(result.runDepsCalls()).toBe(0);
      expect(h.store.calls).toEqual([]);
      // The value the client tried to smuggle is not echoed back.
      expect(result.text).not.toContain(String(Object.values(forged)[0]));
    });
  }

  it("400s a body that is not JSON, and 413 one that is too large", async () => {
    const h = httpHarness();
    expect((await h.ask("{ not json")).status).toBe(400);
    const oversized = await h.ask(body({ messages: [{ role: "user", parts: [{ type: "text", text: "x".repeat(MAX_CHAT_BODY_BYTES + 10) }] }] }));
    expect(oversized.status).toBe(413);
    expect(oversized.runDepsCalls()).toBe(0);
  });

  it("400s a body with no question in it", async () => {
    const h = httpHarness();
    const result = await h.ask(body({ messages: [{ role: "assistant", parts: [{ type: "text", text: "talking for the user" }] }] }));
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("no_user_message");
  });
});

describe("tenancy and session come from the request, not the body", () => {
  const sessionCases: Array<{ reason: TenantFailureReason; status: number; message: string }> = [
    { reason: "no_session", status: 401, message: "Please sign in to continue." },
    { reason: "not_a_member", status: 403, message: "You do not have access to this workspace." },
    { reason: "membership_not_active", status: 403, message: "Your access to this workspace has ended." },
    { reason: "unknown_host", status: 404, message: "This address is not recognized." },
    { reason: "tenant_not_live", status: 409, message: "This workspace is not available right now." },
    { reason: "backend_failure", status: 503, message: "The service is temporarily unavailable. Please try again." },
  ];

  for (const testCase of sessionCases) {
    it(`${testCase.reason} answers ${testCase.status} with a safe sentence`, async () => {
      const h = httpHarness({ session: async () => ({ ok: false, reason: testCase.reason }) });
      const result = await h.ask(body());
      expect(result.status).toBe(testCase.status);
      expect(result.json.message).toBe(testCase.message);
      expect(result.runDepsCalls()).toBe(0);
    });
  }

  it("an expired or forged session is a sign-in prompt on a live tenant, never an empty answer", async () => {
    const h = httpHarness({ session: async () => ({ ok: false, reason: "no_session" }) });
    const result = await h.ask(body());
    expect(result.status).toBe(401);
    expect(h.store.calls).toEqual([]);
  });
});

describe("an expert the employee may not use", () => {
  it("403s before the stream opens, and says nothing about which experts exist", async () => {
    const h = httpHarness({ catalog: catalogWith({ expertKey: "some-other-expert", serviceKey: "uav-compliance" }) });
    const result = await h.ask(body());
    expect(result.status).toBe(403);
    expect(result.json.error).toBe("expert_not_permitted");
    expect(result.text).not.toContain("some-other-expert");
    expect(result.runDepsCalls()).toBe(0);
  });

  it("a projectId outside the member's permitted projects is out of scope (#16 N5)", async () => {
    const h = httpHarness({
      session: async () => ({ ok: true as const, context: contextFor({ permittedProjectIds: [] }), accessToken: USER_ACCESS_TOKEN }),
    });
    const result = await h.ask(body({ projectId: "41000000-0000-4000-8000-000000000001" }));
    expect(result.status).toBe(403);
    expect(result.json.error).toBe("out_of_scope");
    expect(result.text).not.toContain("41000000");
    expect(result.runDepsCalls()).toBe(0);
  });

  it("a member with no permitted services cannot ask at all (fail closed, #175)", async () => {
    const h = httpHarness({
      session: async () => ({ ok: true as const, context: contextFor({ permittedServiceKeys: [] }), accessToken: USER_ACCESS_TOKEN }),
    });
    const result = await h.ask(body());
    expect(result.status).toBe(403);
    expect(result.json.error).toBe("out_of_scope");
  });
});

describe("the stream itself", () => {
  it("200s as an event stream: progress frames, one final answer, nothing refused", async () => {
    const h = httpHarness();
    const handled = await chatRequest(post(body()), h.deps);
    expect(handled.response.status).toBe(200);
    expect(handled.response.headers.get("content-type")).toContain("text/event-stream");
    expect(handled.response.headers.get("cache-control")).toContain("no-store");

    const text = await handled.response.text();
    const outcome = await handled.outcome;

    const records = text.split("\n\n").filter((block) => block.length > 0);
    expect(records.at(-1)?.startsWith("event: answer")).toBe(true);
    expect(records.slice(0, -1).every((block) => block.startsWith("event: progress"))).toBe(true);
    expect(handled.refusedFrames()).toBe(0);

    // The question, the run and the refusal were all written before the answer frame was sent.
    expect(h.store.calls.map((call) => call.name)).toEqual([
      "ensureConversation",
      "appendUserMessage",
      "startRun",
      "getRun",
      "completeRun",
    ]);
    expect(h.store.completed[0]?.status).toBe("refused");
    expect(outcome).toMatchObject({ kind: "delivered", status: "refused", persisted: true });
  });

  it("no frame and no error body names a provider, a model, a table or a SQLSTATE", async () => {
    const store = new RecordingStore();
    store.answers.completeRun = { ok: false, kind: "refused", detail: "chat_complete_run_v1:42501" };
    const h = httpHarness({ store });
    const handled = await chatRequest(post(body()), h.deps);
    const text = await handled.response.text();

    for (const needle of ["chat_complete_run_v1", "agent_runs", "42501", "28000", "claude", "local_box", "hosted-gamma", "p_organisation_id"]) {
      expect(text).not.toContain(needle);
    }
    // The write was refused, so what the employee gets is the expert's published unavailable
    // sentence — claim-free by construction — and never the answer that could not be audited.
    const frame = recordsOf(text).at(-1) ?? "";
    expect(frame).toContain("could not answer just now");
    // Empty for a reason, not empty by accident: the withheld claims never left the server.
    expect(frame).toContain('"claims":[]');
  });

  it("a mid-run store failure ends the stream rather than hanging it", async () => {
    const store = new RecordingStore();
    store.answers.startRun = { ok: false, kind: "refused", detail: "chat_start_run_v1:42501" };
    const h = httpHarness({ store });
    const handled = await chatRequest(post(body()), h.deps);
    const text = await handled.response.text();
    const outcome = await handled.outcome;
    expect(outcome).toMatchObject({ kind: "store_failure", stage: "run", failure: "refused" });
    // No answer frame was emitted, and the stream still terminated.
    expect(text).not.toContain("event: answer");
    expect(recordsOf(text).every((record) => record.startsWith("event: progress"))).toBe(true);
  });

  it("the waitUntil hook is offered the run, so a Worker cannot cut it mid-write", async () => {
    let awaited = 0;
    const deps: ChatHttpDeps = {
      ...httpHarness().deps,
      waitUntil: () => {
        awaited += 1;
      },
    };
    const handled = await chatRequest(post(body()), deps);
    await handled.response.text();
    await handled.outcome;
    expect(awaited).toBe(1);
  });
});

function recordsOf(text: string): string[] {
  return text.split("\n\n").filter((block) => block.length > 0);
}
