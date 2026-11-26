import { submissionDeps, submissionUnavailableResponse } from "@/platform/knowledge/submission-adapters";
import { handleCreateSubmission } from "@/platform/knowledge/submission-handlers";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/submissions` creates an F15 proposal
// via `submit_employee_knowledge_v1`. Handler and tests live in `src/platform/knowledge/`.

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const deps = submissionDeps();
  if (deps === null) return Promise.resolve(submissionUnavailableResponse());
  return handleCreateSubmission(request, deps);
}
