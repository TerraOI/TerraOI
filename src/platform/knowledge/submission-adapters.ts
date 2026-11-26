import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { readSession, readSessionTokens } from "@/platform/identity/session";
import type { HostAdapterOptions } from "@/platform/tenancy/host";
import { requestHost } from "@/platform/tenancy/host";
import {
  resolveTenantContext,
  type TenancyStore,
  type TenantResolution,
} from "@/platform/tenancy/resolve-tenant-context";
import type { TenantRpcConfig } from "@/platform/tenancy/tenant-rpc";

import type { SubmissionDeps } from "./submission-handlers";
import { SAFE_SUBMISSION_MESSAGES } from "./submission-handlers";
import { createSubmissionRpcClient } from "./submission-rpc";

/**
 * Wiring seam for the submissions routes (FAQ-0005).
 *
 * #37(b) is closed: the session row holds the user's Supabase tokens; F15 RPCs run through
 * `withTenantRpc` with that token. No service-role key on this path. Mirror of
 * `uploadDepsForRequest` (#223 / U-1).
 */

export type SubmissionEnv = Pick<
  IdentityEnv,
  "SUPABASE_URL" | "IDENTITY_SESSION_KEY" | "SESSION_TOKEN_KEY" | "SESSION_TOKEN_KEY_PREVIOUS" | "SESSION_DB"
>;

/** Narrow identity surface used by the request wire (and injectable in unit tests). */
export type SubmissionIdentityPorts = Pick<
  ReturnType<typeof buildIdentityPorts>,
  "sessionStore" | "tokenCipher" | "now" | "findHost" | "findMembership" | "policyRevision"
>;

export function submissionEnv(): Partial<SubmissionEnv> {
  try {
    return getCloudflareContext().env as Partial<SubmissionEnv>;
  } catch {
    return {};
  }
}

const DEV_HOST_OPTIONS: HostAdapterOptions = {
  ...(process.env.NODE_ENV === "development" && process.env.TERRAOI_DEV_HOST
    ? { developmentHost: process.env.TERRAOI_DEV_HOST }
    : {}),
};

function postgrestConfig(supabaseUrl: string): TenantRpcConfig {
  return { postgrestBaseUrl: `${supabaseUrl.replace(/\/+$/, "")}/rest/v1` };
}

function tenancyStoreForToken(ports: SubmissionIdentityPorts, accessToken: string | null): TenancyStore {
  return {
    findHost: (host) => ports.findHost(host),
    findMembership: (organisationId) => {
      if (accessToken === null) throw new Error("submission tenancy read requires the session access token");
      return ports.findMembership(organisationId, accessToken);
    },
    policyRevision: (organisationId) => {
      if (accessToken === null) throw new Error("submission tenancy read requires the session access token");
      return ports.policyRevision(organisationId, accessToken);
    },
  };
}

/**
 * Synchronous probe used by older call sites: returns null unless bindings exist. Prefer
 * `submissionDepsForRequest` so the token and context are opened once for the Request.
 */
export function submissionDeps(env: Partial<SubmissionEnv> = submissionEnv()): SubmissionDeps | null {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  if (supabaseUrl.length === 0) return null;
  const ports = buildIdentityPorts(env);
  if (ports.sessionStore() === null || ports.tokenCipher() === null) return null;
  // Bindings exist, but a Request is required to open the session — routes must use
  // `submissionDepsForRequest`. Returning null keeps the 503 until that path is used.
  return null;
}

/**
 * One Request → `SubmissionDeps` with the caller's token sealed into resolveContext / accessToken /
 * the RPC client. Returns null when deployment bindings are missing (routes answer 503).
 */
export async function submissionDepsForRequest(
  request: Request,
  env: Partial<SubmissionEnv> = submissionEnv(),
  hostOptions: HostAdapterOptions = DEV_HOST_OPTIONS,
  portsOverride?: SubmissionIdentityPorts | null,
): Promise<SubmissionDeps | null> {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  if (supabaseUrl.length === 0) return null;

  const ports: SubmissionIdentityPorts = portsOverride ?? buildIdentityPorts(env);
  const sessionStore = ports.sessionStore();
  const cipher = ports.tokenCipher();
  if (sessionStore === null || cipher === null) return null;

  const client = createSubmissionRpcClient(postgrestConfig(supabaseUrl));

  const host = requestHost({ url: request.url }, hostOptions);
  if (host === null) {
    return depsForResolution({ ok: false, reason: "unknown_host" }, client, null);
  }

  const now = ports.now();
  const cookieHeader = request.headers.get("cookie");
  const session = await readSession({ cookieHeader, host, now, store: sessionStore });
  if (!session.ok) {
    return depsForResolution({ ok: false, reason: "no_session" }, client, null);
  }

  const tokens = await readSessionTokens({ cookieHeader, host, now, store: sessionStore, cipher });
  if (!tokens.ok) {
    return depsForResolution({ ok: false, reason: "no_session" }, client, null);
  }

  const resolution = await resolveTenantContext({
    request: { url: request.url },
    hostOptions,
    userId: session.userId,
    store: tenancyStoreForToken(ports, tokens.tokens.accessToken),
  });
  if (!resolution.ok) {
    return depsForResolution(resolution, client, null);
  }

  return depsForResolution(resolution, client, tokens.tokens.accessToken);
}

function depsForResolution(
  resolution: TenantResolution,
  client: SubmissionDeps["client"],
  accessToken: string | null,
): SubmissionDeps {
  return {
    resolveContext: async () => resolution,
    accessToken: async () => accessToken,
    client,
  };
}

export function submissionUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "submissions_unavailable",
        message: SAFE_SUBMISSION_MESSAGES.submissions_unavailable,
      },
    }),
    {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    },
  );
}
