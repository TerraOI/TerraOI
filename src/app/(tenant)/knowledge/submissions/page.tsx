import { headers } from "next/headers";

import { SubmissionReviewList } from "@/components/knowledge/submission-review";
import { chatEnv, chatPostgrestBase, DEV_HOST_OPTIONS, readChatPageState } from "@/platform/chat/adapters";
import { listSubmissionQueue } from "@/platform/knowledge/submission-queue";

export const dynamic = "force-dynamic";

/**
 * T-302 knowledge submissions: reviewers see the queue for collections they can read; everyone else
 * sees their own proposals. Tenant from the routed host + membership (ADR-0006 rule 2), reads with the
 * user's own token.
 */
export default async function KnowledgeSubmissionsPage() {
  const env = chatEnv();
  const state = await readChatPageState(await headers(), env, DEV_HOST_OPTIONS);
  if (state.kind === "blocked") {
    return (
      <section aria-labelledby="submissions-heading">
        <h1 id="submissions-heading">Knowledge submissions</h1>
        <p role="status">{state.message}</p>
      </section>
    );
  }
  const queue = await listSubmissionQueue(state.context, state.accessToken, "submitted", { postgrestBaseUrl: chatPostgrestBase(env) });
  return (
    <section aria-labelledby="submissions-heading">
      <h1 id="submissions-heading">Knowledge submissions</h1>
      <p>Proposals from chat waiting for review. Nothing here is company knowledge until a reviewer approves it.</p>
      {queue.ok ? <SubmissionReviewList submissions={queue.submissions} /> : <p role="status">{queue.message}</p>}
    </section>
  );
}
