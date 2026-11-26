import { buildFormsPorts } from "@/platform/forms/adapters";
import { handleFormAction } from "@/platform/forms/forms-service";

import { developmentHostOption, formsEnv } from "../runtime";

// POST /forms/submit — draft and submit actions via scoped RPCs (T-301 PR-2).
// Route handler reads the host from request.url (ADR-0006 rule 3), never from x-toi-routed-host.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const devHost = developmentHostOption();
  return handleFormAction({
    request,
    ports: buildFormsPorts(formsEnv()),
    hostOptions: devHost === undefined ? undefined : { developmentHost: devHost },
  });
}
