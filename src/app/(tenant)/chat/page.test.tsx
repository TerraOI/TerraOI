// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { answeredFixture, refusedAnswer, RUN_ID } from "@/platform/chat/chat-fixtures";
import type { ChatFrame } from "@/platform/chat/envelope";
import { createFrameChannel, sseResponse } from "@/platform/chat/stream";

import { ChatPanel } from "./chat-panel";

/**
 * The client half of F21, tested where it can actually go wrong: in what the browser **sends**, and in
 * what it is willing to **show** before an answer exists.
 *
 * The panel is rendered directly rather than the page component, because the page's half is tenancy
 * (a `headers()` read with no browser in sight) and its rules are pinned in `src/platform/chat/`.
 * What is under test here is the panel's contract with the stream: it posts no identity, it renders
 * only the five progress labels until an answer frame arrives, and it never composes a finding of its
 * own (§9.3, F17).
 */

const EXPERTS = [{ key: "gpr-field-officer", label: "gpr-field-officer" }];
const QUESTION = "Was grid four surveyed twice?";
const SUMMARY = "Synthetic answer: the second pass is required when the margin is below the reserve.";

interface Feed {
  push(frame: ChatFrame): void;
  close(): void;
}

let fetchCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
let feed: Feed | null = null;

function stubFetch(handler: () => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return handler();
    },
  );
}

/** An SSE response the test feeds by hand, so frame order is something the test controls. */
function streamingResponse(): { response: Response; feed: Feed } {
  const channel = createFrameChannel();
  const { response } = sseResponse(channel);
  return { response, feed: { push: (frame) => channel.push(frame), close: () => channel.close() } };
}

