import { reviewDeps, reviewUnavailableResponse } from "@/platform/knowledge/review-adapters";
import { handleRevokeSource } from "@/platform/knowledge/review-handlers";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/review/revoke` stops retrieval via
// `revoke_source_v1` (F14). Handler and tests live in `src/platform/knowledge/`; this file only
// wires it.

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const deps = reviewDeps();
  if (deps === null) return Promise.resolve(reviewUnavailableResponse());
  return handleRevokeSource(request, deps);
}
