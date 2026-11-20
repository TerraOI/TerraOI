import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { handlePasswordResetRequest } from "@/platform/identity/password-reset";

// POST /auth/password-reset — asking GoTrue for a recovery link (T-201). The answer is the same for
// every address, so this endpoint cannot be used to ask whether one exists; the marking that lets the
// callback treat the completed link as a reset lives in src/platform/identity.
export const dynamic = "force-dynamic";

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  return handlePasswordResetRequest({ request, ports: buildIdentityPorts(identityEnv()) });
}
