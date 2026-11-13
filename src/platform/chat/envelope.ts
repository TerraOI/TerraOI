import { z } from "zod";

import { ChatRequest, type ProgressEvent } from "@/contracts/chat";
import { ExpertKey, OpaqueId } from "@/contracts/keys";

/**
 * The request envelope, and the only place its shape is written down (plan §9.2,
 * docs/contracts/chat-protocol.md).
 *
 * There is no AI SDK in this repository (see `package.json`): the client half of F21 is a plain
 * `fetch` against `/api/chat`, so the envelope below is the wire contract, stated here rather than
 * imported from a package whose internals would then decide what a tenant request may contain. The
 * **logical** contract stays `ChatRequest` in `src/contracts/chat.ts` — this module only normalizes
 * into it, exactly as the protocol document requires, and adds nothing to it.
 *
 * Four things this boundary is responsible for:
 *
 * 1. **No tenant, user, role, host, model or provider key can be posted.** The envelope is a
 *    strictObject, so any such top-level key is an unknown key and fails (packet: "a client that
 *    posts `organisationId`, `userId`, `role` or `host` gets a 400"). The refusal says only that the
 *    request was not understood: the names of the rejected keys are not echoed, because a validation
 *    message that lists them is a map of what not to send (plan §8.2).
 * 2. **The transcript is not history.** Only the newest `user` turn is read; every other turn is
 *    dropped, and dropping is recorded as a count rather than an error, because a browser replaying
 *    its own transcript is normal traffic and the forged content must simply not be used (F17).
 * 3. **Ids the client may choose are still validated.** `conversationId` and `clientMessageId` are
 *    client-side ids for a new conversation (plan §9.2), so they are checked against `OpaqueId` and
 *    generated here when absent; nothing downstream has to know which happened.
 * 4. **`projectId` is a filter, not a grant** (issue #16 N5) — checked against the context in
 *    `run-chat.ts`, never here, because this module has no idea who is asking.
 */

const EnvelopeMessage = z.strictObject({
  id: OpaqueId.optional(),
  role: z.string().min(1).max(32),
  parts: z.array(z.unknown()).max(64).default([]),
});

export const ChatEnvelope = z.strictObject({
  // `ChatRequest.conversationId` is an `OpaqueId`, but **this** packet's conversation table is
  // uuid-keyed and every read RPC takes a uuid (`20261113020000_chat_persistence.sql`), so the
  // envelope narrows it here rather than letting an unparseable id reach PostgREST and come back as
  // a `backend` failure. It stays a client-chosen id for a new conversation, which is what plan §9.2
  // asks for, and the ids this module generates are uuids.
  conversationId: z.uuid().optional(),
  clientMessageId: OpaqueId.optional(),
  // The same key across a retry, a reconnect or a resume; a deliberate new question gets a new one.
  idempotencyKey: OpaqueId,
  expertKey: ExpertKey,
  projectId: z.uuid().optional(),
  attachmentIds: z.array(OpaqueId).max(10).optional(),
  messages: z.array(EnvelopeMessage).min(1).max(200),
});
export type ChatEnvelope = z.infer<typeof ChatEnvelope>;

export type EnvelopeRejection =
  /** Not the envelope at all, or it carries a key this contract has no place for. */
  | "invalid_envelope"
  /** No usable user turn: an empty question, or a transcript with no question in it. */
  | "no_user_message"
  /** The question text is not a `ChatRequest.message.text`. */
  | "invalid_question";

export type EnvelopeRead =
  | { ok: true; request: ChatRequest; droppedTurns: number }
  | { ok: false; reason: EnvelopeRejection };

/** A turn role the client may legitimately send in M1: its own question, and nothing else. */
const CLIENT_TURN_ROLE = "user";

function newTextId(): string {
  return crypto.randomUUID();
}

/** The text parts of one turn, concatenated in order. Non-text parts are ignored, not errors. */
function textOfParts(parts: readonly unknown[]): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") pieces.push(candidate.text);
  }
  return pieces.join("\n").trim();
}

/**
 * Parse and normalize. Returns a `ChatRequest` or a reason; it never throws on request content, so a
 * route can answer 400 without a try/catch around the run.
 */
export function readChatEnvelope(body: unknown): EnvelopeRead {
  const parsed = ChatEnvelope.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "invalid_envelope" };
  const envelope = parsed.data;

  // Newest user turn wins, and only user turns are read at all: a forged assistant, system or tool
  // turn in the body is dropped here, so it cannot reach the run, the prompt or the history (F17).
  let question: string | null = null;
  let clientMessageId: string | null = null;
  let droppedTurns = 0;
  for (const message of envelope.messages) {
    if (message.role !== CLIENT_TURN_ROLE) {
      droppedTurns += 1;
      continue;
    }
    const text = textOfParts(message.parts);
    if (text.length === 0) continue;
    question = text;
    clientMessageId = message.id ?? null;
  }
  if (question === null) return { ok: false, reason: "no_user_message" };

  const candidate = {
    conversationId: envelope.conversationId ?? newTextId(),
    clientMessageId: envelope.clientMessageId ?? clientMessageId ?? newTextId(),
    idempotencyKey: envelope.idempotencyKey,
    expertKey: envelope.expertKey,
    ...(envelope.projectId === undefined ? {} : { projectId: envelope.projectId }),
    message: { text: question },
    attachmentIds: envelope.attachmentIds ?? [],
  };

  // Validated against the merged contract, so `ChatRequest` — not this module — is what decides what
  // a question may be, and a request that passes here cannot fail later for a shape reason.
  const request = ChatRequest.safeParse(candidate);
  if (!request.success) return { ok: false, reason: "invalid_question" };
  return { ok: true, request: request.data, droppedTurns };
}

/**
 * What may cross the wire before an answer exists: the five `ProgressEvent` types and nothing else
 * (plan §9.3). `Answer` is a separate frame type, so a stream can be checked structurally rather than
 * by trusting the producer — see `stream.ts` and `run-chat.test.ts`.
 *
 * `persisted` is part of the frame, not a hint in the caller's head: it records that
 * `chat_complete_run_v1` — the re-authorization and audit write — accepted this answer. The encoder
 * refuses any frame carrying claims without it (F22), which is what makes "no factual token before
 * the answer is verified and persisted" a property of the transport instead of a promise about the
 * code path.
 */
export type ChatFrame =
  | { kind: "progress"; event: ProgressEvent }
  | { kind: "answer"; answer: import("@/contracts/answer").Answer; persisted: boolean };
