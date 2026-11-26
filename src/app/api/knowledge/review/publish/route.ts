import { reviewDeps, reviewUnavailableResponse } from "@/platform/knowledge/review-adapters";
import { handlePublishKnowledgeVersion } from "@/platform/knowledge/review-handlers";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/review/publish` activates a complete
// version via `publish_knowledge_version_v1` (F13). Handler and tests live in
// `src/platform/knowledge/`; this file only wires it.

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const deps = reviewDeps();
  if (deps === null) return Promise.resolve(reviewUnavailableResponse());
  return handlePublishKnowledgeVersion(request, deps);
}
