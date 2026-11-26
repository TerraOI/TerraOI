import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { FormRenderer } from "@/components/forms/form-renderer";
import { buildFormsPorts } from "@/platform/forms/adapters";
import { buildFormDetailView } from "@/platform/forms/forms-service";

import { developmentHostOption, formsEnv, formsPageRequest } from "../runtime";

export const dynamic = "force-dynamic";

export default async function FormDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ templateId: string }>;
  searchParams: Promise<{ supersedes?: string | string[] }>;
}) {
  const headerList = await headers();
  const { templateId } = await params;
  const query = await searchParams;
  const rawSupersedes = query.supersedes;
  const supersedesSubmissionId = Array.isArray(rawSupersedes) ? rawSupersedes[0] : rawSupersedes;
  const devHost = developmentHostOption();

  const view = await buildFormDetailView({
    request: formsPageRequest(headerList, `/forms/${encodeURIComponent(templateId)}`),
    templateId,
    supersedesSubmissionId,
    ports: buildFormsPorts(formsEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });

  switch (view.kind) {
    case "redirect":
      redirect(view.location);
    case "ready":
      return (
        <FormRenderer
          template={view.template}
          fields={view.fields}
          csrfToken={view.csrfToken}
          supersedesSubmissionId={view.supersedesSubmissionId}
        />
      );
    case "no_access":
    case "not_found":
    case "unavailable":
      return (
        <section>
          <h1>Forms</h1>
          <p role="status">{view.message}</p>
        </section>
      );
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
