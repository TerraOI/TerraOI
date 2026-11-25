import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EvalCaseReview } from "@/components/evals/case-review";
import { buildEvalReviewPorts } from "@/platform/evals/review-adapters";
import { buildEvalCaseView } from "@/platform/evals/review-service";

import { adminEnv, adminPageRequest, developmentHostOption } from "../../admin/runtime";

export const dynamic = "force-dynamic";

/** T-303 case detail. A hidden, foreign or absent id all render the same "not available" text. */
export default async function EvalCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const headerList = await headers();
  const devHost = developmentHostOption();
  const view = await buildEvalCaseView({
    request: adminPageRequest(headerList, "/evals"),
    ports: buildEvalReviewPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
    caseId,
  });

  switch (view.kind) {
    case "redirect":
      redirect(view.location);
    case "ready":
      return <EvalCaseReview evalCase={view.case} csrfToken={view.csrfToken} />;
    case "missing":
    case "no_access":
    case "not_found":
    case "unavailable":
      return (
        <section>
          <h1>Evaluation case</h1>
          <p role="status">{view.message}</p>
        </section>
      );
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
