import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { handlePasswordSignIn } from "@/platform/identity/password-signin";

// POST /auth/password — the password method's route handler (T-201). Thin by design, like its
// magic-link sibling: the edge-delivered `request.url` is the only source of the tenant, which a route
// handler sees and a server action does not (#44), and every decision — guards, the credential call,
// the completion — lives in src/platform/identity.
export const dynamic = "force-dynamic";

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  return handlePasswordSignIn({ request, ports: buildIdentityPorts(identityEnv()) });
}
