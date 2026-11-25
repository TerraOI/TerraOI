import { buildSessionReader, chatEnv, chatPostgrestBase } from "@/platform/chat/adapters";
import { handleChatFeedback } from "@/platform/chat/feedback";
import { createChatStore } from "@/platform/chat/store";

// POST /chat/feedback — T-302 rating (rate_answer_v1) as the signed-in user; Incorrect / Suggest
// correction also drafts a pilot eval case (#102). Same-origin JSON only.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const env = chatEnv();
  return handleChatFeedback(request, {
    session: buildSessionReader(env),
    store: (accessToken) => createChatStore({ accessToken }, { postgrestBaseUrl: chatPostgrestBase(env) }),
    postgrestBaseUrl: chatPostgrestBase(env),
  });
}
