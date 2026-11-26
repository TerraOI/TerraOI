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

import {
  createSignedUploadUrl,
  createSupabaseObjectStore,
} from "./object-store-supabase";
import { createPostgresUploadStore } from "./upload-store";
import type { UploadDeps } from "./upload-session";
import { SAFE_UPLOAD_MESSAGES } from "./upload-session";

/**
 * Wiring seam for the upload routes (FAQ-0005).
 *
 * #37(b) and #38 are closed: the session row holds the user's Supabase tokens; capture RPCs run
 * through `withTenantRpc` with that token; private Storage is authorized by RLS under the same
 * token. No service-role key on this path.
 */

export type UploadEnv = Pick<
  IdentityEnv,
  "SUPABASE_URL" | "IDENTITY_SESSION_KEY" | "SESSION_TOKEN_KEY" | "SESSION_TOKEN_KEY_PREVIOUS" | "SESSION_DB"
>;

export function uploadEnv(): Partial<UploadEnv> {
  try {
    return getCloudflareContext().env as Partial<UploadEnv>;
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

function tenancyStoreForToken(
  ports: ReturnType<typeof buildIdentityPorts>,
  accessToken: string | null,
): TenancyStore {
  return {
    findHost: (host) => ports.findHost(host),
    findMembership: (organisationId) => {
      if (accessToken === null) throw new Error("upload tenancy read requires the session access token");
      return ports.findMembership(organisationId, accessToken);
    },
    policyRevision: (organisationId) => {
      if (accessToken === null) throw new Error("upload tenancy read requires the session access token");
      return ports.policyRevision(organisationId, accessToken);
    },
  };
}

/**
 * Synchronous probe used by older call sites: returns null unless bindings exist. Prefer
 * `uploadDepsForRequest` so the token and context are opened once for the Request.
 */
export function uploadDeps(env: Partial<UploadEnv> = uploadEnv()): UploadDeps | null {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  if (supabaseUrl.length === 0) return null;
  const ports = buildIdentityPorts(env);
  if (ports.sessionStore() === null || ports.tokenCipher() === null) return null;
  // Bindings exist, but a Request is required to open the session — routes must use
  // `uploadDepsForRequest`. Returning null keeps the 503 until that path is used.
  return null;
}

/**
 * One Request → `UploadDeps` with the caller's token sealed into the store and object ports.
 */
export async function uploadDepsForRequest(
  request: Request,
  env: Partial<UploadEnv> = uploadEnv(),
  hostOptions: HostAdapterOptions = DEV_HOST_OPTIONS,
): Promise<UploadDeps | null> {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  if (supabaseUrl.length === 0) return null;

  const ports = buildIdentityPorts(env);
  const sessionStore = ports.sessionStore();
  const cipher = ports.tokenCipher();
  if (sessionStore === null || cipher === null) return null;

  const host = requestHost({ url: request.url }, hostOptions);
  if (host === null) {
    return depsForResolution({ ok: false, reason: "unknown_host" });
  }

  const now = ports.now();
  const cookieHeader = request.headers.get("cookie");
  const session = await readSession({ cookieHeader, host, now, store: sessionStore });
  if (!session.ok) {
    return depsForResolution({ ok: false, reason: "no_session" });
  }

  const tokens = await readSessionTokens({ cookieHeader, host, now, store: sessionStore, cipher });
  if (!tokens.ok) {
    return depsForResolution({ ok: false, reason: "no_session" });
  }

  const resolution = await resolveTenantContext({
    request: { url: request.url },
    hostOptions,
    userId: session.userId,
    store: tenancyStoreForToken(ports, tokens.tokens.accessToken),
  });
  if (!resolution.ok) {
    return depsForResolution(resolution);
  }

  const rpc = postgrestConfig(supabaseUrl);
  const store = createPostgresUploadStore({
    context: resolution.context,
    accessToken: tokens.tokens.accessToken,
    rpc,
  });
  const objects = createSupabaseObjectStore({
    supabaseUrl,
    accessToken: tokens.tokens.accessToken,
  });

  return {
    resolveContext: async () => resolution,
    store,
    objects,
    signUpload: async (objectRef) => {
      const signed = await createSignedUploadUrl({
        supabaseUrl,
        accessToken: tokens.tokens.accessToken,
        objectRef,
      });
      return signed?.uploadUrl ?? null;
    },
  };
}

function depsForResolution(resolution: TenantResolution): UploadDeps {
  return {
    resolveContext: async () => resolution,
    store: {
      beginSession: async () => {
        throw new Error("upload store unreachable");
      },
      findSession: async () => null,
      registerVersion: async () => ({ status: "refused", reason: "session_not_found" }),
      recordOutcome: async () => {
        throw new Error("upload store unreachable");
      },
    },
    objects: null,
  };
}

export function uploadUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: "storage_unavailable", message: SAFE_UPLOAD_MESSAGES.storage_unavailable } }),
    {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    },
  );
}
