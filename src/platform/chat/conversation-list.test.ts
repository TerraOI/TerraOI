import { describe, expect, it, vi } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import { CONVERSATION_NOT_AVAILABLE, HISTORY_LIMIT, readChatHistory } from "./conversation-list";
import { STORE_MESSAGE, type ChatStore, type ConversationHistory, type StoredConversation } from "./store";

const CTX = createTenantContext({
  organisationId: "11111111-1111-4111-8111-111111111111",
  host: "company1.terraoi.app",
  userId: "00000000-0000-4000-8000-0000000000a1",
  membershipId: "55555555-5555-4555-8555-555555555555",
  membershipStatus: "active",
  roles: ["member"],
  permittedServiceKeys: [],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-25T00:00:00.000Z",
});
const OWN = "c0000000-0000-4000-8000-000000000001";
const FOREIGN = "c0000000-0000-4000-8000-000000000099";

const conversation: StoredConversation = {
  id: OWN,
  expertKey: "gpr-field-officer",
  projectId: null,
  status: "open",
  createdAt: "2026-11-25 09:00:00+00",
  lastActivityAt: "2026-11-25 09:05:00+00",
};
const history: ConversationHistory = { conversation, messages: [] };

/**
 * An in-memory stand-in shaped like the SQL answers (pgTAP 035 proves the SQL): the list returns only
 * the caller's rows; loading another user's or tenant's id is a 42501, which the store reports as
 * `refused`.
 */
function store(overrides: Partial<Pick<ChatStore, "listConversations" | "loadConversation">> = {}) {
  return {
    listConversations: vi.fn<ChatStore["listConversations"]>(async () => ({ ok: true, value: { conversations: [conversation] } })),
    loadConversation: vi.fn<ChatStore["loadConversation"]>(async (_ctx, input) =>
      input.conversationId === OWN
        ? { ok: true, value: history }
        : { ok: false, kind: "refused", detail: "chat_load_conversation_v1:42501" },
    ),
    ...overrides,
  };
}

describe("readChatHistory (T-203, F17)", () => {
  it("lists the caller's own conversations, capped", async () => {
    const s = store();
    const view = await readChatHistory(s, CTX, { conversationId: null });
    expect(view).toEqual({ conversations: [conversation], active: null, notice: null });
    expect(s.listConversations).toHaveBeenCalledWith(CTX, { limit: HISTORY_LIMIT });
    expect(s.loadConversation).not.toHaveBeenCalled();
  });

  it("opens the caller's own conversation", async () => {
    const view = await readChatHistory(store(), CTX, { conversationId: OWN });
    expect(view.active).toEqual(history);
    expect(view.notice).toBeNull();
  });

  it("a foreign id, a malformed id and an absent id all read the same", async () => {
    const s = store();
    const foreign = await readChatHistory(s, CTX, { conversationId: FOREIGN });
    const malformed = await readChatHistory(s, CTX, { conversationId: "../../etc" });
    expect(foreign.notice).toBe(CONVERSATION_NOT_AVAILABLE);
    expect(malformed.notice).toBe(CONVERSATION_NOT_AVAILABLE);
    expect(foreign.active).toBeNull();
    expect(malformed.active).toBeNull();
    // the malformed id is never dialled
    expect(s.loadConversation).toHaveBeenCalledTimes(1);
  });

  it("an empty history for a second user is an empty list, not an error", async () => {
    const view = await readChatHistory(
      store({ listConversations: async () => ({ ok: true, value: { conversations: [] } }) }),
      CTX,
      { conversationId: null },
    );
    expect(view).toEqual({ conversations: [], active: null, notice: null });
  });

  it("an outage says so instead of pretending the history is empty", async () => {
    const view = await readChatHistory(
      store({
        listConversations: async () => ({ ok: false, kind: "backend", detail: "x" }),
        loadConversation: async () => ({ ok: false, kind: "backend", detail: "x" }),
      }),
      CTX,
      { conversationId: OWN },
    );
    expect(view.conversations).toEqual([]);
    expect(view.notice).toBe(STORE_MESSAGE.backend);
  });
});
