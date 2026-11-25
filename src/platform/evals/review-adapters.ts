import { buildIdentityPorts } from "@/platform/identity/adapters";
import { resolvePostgrestBase, type AdminEnv } from "@/platform/tenancy/admin-adapters";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import type { EvalReviewPorts } from "./review-service";

/** Deployment wiring for the T-303 eval review screens (same bindings as `/admin`). */
export function buildEvalReviewPorts(env: AdminEnv, options: { fetchImpl?: FetchImpl } = {}): EvalReviewPorts {
  const identity = buildIdentityPorts(env);
  return {
    now: () => identity.now(),
    signingSecret: () => identity.signingSecret(),
    sessionStore: () => identity.sessionStore(),
    tokenCipher: () => identity.tokenCipher(),
    findHost: (host) => identity.findHost(host),
    findMembership: (organisationId, accessToken) => identity.findMembership(organisationId, accessToken),
    policyRevision: (organisationId, accessToken) => identity.policyRevision(organisationId, accessToken),
    review: {
      postgrestBaseUrl: resolvePostgrestBase(env),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
  };
}
