import { buildAdminPorts } from "@/platform/tenancy/admin-adapters";
import { handleCreateCollection } from "@/platform/tenancy/admin-service";

import { adminEnv, developmentHostOption } from "../../runtime";

// POST /admin/collections/create — create_collection_v1 via withTenantRpc (T-202 PR-2c / #41).
// Host comes from request.url (ADR-0006 rule 3), never from x-toi-routed-host.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const devHost = developmentHostOption();
  return handleCreateCollection({
    request,
    ports: buildAdminPorts(adminEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });
}
