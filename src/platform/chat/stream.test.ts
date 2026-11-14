import { describe, expect, it } from "vitest";

import { RUN_ID, answeredFixture, CONVERSATION_ID, refusedAnswer } from "./chat-fixtures";
import type { ChatFrame } from "./envelope";
import { ANSWER_EVENT_NAME, PROGRESS_EVENT_NAME, createFrameChannel, encodeFrame, readChatStream, sseResponse } from "./stream";

/**
 * The transport's own guard (plan §9.3, F22). If "no factual token before the answer is verified and
 * persisted" is only a property of `run-chat.ts`'s control flow, it survives one refactor for as long
 * as nobody writes the other order. Encoding is where the rule is enforced, so that is where it is
 * tested.
 */

const progressFrame: ChatFrame = {
  kind: "progress",
  event: {
    type: "searching",
    runId: RUN_ID,
    conversationId: CONVERSATION_ID,
    emittedAt: "2026-11-13T09:00:00.000Z",
    retrievalMode: "lexical_only",
  },
};

function answerFrame(persisted: boolean): ChatFrame {
  return { kind: "answer", answer: answeredFixture(RUN_ID), persisted };
}

describe("encodeFrame", () => {
  it("sends a progress frame as its own event, with no text field to leak", () => {
    const encoded = encodeFrame(progressFrame);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.text.startsWith(`event: ${PROGRESS_EVENT_NAME}`)).toBe(true);
    expect(encoded.text.endsWith("\n\n")).toBe(true);
    expect(encoded.text).not.toContain("Which grid");
  });

  it("refuses an answer that carries claims without the durable write behind it", () => {
    expect(encodeFrame(answerFrame(false))).toEqual({ ok: false, reason: "answer_not_persisted" });
  });

  it("sends the same answer once it is persisted", () => {
    const encoded = encodeFrame(answerFrame(true));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.text.startsWith(`event: ${ANSWER_EVENT_NAME}`)).toBe(true);
    expect(encoded.text).toContain("second pass is required");
  });

  it("a claim-free template answer needs no write, because it states no fact about the corpus", () => {
    const encoded = encodeFrame({ kind: "answer", answer: refusedAnswer(RUN_ID, "Nothing in the documents you are allowed to read answers this question."), persisted: false });
    expect(encoded.ok).toBe(true);
  });

  it("validates against the merged contracts on the way out", () => {
    // A progress frame naming a provider is unrepresentable, so it cannot be smuggled through here
    // even by a caller that builds the object by hand (contracts/chat.ts:59-78).
    const forged = {
      kind: "progress",
      event: {
        type: "tier_changed",
        runId: RUN_ID,
        conversationId: CONVERSATION_ID,
        emittedAt: "2026-11-13T09:00:00.000Z",
        fromTier: 1,
        toTier: 2,
        provider: "claude",
        reason: "clearance",
      },
    } as unknown as ChatFrame;
    expect(() => encodeFrame(forged)).toThrow();
  });
});

describe("the stream an employee's browser sees", () => {
  it("progress frames flow before the answer, and the answer is last", async () => {
    const channel = createFrameChannel();
    const { response, refused } = sseResponse(channel);

    channel.push(progressFrame);
    channel.push(progressFrame);
    channel.push(answerFrame(true));
    channel.close();

    const body = await response.text();
    const records = body.split("\n\n").filter((block) => block.length > 0);
    expect(records.map((block) => block.split("\n")[0])).toEqual([
      `event: ${PROGRESS_EVENT_NAME}`,
      `event: ${PROGRESS_EVENT_NAME}`,
      `event: ${ANSWER_EVENT_NAME}`,
    ]);
    expect(refused).toEqual([]);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("a refused frame ends the stream without sending the answer", async () => {
    const channel = createFrameChannel();
    const { response, refused } = sseResponse(channel);

    channel.push(progressFrame);
    channel.push(answerFrame(false));

    const body = await response.text();
    expect(body).not.toContain("second pass is required");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.kind).toBe("answer");
  });

  it("reads back as typed frames, and stops at the answer", async () => {
    const channel = createFrameChannel();
    const { response } = sseResponse(channel);
    channel.push(progressFrame);
    channel.push(answerFrame(true));
    channel.close();

    const read = readChatStream(response);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const seen: string[] = [];
    for await (const frame of read.frames) {
      seen.push(frame.kind === "progress" ? frame.event.type : `answer:${frame.answer.status}`);
    }
    expect(seen).toEqual(["searching", `answer:${answeredFixture(RUN_ID).status}`]);
  });

  it("an unreadable frame stops the read rather than being skipped", async () => {
    const response = new Response(
      `event: progress\ndata: {"type":"searching"}\n\n`, // no runId: not a valid ProgressEvent
      { headers: { "content-type": "text/event-stream" } },
    );
    const read = readChatStream(response);
    if (!read.ok) throw new Error("the fixture should be readable");
    const seen: ChatFrame[] = [];
    for await (const frame of read.frames) seen.push(frame);
    expect(seen).toEqual([]);
  });

  it("a non-2xx or bodyless response is a transport failure, not an empty answer", async () => {
    expect(readChatStream(new Response(null, { status: 503 }))).toEqual({ ok: false, reason: "transport" });
  });
});
