import { buildEvalReviewPorts } from "@/platform/evals/review-adapters";
import { handleEvalDecision } from "@/platform/evals/review-service";

import { adminEnv, developmentHostOption } from "../../admin/runtime";

// POST /evals/decide — decide_eval_case_v1 via withTenantRpc (T-303). Host from request.url
// (ADR-0006 rule 3); reviewer is auth.uid() server-side.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const devHost = developmentHostOption();
  return handleEvalDecision({
    request,
    ports: buildEvalReviewPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });
}
