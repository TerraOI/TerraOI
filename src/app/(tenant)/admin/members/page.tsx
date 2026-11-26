import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { InviteMemberForm } from "@/components/admin/invite-member-form";
import { MembershipRoleForm } from "@/components/admin/membership-role-form";
import { buildAdminPorts } from "@/platform/tenancy/admin-adapters";
import { buildAdminMembersView } from "@/platform/tenancy/admin-service";

import { adminEnv, adminPageRequest, developmentHostOption } from "../runtime";

export const dynamic = "force-dynamic";

export default async function AdminMembersPage() {
  const headerList = await headers();
  const devHost = developmentHostOption();
  const view = await buildAdminMembersView({
    request: adminPageRequest(headerList, "/admin/members"),
    ports: buildAdminPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });

  switch (view.kind) {
    case "redirect":
      redirect(view.location);
    case "ready":
      return (
        <>
          <InviteMemberForm csrfToken={view.csrfToken} />
          <MembershipRoleForm csrfToken={view.csrfToken} />
        </>
      );
    case "no_access":
    case "not_found":
    case "unavailable":
      return (
        <section>
          <h1>Members and roles</h1>
          <p role="status">{view.message}</p>
        </section>
      );
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
