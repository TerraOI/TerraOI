import { headers } from "next/headers";

import { chatEnv, DEV_HOST_OPTIONS, readChatPageState } from "@/platform/chat/adapters";
import { PROVISIONAL_EXPERTS } from "@/platform/chat/experts";

import { ChatPanel } from "./chat-panel";
import styles from "./chat.module.css";

// The tenant chat surface (plan §9.1, F17, F22). `/chat` is inside the `(tenant)` route group, so the
// host decides whose workspace this is and a signed-out or non-member visitor never sees another
// tenant's surface — the same rule every other tenant page follows (ADR-0006 rule 2: a page reads the
// routed host only through `pageRoutedHost`, with no `Host` fallback and no default tenant).
//
// This page renders no answer and no history of its own: the transcript comes from the server's stored
// rows on the next read, and the panel below only ever displays what the `/api/chat` stream delivers.

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const pageHeaders = await headers();
  const state = await readChatPageState(pageHeaders, chatEnv(), DEV_HOST_OPTIONS);

  if (state.kind === "blocked") {
    // One safe sentence, chosen by the merged tenancy resolver: it names no tenant, no host and no
    // role, so this page cannot be used to probe which workspaces exist (SAFE_FAILURE_MESSAGE, §8.2).
    return (
      <main className={styles.page}>
        <h1 className={styles.heading}>Assistant</h1>
        <p className={styles.notice} role="status">
          {state.message}
        </p>
      </main>
    );
  }

  // A display name is `expert_versions` data and T-113 has not landed, so the key is shown as-is
  // rather than invented here.
  const experts = PROVISIONAL_EXPERTS.map((expert) => ({ key: expert.key, label: expert.key }));

  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>Assistant</h1>
      <p className={styles.subheading}>
        Ask about the documents your workspace has made available to you. Answers arrive only after
        they have been checked against those documents.
      </p>
      <ChatPanel experts={experts} />
    </main>
  );
}
