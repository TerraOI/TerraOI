import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { handleSetPassword } from "@/platform/identity/set-password";

// POST /auth/set-password — GoTrue password update after a recovery completion (T-201 / #181 B1).
export const dynamic = "force-dynamic";

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  return handleSetPassword({ request, ports: buildIdentityPorts(identityEnv()) });
}
