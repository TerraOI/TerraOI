import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";

import { STORE_MESSAGE, type ChatStore, type ConversationHistory, type StoredConversation } from "./store";

/**
 * F17 history for the chat page (T-203): the caller's own conversation list and, when one is asked
 * for, its transcript — both read from authorized server state (`chat_list_conversations_v1`,
 * `chat_load_conversation_v1`). The isolation itself is SQL's (pgTAP 035: own rows only, tenant scope,
 * project audience, withheld answers); this module only decides what an employee is told.
 *
 * One rule it adds: a conversation id that is malformed, foreign (another tenant or another user) or
 * absent gets the **same** sentence, so the page cannot be used to probe which ids exist (§8.2).
 */

export const HISTORY_LIMIT = 30;
export const CONVERSATION_NOT_AVAILABLE = "This conversation is not available.";

export interface ChatHistoryView {
  conversations: StoredConversation[];
  /** The transcript the page opened, or null. */
  active: ConversationHistory | null;
  /** One safe sentence when the list or the transcript could not be shown. */
  notice: string | null;
}

export async function readChatHistory(
  store: Pick<ChatStore, "listConversations" | "loadConversation">,
  context: TenantContext,
  input: { conversationId: string | null },
): Promise<ChatHistoryView> {
  const listed = await store.listConversations(context, { limit: HISTORY_LIMIT });
  const conversations = listed.ok ? listed.value.conversations : [];
  let notice: string | null = listed.ok ? null : STORE_MESSAGE[listed.kind];

  if (input.conversationId === null) return { conversations, active: null, notice };
  if (!z.uuid().safeParse(input.conversationId).success) {
    return { conversations, active: null, notice: CONVERSATION_NOT_AVAILABLE };
  }

  const loaded = await store.loadConversation(context, { conversationId: input.conversationId });
  if (loaded.ok) return { conversations, active: loaded.value, notice };
  // `refused` (not yours / not readable) and `membership` read as "not available", like an absent id;
  // an outage keeps its own sentence because it is not a statement about the conversation.
  notice =
    loaded.kind === "backend" || loaded.kind === "not_configured" ? STORE_MESSAGE[loaded.kind] : CONVERSATION_NOT_AVAILABLE;
  return { conversations, active: null, notice };
}
