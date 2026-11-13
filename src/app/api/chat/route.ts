import { chatHttpDepsForRequest } from "@/platform/chat/adapters";
import { handleChatPost } from "@/platform/chat/http";

// Lane 1 HTTP surface (T-104): the same-origin chat endpoint. The handler, the envelope rules and
// every test live in `src/platform/chat/http.ts`; this file only wires the bindings, exactly as
// `api/knowledge/uploads/route.ts` does for its handler (FAQ-0005 keeps wiring thin and testable).
//
// The host comes from `request.url` here — a route handler must not read the page-only
// `x-toi-routed-host` header (ADR-0006 rule 3), and no tenancy value is taken from a body, query,
// cookie value or header anywhere on this path (AGENTS.md §4.1).

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleChatPost(request, chatHttpDepsForRequest());
}
