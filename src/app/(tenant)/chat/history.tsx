import Link from "next/link";

import type { StoredConversation } from "@/platform/chat/store";

import styles from "./chat.module.css";

/**
 * F17 history list (T-203). Rendered from `chat_list_conversations_v1` — the caller's own rows only —
 * as a collapsible drawer, so on a phone it folds above the panel instead of beside it.
 */
export function ConversationHistory({
  conversations,
  activeId,
}: {
  conversations: readonly StoredConversation[];
  activeId: string | null;
}) {
  return (
    <nav className={styles.history} aria-label="Your conversations">
      <details open>
        <summary>Your conversations</summary>
        {conversations.length === 0 ? (
          <p className={styles.notice}>No conversations yet.</p>
        ) : (
          <ul className={styles.historyList}>
            <li>
              <Link className={styles.historyLink} href="/chat" aria-current={activeId === null ? "page" : undefined}>
                New conversation
              </Link>
            </li>
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  className={styles.historyLink}
                  href={`/chat?c=${conversation.id}`}
                  aria-current={conversation.id === activeId ? "page" : undefined}
                >
                  {conversation.expertKey} · {conversation.lastActivityAt.slice(0, 16)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </details>
    </nav>
  );
}
