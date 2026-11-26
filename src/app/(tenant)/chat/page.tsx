import { headers } from "next/headers";

import { chatEnv, DEV_HOST_OPTIONS, readChatPageState } from "@/platform/chat/adapters";

import { ChatPanel } from "./chat-panel";
import styles from "./chat.module.css";

// The tenant chat surface (plan §9.1, F17, F22). `/chat` is inside the `(tenant)` route group, so the
// host decides whose workspace this is and a signed-out or non-member visitor never sees another
// tenant's surface — the same rule every other tenant page follows (ADR-0006 rule 2: a page reads the
// routed host only through `pageRoutedHost`, with no `Host` fallback and no default tenant).
//
// This page renders no answer and no history of its own: the transcript comes from the server's stored
// rows on the next read, and the panel below only ever displays what the `/api/chat` stream delivers.
//
// #173's tenant shell already wraps `(tenant)` pages in `<main>`; this page uses `<section>` so the
// document keeps a single main landmark (Round-2 B6 / #173 Round-2 N13).

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const pageHeaders = await headers();
  const state = await readChatPageState(pageHeaders, chatEnv(), DEV_HOST_OPTIONS);

  if (state.kind === "blocked") {
    // One safe sentence, chosen by the merged tenancy resolver: it names no tenant, no host and no
    // role, so this page cannot be used to probe which workspaces exist (SAFE_FAILURE_MESSAGE, §8.2).
    return (
      <section className={styles.page} aria-labelledby="chat-heading">
        <h1 id="chat-heading" className={styles.heading}>
          Assistant
        </h1>
        <p className={styles.notice} role="status">
          {state.message}
        </p>
      </section>
    );
  }

  // Round-1 B5: no production expert catalog until T-113 / T-102c. The panel renders with an empty
  // list rather than a provisional key that contradicts ruling #83.
  const experts: Array<{ key: string; label: string }> = [];

  return (
    <section className={styles.page} aria-labelledby="chat-heading">
      <h1 id="chat-heading" className={styles.heading}>
        Assistant
      </h1>
      <p className={styles.subheading}>
        Ask about the documents your workspace has made available to you. Answers arrive only after
        they have been checked against those documents.
      </p>
      <ChatPanel experts={experts} />
    </section>
  );
}
