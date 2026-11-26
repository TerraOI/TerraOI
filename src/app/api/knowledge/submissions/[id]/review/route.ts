import { submissionDepsForRequest, submissionUnavailableResponse } from "@/platform/knowledge/submission-adapters";
import { handleReviewSubmission } from "@/platform/knowledge/submission-handlers";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/submissions/:id/review` approve/reject
// via `review_knowledge_submission_v1` (F15). Handler and tests live in `src/platform/knowledge/`.

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const deps = await submissionDepsForRequest(request);
  if (deps === null) return submissionUnavailableResponse();
  const { id } = await context.params;
  return handleReviewSubmission(request, deps, id);
}
