import { buildSessionReader, chatEnv } from "@/platform/chat/adapters";
import { handleListSubmissionCollections } from "@/platform/chat/submission-collections";

// GET /chat/collections — T-302 audience picker (list_submission_collections_v1).
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  const env = chatEnv();
  return handleListSubmissionCollections(request, { session: buildSessionReader(env), postgrestBaseUrl: env.SUPABASE_URL });
}
