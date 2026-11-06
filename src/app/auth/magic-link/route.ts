import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { handleMagicLinkRequest } from "@/platform/identity/request-magic-link";

// POST /auth/magic-link — thin by design (docs/REPO-STRUCTURE.md: routes are thin, the logic lives
// in src/platform/). A route handler is the only place in this app with the edge-delivered
// `request.url`, which is what the tenancy contract requires as the sole source of the host: a
// server action would have to read a Host header, and PR #18 settled that headers are not trusted.
export const dynamic = "force-dynamic";

/** Bindings are absent under plain `next dev` and on staging before the T-004 human steps. */
function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  return handleMagicLinkRequest({ request, ports: buildIdentityPorts(identityEnv()) });
}
