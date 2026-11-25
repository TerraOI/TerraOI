import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildSessionReader, chatEnv, chatPostgrestBase } from "@/platform/chat/adapters";
import { handleOpenCitation } from "@/platform/chat/citation";

// GET /api/evidence/<chunkId> — F24 open a citation: re-authorize, then stream with the reader's own
// token. No URL is minted and nothing is stored (src/platform/chat/citation.ts).
export const dynamic = "force-dynamic";

function anonKey(): string | undefined {
  try {
    const env = getCloudflareContext().env as { SUPABASE_ANON_KEY?: string };
    return env.SUPABASE_ANON_KEY;
  } catch {
    return undefined;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const env = chatEnv();
  return handleOpenCitation(request, id, {
    session: buildSessionReader(env),
    postgrestBaseUrl: chatPostgrestBase(env),
    supabaseUrl: env.SUPABASE_URL,
    anonKey: anonKey(),
  });
}
