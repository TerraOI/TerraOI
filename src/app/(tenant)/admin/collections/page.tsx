import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { CreateCollectionForm } from "@/components/admin/create-collection-form";
import { buildAdminPorts } from "@/platform/tenancy/admin-adapters";
import { buildAdminCollectionsView } from "@/platform/tenancy/admin-service";

import { adminEnv, adminPageRequest, developmentHostOption } from "../runtime";

export const dynamic = "force-dynamic";

export default async function AdminCollectionsPage() {
  const headerList = await headers();
  const devHost = developmentHostOption();
  const view = await buildAdminCollectionsView({
    request: adminPageRequest(headerList, "/admin/collections"),
    ports: buildAdminPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });

  switch (view.kind) {
    case "redirect":
      redirect(view.location);
    case "ready":
      return <CreateCollectionForm csrfToken={view.csrfToken} />;
    case "no_access":
    case "not_found":
    case "unavailable":
      return (
        <section>
          <h1>Collections</h1>
          <p role="status">{view.message}</p>
        </section>
      );
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
