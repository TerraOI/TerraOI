import { Answer } from "@/contracts/answer";
import { ProgressEvent } from "@/contracts/chat";

import type { ChatFrame } from "./envelope";

/**
 * The wire: server-sent events, one final answer frame, and a transport-level gate on what an answer
 * frame may carry (plan §9.1-§9.3, TOI-ADR-07, F22).
 *
 * There is no AI SDK in this repository (`package.json`), so the client half of F21 is a plain
 * `fetch` plus the reader at the bottom of this file, and the frame format is ours to state:
 *
 * ```text
 * event: progress
 * data: {"type":"searching","runId":"…","conversationId":"…","emittedAt":"…"}
 *
 * event: answer
 * data: { …one Answer… }
 * ```
 *
 * Two things the format is chosen to make hard:
 *
 * - **A stream that starts before the answer exists must say nothing factual.** Progress frames carry
 *   the five `ProgressEvent` types and no text field (`contracts/chat.ts`); the final frame is one
 *   whole `Answer`, never a token-by-token candidate (§9.3 — "progress only until verified").
 * - **The transport refuses, not just the caller.** `encodeFrame` declines any answer frame that
 *   carries claims without `persisted: true` (see `envelope.ts`), so a future caller that forgets the
 *   order cannot leak an unverified or unwritten answer. A claim-free template answer is allowed
 *   unpersisted, because its only text is the expert's own published refusal sentence.
 *
 * Both event names are validated against the merged contracts on the way out and on the way back in,
 * so a malformed frame is a loud failure in our own code rather than a partially-rendered answer in
 * front of an employee (AGENTS.md §2).
 */

export const PROGRESS_EVENT_NAME = "progress";
export const ANSWER_EVENT_NAME = "answer";

/** No caching anywhere between the Worker and the employee: a run's frames are per-user, per-run. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform, must-revalidate",
  "x-content-type-options": "nosniff",
};

export type FrameEncoding =
  | { ok: true; text: string }
  | { ok: false; reason: "answer_not_persisted" };

/** One SSE record: `event:` name, one `data:` line, blank line. No multi-line payloads. */
function sseRecord(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function encodeFrame(frame: ChatFrame): FrameEncoding {
  if (frame.kind === "progress") {
    // A progress frame we cannot validate is a bug in this repository, not bad input: the values are
    // built here from the context and the run. Throwing surfaces it instead of showing a wrong label.
    return { ok: true, text: sseRecord(PROGRESS_EVENT_NAME, ProgressEvent.parse(frame.event)) };
  }
  const answer = Answer.parse(frame.answer);
  if (answer.claims.length > 0 && !frame.persisted) return { ok: false, reason: "answer_not_persisted" };
  return { ok: true, text: sseRecord(ANSWER_EVENT_NAME, answer) };
}

export interface FrameChannel {
  push(frame: ChatFrame): void;
  close(): void;
  /** The consumer side, awaited by the writer. */
  read(): AsyncGenerator<ChatFrame>;
}

/**
 * A one-producer/one-consumer queue, so `runChat` can emit a progress frame the moment the stage
 * starts rather than buffering the turn. `close()` after at most one answer frame is the producer's
 * contract; the reader does not enforce it because the writer stops after the answer anyway.
 */
export function createFrameChannel(): FrameChannel {
  const queue: ChatFrame[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  return {
    push(frame) {
      if (closed) return;
      queue.push(frame);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *read() {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export interface SseResponse {
  response: Response;
  /**
   * Frames the transport refused and therefore never sent. A route logs this: a refused frame means
   * a caller broke the persist-before-deliver order, which is a defect to find, not a condition to
   * render (it is also the assertion `http.test.ts` reads).
   */
  refused: ChatFrame[];
}

export function sseResponse(channel: FrameChannel): SseResponse {
  const refused: ChatFrame[] = [];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const reader = channel.read();
      for await (const frame of reader) {
        const encoded = encodeFrame(frame);
        if (!encoded.ok) {
          refused.push(frame);
          // Nothing more is sent for this run: a stream that cannot carry its answer ends, and the
          // client's reader sees an incomplete turn rather than an unverified one.
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encoded.text));
        if (frame.kind === "answer") {
          controller.close();
          return;
        }
      }
      controller.close();
    },
  });
  return { response: new Response(stream, { headers: SSE_HEADERS }), refused };
}

// ---------------------------------------------------------------- client half (F21)
export type StreamRejection = "invalid_frame" | "transport";

export type StreamRead =
  | { ok: true; frames: AsyncGenerator<ChatFrame> }
  | { ok: false; reason: StreamRejection };

function parseEventBlock(block: string): ChatFrame | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (event === null || data.length === 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n")) as unknown;
  } catch {
    return null;
  }
  if (event === PROGRESS_EVENT_NAME) {
    const parsed = ProgressEvent.safeParse(payload);
    return parsed.success ? { kind: "progress", event: parsed.data } : null;
  }
  if (event === ANSWER_EVENT_NAME) {
    const parsed = Answer.safeParse(payload);
    // A frame that arrives over the wire has already passed the server's gate, so the client records
    // it as persisted; the gate that matters is the server's (`encodeFrame`), and the browser is not
    // the thing that decides what was written.
    return parsed.success ? { kind: "answer", answer: parsed.data, persisted: true } : null;
  }
  return null;
}

/**
 * Read the server's stream as typed frames. A frame that does not validate stops the read rather than
 * being skipped: an unrecognized shape is either a proxy mangling the stream or a server bug, and
 * guessing at either is how a half-answer gets shown (fail closed, AGENTS.md §2).
 */
export function readChatStream(response: Response): StreamRead {
  if (!response.ok || response.body === null) return { ok: false, reason: "transport" };
  return { ok: true, frames: framesOf(response.body) };
}

async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let done = false;
  while (!done) {
    const next = await reader.read();
    done = next.done;
    if (!done) buffer += decoder.decode(next.value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseEventBlock(block);
      // An unreadable frame ends the read: the panel keeps what it already showed and stops, rather
      // than rendering a guess at a shape it does not understand.
      if (frame === null) return;
      yield frame;
      if (frame.kind === "answer") return;
    }
  }
}
