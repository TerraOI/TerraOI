import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { FormTemplateList } from "@/components/forms/form-template-list";
import { buildFormsPorts } from "@/platform/forms/adapters";
import { buildFormsListView } from "@/platform/forms/forms-service";

import { developmentHostOption, formsEnv, formsPageRequest } from "./runtime";

export const dynamic = "force-dynamic";

export default async function FormsListPage() {
  const headerList = await headers();
  const devHost = developmentHostOption();
  const view = await buildFormsListView({
    request: formsPageRequest(headerList, "/forms"),
    ports: buildFormsPorts(formsEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });

  switch (view.kind) {
    case "redirect":
      redirect(view.location);
    case "ready":
      return <FormTemplateList templates={view.templates} />;
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
