import { z } from "zod";

import { maxDataClass, type DataClass } from "@/contracts/data-class";
import type { TenantContext } from "@/contracts/tenant-context";
import { draftEvalCaseFromFeedback } from "@/platform/evals/draft-from-feedback";
import { SAFE_FAILURE_MESSAGE, type TenantFailureReason } from "@/platform/tenancy/resolve-tenant-context";
import { withTenantRpc, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import type { ChatSessionRead } from "./http";
import type { ChatStore } from "./store";

/**
 * T-302 answer feedback: Useful / Incorrect / Suggest correction on a delivered answer (plan §7.4).
 *
 * - The rating is one row per user per run, written by `rate_answer_v1` as the signed-in user; the
 *   run must be theirs, completed, in this tenant (pgTAP 085). Nothing here touches the answer.
 * - An Incorrect or Suggest-correction rating also drafts a `pilot` eval case (#102) through T-312's
 *   `draft_eval_case_from_feedback_v1`. Its question, expert and data class are read back **from the
 *   stored conversation** with the caller's own token — never from the request body — and the class
 *   is the highest of the question's and the run's (§6.2). A draft that cannot be made does not undo
 *   the rating; the response says which happened.
 * - Correction text is data: stored and shown to reviewers, never interpreted (AGENTS.md §4.8).
 */

export const FeedbackRequest = z.discriminatedUnion("kind", [
  z.strictObject({ runId: z.uuid(), kind: z.literal("useful") }),
  z.strictObject({ runId: z.uuid(), kind: z.literal("incorrect") }),
  z.strictObject({
    runId: z.uuid(),
    kind: z.literal("suggest_correction"),
    correctionText: z.string().trim().min(1).max(4000),
  }),
]);
export type FeedbackRequest = z.infer<typeof FeedbackRequest>;

export const FEEDBACK_MESSAGE = {
  saved: "Thanks — your feedback was saved.",
  refused: "This answer cannot be rated.",
  invalid: "Check the feedback and try again.",
  unavailable: "The service is temporarily unavailable. Please try again.",
  origin: "This request did not come from this workspace.",
} as const;

export interface FeedbackDeps {
  session: (request: Request) => Promise<ChatSessionRead>;
  store: (accessToken: string | null) => Pick<ChatStore, "getRun" | "loadConversation">;
  postgrestBaseUrl: string | undefined;
  fetchImpl?: FetchImpl;
}

const MAX_BODY = 8 * 1024;

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const SESSION_STATUS: Partial<Record<TenantFailureReason, number>> = {
  no_session: 401,
  not_a_member: 403,
  membership_not_active: 403,
  tenant_not_live: 409,
  backend_failure: 503,
};

/** The question and data class behind a run, read from the caller's own stored conversation. */
async function draftSource(
  store: Pick<ChatStore, "getRun" | "loadConversation">,
  context: TenantContext,
  runId: string,
): Promise<{ expertKey: string; question: string; dataClass: DataClass; messageId: string } | null> {
  const run = await store.getRun(context, { runId });
  if (!run.ok) return null;
  const history = await store.loadConversation(context, { conversationId: run.value.conversationId });
  if (!history.ok) return null;
  const ordered = [...history.value.messages].sort((a, b) => a.seq - b.seq);
  const answerIndex = ordered.findIndex((m) => m.role === "assistant" && m.runId === runId);
  if (answerIndex <= 0) return null;
  const answerMessage = ordered[answerIndex];
  const question = [...ordered.slice(0, answerIndex)].reverse().find((m) => m.role === "user");
  if (answerMessage === undefined || question === undefined) return null;
  return {
    expertKey: run.value.expertKey,
    question: question.bodyText,
    dataClass: maxDataClass([question.dataClass, run.value.dataClass]),
    messageId: answerMessage.id,
  };
}

export async function handleChatFeedback(request: Request, deps: FeedbackDeps): Promise<Response> {
  if (request.method !== "POST") return reply(405, { ok: false, message: "Method not allowed." });
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try {
    sameOrigin = origin !== null && origin === new URL(request.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return reply(403, { ok: false, code: "origin_mismatch", message: FEEDBACK_MESSAGE.origin });
  const media = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (media !== "application/json") return reply(415, { ok: false, code: "unsupported_media_type", message: FEEDBACK_MESSAGE.invalid });

  const session = await deps.session(request);
  if (!session.ok) {
    return reply(SESSION_STATUS[session.reason] ?? 404, { ok: false, code: session.reason, message: SAFE_FAILURE_MESSAGE[session.reason] });
  }

  const text = await request.text();
  if (text.length > MAX_BODY) return reply(413, { ok: false, code: "payload_too_large", message: FEEDBACK_MESSAGE.invalid });
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return reply(400, { ok: false, code: "invalid_request", message: FEEDBACK_MESSAGE.invalid });
  }
  const body = FeedbackRequest.safeParse(parsedJson);
  if (!body.success) return reply(422, { ok: false, code: "validation", message: FEEDBACK_MESSAGE.invalid });

  const rpcConfig = { postgrestBaseUrl: deps.postgrestBaseUrl, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) };
  const rated = await withTenantRpc(
    session.context,
    "rate_answer_v1",
    {
      p_run_id: body.data.runId,
      p_kind: body.data.kind,
      p_correction_text: body.data.kind === "suggest_correction" ? body.data.correctionText : null,
    },
    session.accessToken,
    rpcConfig,
  );
  if (!rated.ok) {
    if (rated.kind === "tenancy") return reply(403, { ok: false, code: "refused", message: FEEDBACK_MESSAGE.refused });
    if (rated.kind === "backend_failure" && (rated.sqlstate === "22023" || rated.sqlstate === "23514")) {
      return reply(422, { ok: false, code: "validation", message: FEEDBACK_MESSAGE.invalid });
    }
    return reply(503, { ok: false, code: "unavailable", message: FEEDBACK_MESSAGE.unavailable });
  }

  let evalDraft: "not_applicable" | "drafted" | "not_drafted" = "not_applicable";
  if (body.data.kind !== "useful" && session.accessToken !== null) {
    evalDraft = "not_drafted";
    const source = await draftSource(deps.store(session.accessToken), session.context, body.data.runId);
    if (source !== null) {
      const drafted = await draftEvalCaseFromFeedback(
        session.context,
        session.accessToken,
        {
          expertKey: source.expertKey,
          question: source.question,
          dataClass: source.dataClass,
          rating: body.data.kind,
          derivedFromRunId: body.data.runId,
          derivedFromMessageId: source.messageId,
          ...(body.data.kind === "suggest_correction" ? { payload: { correction: body.data.correctionText } } : {}),
        },
        rpcConfig,
      );
      // A second Incorrect on the same message hits the unique pilot index: the draft already exists.
      evalDraft = drafted.ok ? "drafted" : "not_drafted";
    }
  }
  return reply(200, { ok: true, message: FEEDBACK_MESSAGE.saved, evalDraft });
}
