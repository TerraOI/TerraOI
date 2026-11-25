import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EvalCaseList } from "@/components/evals/case-list";
import { buildEvalReviewPorts } from "@/platform/evals/review-adapters";
import { buildEvalReviewListView } from "@/platform/evals/review-service";

import { adminEnv, adminPageRequest, developmentHostOption } from "../admin/runtime";

export const dynamic = "force-dynamic";

/** T-303 eval review list. Tenant and reviewer come from host + session; see review-service. */
export default async function EvalCasesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const params = await searchParams;
  const status = params.status === "drafted" || params.status === "approved" ? params.status : null;
  const headerList = await headers();
  const devHost = developmentHostOption();
  const view = await buildEvalReviewListView({
    request: adminPageRequest(headerList, "/evals"),
    ports: buildEvalReviewPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
    status,
  });

  switch (view.kind) {
    case "redirect":
      redirect(view.location);
    case "ready":
      return <EvalCaseList cases={view.cases} status={status} />;
    case "no_access":
    case "not_found":
    case "unavailable":
      return (
        <section>
          <h1>Evaluation cases</h1>
          <p role="status">{view.message}</p>
        </section>
      );
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
