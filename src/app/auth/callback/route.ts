import { getCloudflareContext } from "@opennextjs/cloudflare";

import { completeMagicLink } from "@/platform/identity/complete-magic-link";
import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";

// GET /auth/callback — where the mail provider returns the browser. The handler verifies the
// host-bound single-use login state before it contacts the provider, so a link handed to somebody
// else is inert; everything about that decision lives in src/platform/identity.
export const dynamic = "force-dynamic";

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export function GET(request: Request): Promise<Response> {
  return completeMagicLink({ request, ports: buildIdentityPorts(identityEnv()) });
}
