import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { CreateProjectForm } from "@/components/admin/create-project-form";
import { buildAdminPorts } from "@/platform/tenancy/admin-adapters";
import { buildAdminProjectsView } from "@/platform/tenancy/admin-service";

import { adminEnv, adminPageRequest, developmentHostOption } from "../runtime";

export const dynamic = "force-dynamic";

export default async function AdminProjectsPage() {
  const headerList = await headers();
  const devHost = developmentHostOption();
  const view = await buildAdminProjectsView({
    request: adminPageRequest(headerList, "/admin/projects"),
    ports: buildAdminPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });

  switch (view.kind) {
    case "redirect":
      redirect(view.location);
    case "ready":
      return <CreateProjectForm csrfToken={view.csrfToken} />;
    case "no_access":
    case "not_found":
    case "unavailable":
      return (
        <section>
          <h1>Projects</h1>
          <p role="status">{view.message}</p>
        </section>
      );
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
