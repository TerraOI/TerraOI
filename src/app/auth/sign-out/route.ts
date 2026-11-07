import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { handleSignOut } from "@/platform/identity/sign-out";

// POST /auth/sign-out — a real revocation since #37 option (b): the session row's revoked_at is set
// and this browser's host-only cookies are cleared. The route stays thin; the guards, the revocation
// and the reporting of a failed server half live in src/platform/identity/sign-out.ts.
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
