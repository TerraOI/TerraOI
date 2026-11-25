import { describe, expect, it } from "vitest";

import { contextFor, RUN_ID, CONVERSATION_ID, USER_ACCESS_TOKEN } from "./chat-fixtures";
import { FEEDBACK_MESSAGE, handleChatFeedback, type FeedbackDeps } from "./feedback";
import type { ChatStore, ConversationHistory, StoredRun } from "./store";

const HOST = "https://company1.terraoi.app";
const QUESTION_MSG = "4c000000-0000-4000-8000-000000000001";
const ANSWER_MSG = "4c000000-0000-4000-8000-000000000002";

const run: StoredRun = {
  id: RUN_ID,
  conversationId: CONVERSATION_ID,
  status: "refused",
  answerStatus: "refused",
  dataClass: "internal",
  policyRevision: 1,
  expertKey: "gpr-field-officer",
  expertVersions: ["gpr-field-officer@v1"],
  corpusGenerations: [],
  asOf: "2026-11-25 09:05:00+00",
  withheld: false,
  answer: null,
  startedAt: "2026-11-25 09:00:00+00",
  completedAt: "2026-11-25 09:05:00+00",
};

const history: ConversationHistory = {
  conversation: {
    id: CONVERSATION_ID,
    expertKey: "gpr-field-officer",
    projectId: null,
    status: "open",
    createdAt: "2026-11-25 09:00:00+00",
    lastActivityAt: "2026-11-25 09:05:00+00",
  },
  messages: [
    { id: QUESTION_MSG, seq: 1, role: "user", bodyText: "Synthetic: was grid four flown twice?", dataClass: "client_confidential", createdAt: "x", runId: null, run: null },
    { id: ANSWER_MSG, seq: 2, role: "assistant", bodyText: "Synthetic refusal.", dataClass: "internal", createdAt: "x", runId: RUN_ID, run: null },
  ],
};

function deps(rpcAnswer: (rpc: string, body: Record<string, unknown>) => Response, session: FeedbackDeps["session"] | null = null) {
  const calls: { rpc: string; body: Record<string, unknown> }[] = [];
  const store: Pick<ChatStore, "getRun" | "loadConversation"> = {
    getRun: async () => ({ ok: true, value: run }),
    loadConversation: async () => ({ ok: true, value: history }),
  };
  const d: FeedbackDeps = {
    session: session ?? (async () => ({ ok: true, context: contextFor(), accessToken: USER_ACCESS_TOKEN })),
    store: () => store,
    postgrestBaseUrl: "https://db.example.test/rest/v1",
    fetchImpl: async (url, init) => {
      const rpc = url.split("/rpc/")[1] ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ rpc, body });
      return rpcAnswer(rpc, body);
    },
  };
  return { d, calls };
}

const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function post(body: unknown, origin: string | null = HOST) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${HOST}/chat/feedback`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("handleChatFeedback (T-302)", () => {
  it("a Useful rating writes one rating row and nothing else", async () => {
    const { d, calls } = deps(() => ok("85d00000-0000-4000-8000-000000000001"));
    const response = await handleChatFeedback(post({ runId: RUN_ID, kind: "useful" }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: FEEDBACK_MESSAGE.saved, evalDraft: "not_applicable" });
    expect(calls.map((c) => c.rpc)).toEqual(["rate_answer_v1"]);
    expect(calls[0]?.body).toEqual({ p_run_id: RUN_ID, p_kind: "useful", p_correction_text: null, p_organisation_id: contextFor().organisationId });
  });

  it("Suggest correction carries its text into the rating and drafts a pilot case from the stored question, at the highest class", async () => {
    const { d, calls } = deps((rpc) => ok(rpc === "rate_answer_v1" ? "85d00000-0000-4000-8000-000000000001" : "e3030000-0000-4000-8000-000000000009"));
    const response = await handleChatFeedback(post({ runId: RUN_ID, kind: "suggest_correction", correctionText: "It was flown twice." }), d);
    expect(await response.json()).toMatchObject({ ok: true, evalDraft: "drafted" });
    expect(calls[0]?.body.p_correction_text).toBe("It was flown twice.");
    const draft = calls[1];
    expect(draft?.rpc).toBe("draft_eval_case_from_feedback_v1");
    const body = draft?.body.p_body as Record<string, unknown>;
    expect(body.question).toBe("Synthetic: was grid four flown twice?");
    expect(body.data_class).toBe("client_confidential");
    expect(body.derived_from_run_id).toBe(RUN_ID);
    expect(body.derived_from_message_id).toBe(ANSWER_MSG);
    expect(body.expert_key).toBe("gpr-field-officer");
  });

  it("the rating stands when the eval draft cannot be made, and says so", async () => {
    const { d } = deps((rpc) =>
      rpc === "rate_answer_v1" ? ok("85d00000-0000-4000-8000-000000000001") : new Response(JSON.stringify({ code: "23505" }), { status: 409 }),
    );
    const response = await handleChatFeedback(post({ runId: RUN_ID, kind: "incorrect" }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, evalDraft: "not_drafted" });
  });

  it("someone else's run (42501) is a refusal, and no draft is attempted", async () => {
    const { d, calls } = deps(() => new Response(JSON.stringify({ code: "42501" }), { status: 403 }));
    const response = await handleChatFeedback(post({ runId: RUN_ID, kind: "incorrect" }), d);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [{ runId: RUN_ID, kind: "suggest_correction", correctionText: "" }],
    [{ runId: RUN_ID, kind: "suggest_correction", correctionText: "x".repeat(4001) }],
    [{ runId: RUN_ID, kind: "useful", correctionText: "x" }],
    [{ runId: RUN_ID, kind: "useful", organisationId: "22222222-2222-4222-8222-222222222222" }],
    [{ runId: "not-a-uuid", kind: "useful" }],
  ])("rejects %j before any database call", async (body) => {
    const { d, calls } = deps(() => ok("x"));
    const response = await handleChatFeedback(post(body), d);
    expect(response.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("refuses a cross-site or missing origin and an unsigned-in caller", async () => {
    const { d, calls } = deps(() => ok("x"));
    expect((await handleChatFeedback(post({ runId: RUN_ID, kind: "useful" }, "https://company2.terraoi.app"), d)).status).toBe(403);
    expect((await handleChatFeedback(post({ runId: RUN_ID, kind: "useful" }, null), d)).status).toBe(403);
    const signedOut = deps(() => ok("x"), async () => ({ ok: false, reason: "no_session" }));
    expect((await handleChatFeedback(post({ runId: RUN_ID, kind: "useful" }), signedOut.d)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
