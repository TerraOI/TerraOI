import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { handleEntraSignInRequest } from "@/platform/identity/entra-linking";

// POST /auth/entra — starting the Microsoft Entra flow (T-201). A POST with this host's CSRF token,
// not a bare link at the IdP: the state and PKCE verifier that make the callback meaningful have to be
// issued by this host under this host's cookie, which is the same reason the magic-link form posts
// (#44: sign-in starts must establish the tenant from `request.url`). The 302 target is built here from
// the configured project URL; nothing about the destination comes from the request.
export const dynamic = "force-dynamic";

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  return handleEntraSignInRequest({ request, ports: buildIdentityPorts(identityEnv()) });
}
