import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { handleSignOut } from "@/platform/identity/sign-out";

// POST /auth/sign-out — clears this browser's host-only cookies. The handler documents plainly that
// a self-contained cookie cannot be revoked server-side: the mitigation is the short TTL plus the
// per-request membership re-check, and real revocation arrives if #37 lands on a session store.
export const dynamic = "force-dynamic";

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  return handleSignOut({ request, ports: buildIdentityPorts(identityEnv()) });
}
