import { reviewDeps, reviewUnavailableResponse } from "@/platform/knowledge/review-adapters";
import { handleReviewDecision } from "@/platform/knowledge/review-handlers";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/review/decision` records an approve or
// reject via `review_decision_v1` (F13). The handler and every test live in
// `src/platform/knowledge/`; this file only wires it.

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const deps = reviewDeps();
  if (deps === null) return Promise.resolve(reviewUnavailableResponse());
  return handleReviewDecision(request, deps);
}