function jsonRejection(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function askFor(panel: HTMLElement, question: string) {
  const box = panel.querySelector("textarea");
  if (box === null) throw new Error("the panel rendered no question box");
  fireEvent.change(box, { target: { value: question } });
  const submit = panel.querySelector('button[type="submit"]');
  if (submit === null) throw new Error("the panel rendered no submit control");
  fireEvent.click(submit);
}

beforeEach(() => {
  feed = null;
  fetchCalls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the panel sends", () => {
  it("posts a question and nothing that identifies a tenant, a user or a model", async () => {
    const stream = streamingResponse();
    feed = stream.feed;
    stubFetch(() => stream.response);

    const view = render(<ChatPanel experts={EXPERTS} />);
    askFor(view.container, QUESTION);
    await waitFor(() => expect(fetchCalls).toHaveLength(1));

    const sent = fetchCalls[0] as { url: string; body: Record<string, unknown>; headers: Record<string, string> };
    expect(sent.url).toBe("/api/chat");
    expect(Object.keys(sent.body).sort()).toEqual(["clientMessageId", "conversationId", "expertKey", "idempotencyKey", "messages"]);
    for (const forbidden of ["organisationId", "userId", "organisation_id", "host", "cookie", "model", "provider", "dataClass", "policyRevision"]) {
      expect(JSON.stringify(sent.body)).not.toContain(forbidden);
    }
    // The question itself is a user turn with one text part — the shape the envelope normalizes.
    const messages = sent.body.messages as Array<{ role: string; parts: Array<{ type: string; text: string }> }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.parts[0]?.text).toBe(QUESTION);
    feed?.close();
  });

  it("keeps one conversation id across turns and gives each turn its own ids", async () => {
    const first = streamingResponse();
    feed = first.feed;
    stubFetch(() => first.response);
    const view = render(<ChatPanel experts={EXPERTS} />);

    askFor(view.container, QUESTION);
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    const conversationA = (fetchCalls[0]?.body as Record<string, unknown>).conversationId;

    feed?.push({ kind: "answer", answer: refusedAnswer(RUN_ID, "Nothing in the documents you are allowed to read answers this question."), persisted: true });
    feed?.close();
    await waitFor(() => expect(screen.getByText(/No answer: the documents you may read do not cover this/)).toBeTruthy());

    // The follow-up needs a live stream of its own; the conversation id must not change.
    const second = streamingResponse();
    feed = second.feed;
    stubFetch(() => second.response);
    askFor(view.container, "And the first one?");
    await waitFor(() => expect(fetchCalls).toHaveLength(2));
    const secondBody = fetchCalls[1]?.body as Record<string, unknown>;
    expect(secondBody.conversationId).toBe(conversationA);
    expect(secondBody.clientMessageId).not.toBe((fetchCalls[0]?.body as Record<string, unknown>).clientMessageId);
    feed?.close();
  });

  it("offers no expert the server did not grant", () => {
    render(<ChatPanel experts={[]} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.options).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("what the panel shows before an answer exists", () => {
  it("renders progress labels only, and no answer text, until the answer frame arrives", async () => {
    const stream = streamingResponse();
    feed = stream.feed;
    stubFetch(() => stream.response);
    const view = render(<ChatPanel experts={EXPERTS} />);
    askFor(view.container, QUESTION);

    const base = { runId: RUN_ID, conversationId: "4a000000-0000-4000-8000-000000000001", emittedAt: "2026-11-13T09:00:00.000Z" };
    feed?.push({ kind: "progress", event: { ...base, type: "routing", expertKey: "gpr-field-officer", confidence: 1 } });
    feed?.push({ kind: "progress", event: { ...base, type: "searching", retrievalMode: "lexical_only" } });
    feed?.push({ kind: "progress", event: { ...base, type: "verifying" } });

    await waitFor(() => expect(screen.getByText("Checking the answer against its sources…")).toBeTruthy());
    expect(screen.getByText("Searching the documents you are allowed to read…")).toBeTruthy();
    // The composed answer is not on the screen yet, and nothing about it is guessed: no summary, no
    // claim, no citation, and no status line (§9.3).
    expect(screen.queryByText(SUMMARY)).toBeNull();
    expect(screen.queryByText(/Answered from your documents/)).toBeNull();
    expect(document.body.textContent).not.toContain("second pass is required");

    feed?.push({ kind: "answer", answer: { ...answeredFixture(RUN_ID), summary: SUMMARY }, persisted: true });
    feed?.close();

    await waitFor(() => expect(screen.getByText(SUMMARY)).toBeTruthy());
    expect(screen.getByText("Answered from your documents")).toBeTruthy();
    // The citation is text, not a link: opening a document has to be re-authorized (T-203).
    expect(screen.getByText(/grid four of the sample site was surveyed twice/)).toBeTruthy();
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  it("shows what an answer does not cover, in the platform's words rather than the model's", async () => {
    const stream = streamingResponse();
    feed = stream.feed;
    stubFetch(() => stream.response);
    const view = render(<ChatPanel experts={EXPERTS} />);
    askFor(view.container, QUESTION);

    feed?.push({ kind: "answer", answer: refusedAnswer(RUN_ID, "Nothing in the documents you are allowed to read answers this question."), persisted: true });
    feed?.close();

    await waitFor(() => expect(screen.getByText("No answer: the documents you may read do not cover this")).toBeTruthy());
    expect(screen.getByText("Nothing in the documents you are allowed to read answers this question.")).toBeTruthy();
    expect(screen.getByText("What this answer does not cover")).toBeTruthy();
  });

  it("a server refusal shows the server's sentence, and leaves no half-turn behind", async () => {
    stubFetch(() => Promise.resolve(jsonRejection(403, { error: "out_of_scope", message: "That question is outside what this expert covers." })));
    const view = render(<ChatPanel experts={EXPERTS} />);
    askFor(view.container, QUESTION);

    await waitFor(() => expect(screen.getByText("That question is outside what this expert covers.")).toBeTruthy());
    // The placeholder turns were rolled back: an empty question box and no invented assistant row.
    expect(view.container.querySelectorAll("ol.turns li, li")).toHaveLength(0);
    expect((view.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("a dropped connection points at the stored run instead of showing a partial answer", async () => {
    const stream = streamingResponse();
    feed = stream.feed;
    stubFetch(() => stream.response);
    const view = render(<ChatPanel experts={EXPERTS} />);
    askFor(view.container, QUESTION);
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    // The stream ends with no answer frame at all: the server kept the run, so the panel says reload.
    feed?.close();

    await waitFor(() => expect(screen.getByText(/reload this page to see it/)).toBeTruthy());
    expect(document.body.textContent).not.toContain(SUMMARY);
  });
});
