import { buildAdminPorts } from "@/platform/tenancy/admin-adapters";
import { handleMembershipRoleAction } from "@/platform/tenancy/admin-service";

import { adminEnv, developmentHostOption } from "../../runtime";

// POST /admin/members/role — grant_membership_role_v1 / revoke_membership_role_v1 (T-202 PR-2e).
// Host comes from request.url (ADR-0006 rule 3), never from x-toi-routed-host.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const devHost = developmentHostOption();
  return handleMembershipRoleAction({
    request,
    ports: buildAdminPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });
}
