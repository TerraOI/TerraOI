// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { answeredFixture, RUN_ID } from "@/platform/chat/chat-fixtures";
import type { ChatFrame } from "@/platform/chat/envelope";
import type { ConversationHistory as History, StoredConversation } from "@/platform/chat/store";
import { createFrameChannel, sseResponse } from "@/platform/chat/stream";
import { transcriptTurns } from "@/platform/chat/transcript";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ChatPanel } from "./chat-panel";
import { ConversationHistory } from "./history";

/**
 * T-203 chat UX: resume from server history, the evidence panel, and what must never reach the DOM.
 * Isolation of the rows themselves is SQL's (pgTAP 035); these tests pin what the browser shows.
 */

const EXPERTS = [{ key: "gpr-field-officer", label: "gpr-field-officer" }];
const CONVERSATION = "4a000000-0000-4000-8000-000000000001";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function storedHistory(withheld: boolean): History {
  const answer = answeredFixture(RUN_ID);
  return {
    conversation: {
      id: CONVERSATION,
      expertKey: "gpr-field-officer",
      projectId: null,
      status: "open",
      createdAt: "2026-11-25 09:00:00+00",
      lastActivityAt: "2026-11-25 09:05:00+00",
    },
    messages: [
      {
        id: "4c000000-0000-4000-8000-000000000002",
        seq: 2,
        role: "assistant",
        bodyText: answer.summary,
        dataClass: answer.dataClass,
        createdAt: "2026-11-25 09:05:00+00",
        runId: RUN_ID,
        run: {
          id: RUN_ID,
          status: "answered",
          answerStatus: "answered",
          dataClass: answer.dataClass,
          policyRevision: 1,
          expertVersions: answer.expertVersions,
          corpusGenerations: answer.corpusGenerations,
          asOf: "2026-11-25 09:05:00+00",
          withheld,
          answer: withheld ? null : answer,
        },
      },
      {
        id: "4c000000-0000-4000-8000-000000000001",
        seq: 1,
        role: "user",
        bodyText: "Was grid four surveyed twice?",
        dataClass: "internal",
        createdAt: "2026-11-25 09:00:00+00",
        runId: null,
        run: null,
      },
    ],
  };
}

describe("resume from server history (F17)", () => {
  it("renders the stored transcript in order and continues the same conversation id", async () => {
    const history = storedHistory(false);
    const calls: Array<Record<string, unknown>> = [];
    const channel = createFrameChannel();
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse(channel).response;
    });
    const view = render(
      <ChatPanel
        experts={EXPERTS}
        initial={{ conversationId: CONVERSATION, expertKey: "gpr-field-officer", turns: transcriptTurns(history) }}
      />,
    );
    const items = view.container.querySelectorAll("ol > li");
    expect(items[0]?.textContent).toContain("Was grid four surveyed twice?");
    expect(screen.getByText("Answered from your documents")).toBeTruthy();

    const box = view.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "And the second pass?" } });
    fireEvent.click(view.container.querySelector('button[type="submit"]') as HTMLButtonElement);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.conversationId).toBe(CONVERSATION);
    channel.close();
  });

  it("a withheld run keeps its text and shows no evidence", () => {
    const history = storedHistory(true);
    render(<ChatPanel experts={EXPERTS} initial={{ conversationId: CONVERSATION, expertKey: "gpr-field-officer", turns: transcriptTurns(history) }} />);
    expect(screen.getByRole("note").textContent).toContain("evidence has been withdrawn");
    expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
    expect(document.body.textContent).not.toContain("grid four of the sample site was surveyed twice");
  });
});

describe("evidence panel (T-203)", () => {
  it("shows freshness, numbered citations with locators, and nothing that names a provider or a record id", async () => {
    const channel = createFrameChannel();
    vi.stubGlobal("fetch", async () => sseResponse(channel).response);
    const view = render(<ChatPanel experts={EXPERTS} />);
    fireEvent.change(view.container.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "q?" } });
    fireEvent.click(view.container.querySelector('button[type="submit"]') as HTMLButtonElement);

    const base = { runId: RUN_ID, conversationId: CONVERSATION, emittedAt: "2026-11-25T09:00:00.000Z" };
    const frames: ChatFrame[] = [
      { kind: "progress", event: { ...base, type: "tier_changed", fromTier: 1, toTier: 2, reason: "provider_unavailable" } },
      { kind: "answer", answer: answeredFixture(RUN_ID), persisted: true },
    ];
    for (const frame of frames) channel.push(frame);
    channel.close();

    await waitFor(() => expect(screen.getByRole("region", { name: "Evidence" })).toBeTruthy());
    expect(screen.getByText(/as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)).toBeTruthy();
    expect(screen.getByText("[1.1]")).toBeTruthy();
    expect(screen.getAllByText(/characters \d+–\d+/).length).toBeGreaterThan(0);
    const text = document.body.textContent ?? "";
    for (const forbidden of ["claude", "deepseek", "openrouter", "workers_ai", "local_box", "anthropic", RUN_ID]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
    // No document link until citation opening is re-authorized server-side (F24).
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("history list", () => {
  const conversation: StoredConversation = {
    id: CONVERSATION,
    expertKey: "gpr-field-officer",
    projectId: null,
    status: "open",
    createdAt: "2026-11-25 09:00:00+00",
    lastActivityAt: "2026-11-25 09:05:00+00",
  };

  it("links each own conversation and marks the open one", () => {
    render(<ConversationHistory conversations={[conversation]} activeId={CONVERSATION} />);
    const link = screen.getByRole("link", { name: /gpr-field-officer/ });
    expect(link.getAttribute("href")).toBe(`/chat?c=${CONVERSATION}`);
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("shows an empty state for someone with no history", () => {
    render(<ConversationHistory conversations={[]} activeId={null} />);
    expect(screen.getByText("No conversations yet.")).toBeTruthy();
  });
});
