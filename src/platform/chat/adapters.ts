import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { readSession, readSessionTokens } from "@/platform/identity/session";
import type { HostAdapterOptions } from "@/platform/tenancy/host";
import { requestHost } from "@/platform/tenancy/host";
import { pageRoutedHost, resolvePageTenantContext } from "@/platform/tenancy/page-host";
import {
  resolveTenantContext,
  SAFE_FAILURE_MESSAGE,
  type TenantFailureReason,
  type TenancyStore,
} from "@/platform/tenancy/resolve-tenant-context";
import type { TenantContext } from "@/contracts/tenant-context";

import { NOT_WIRED_SEARCH, type CorpusSearch, type GatewayBundle } from "./deps";
import { provisionalCatalog } from "./experts";
import type { ChatHttpDeps, ChatSessionRead } from "./http";
import type { ChatRunDeps } from "./run-chat";
import { createChatStore } from "./store";

/**
 * Production wiring for `/api/chat`: bindings in, `ChatHttpDeps` out. No decisions here — every rule
 * lives in `http.ts`, `run-chat.ts`, `store.ts` and the migration — but three absences are recorded
 * here, because a reader of the wiring has to be able to see what this deployment cannot do yet:
 *
 * 1. **No corpus search** (`NOT_WIRED_SEARCH`): T-114's `search_corpus_v1` is not merged, so every
 *    turn resolves to no packs and the answer is a persisted `refused`. Fail closed, labelled.
 * 2. **No gateway bundle** (`chatGatewayBundle` returns `null`): the provider factories belong to the
 *    gateway packet and its own boundary test forbids importing them anywhere else
 *    (`provider-boundary.test.ts`), so chat cannot assemble one. When T-115 (or a later packet) ships
 *    a production bundle builder, this is the one line that changes.
 * 3. **No expert registry**: the catalog is the provisional in-code list in `experts.ts`, until
 *    T-102c's `expert_grants` and T-113's `expert_versions` exist.
 *
 * So today's honest behaviour is: an authorized employee's question is stored, retrieval returns
 * nothing, and a `refused` answer with the expert's own `no_evidence` template is written and
 * delivered. That is the walking skeleton the packet asks for — the loop is closed and every
 * authorization on the path is real — with the two model-dependent stages waiting on their owners.
 */

export type ChatEnv = Pick<
  IdentityEnv,
  "SUPABASE_URL" | "IDENTITY_SESSION_KEY" | "SESSION_TOKEN_KEY" | "SESSION_TOKEN_KEY_PREVIOUS" | "SESSION_DB"
>;

/** Bindings are absent under plain `next dev` and on staging before the human steps (ADR-0002). */
export function chatEnv(): Partial<ChatEnv> {
  try {
    return getCloudflareContext().env as Partial<ChatEnv>;
  } catch {
    return {};
  }
}

/** Cloudflare's `ctx.waitUntil`, when a context exists; a plain Node test runtime has none. */
export function chatWaitUntil(): ((task: Promise<unknown>) => void) | undefined {
  try {
    const ctx = getCloudflareContext().ctx;
    return typeof ctx?.waitUntil === "function" ? (task) => ctx.waitUntil(task) : undefined;
  } catch {
    return undefined;
  }
}

export const DEV_HOST_OPTIONS: HostAdapterOptions = {
  // The same environment-bound escape hatch `platform-host.ts:35` and `host.ts:100-103` allow, and
  // only inside a development runtime: a Worker handed this by accident still routes by URL.
  ...(process.env.NODE_ENV === "development" && process.env.TERRAOI_DEV_HOST
    ? { developmentHost: process.env.TERRAOI_DEV_HOST }
    : {}),
};

/**
 * The session read this surface needs: the cookie identifies a session row on **this** host, and the
 * access token that goes into every chat RPC is the one sealed inside that row. Token material never
 * leaves this closure — `runDeps` receives it once, per request, and binds it into the store.
 */
export function buildSessionReader(
  env: Partial<ChatEnv>,
  hostOptions: HostAdapterOptions = DEV_HOST_OPTIONS,
): (request: Request) => Promise<ChatSessionRead> {
  const ports = buildIdentityPorts(env);

  return async (request: Request): Promise<ChatSessionRead> => {
    const host = requestHost({ url: request.url }, hostOptions);
    if (host === null) return { ok: false, reason: "missing_host" };

    const sessionStore = ports.sessionStore();
    if (sessionStore === null) return { ok: false, reason: "no_session" };

    const cookieHeader = request.headers.get("cookie");
    const now = ports.now();
    const session = await readSession({ cookieHeader, host, now, store: sessionStore });
    if (!session.ok) return { ok: false, reason: "no_session" };

    const cipher = ports.tokenCipher();
    let accessToken: string | null = null;
    if (cipher !== null) {
      const tokens = await readSessionTokens({ cookieHeader, host, now, store: sessionStore, cipher });
      if (tokens.ok) accessToken = tokens.tokens.accessToken;
    }

    const store: TenancyStore = {
      findHost: (h) => ports.findHost(h),
      findMembership: (organisationId) => {
        // Since #175 the membership read is a scoped RPC that takes only the caller's token: the row it
        // returns is `auth.uid()`'s own, so the session's user id never travels to the data API as a
        // parameter that could be chosen. No token, no read — there is no privileged path here, and an
        // unauthenticated lookup is a wiring bug rather than a fallback.
        if (accessToken === null) throw new Error("chat tenancy read requires the session access token");
        return ports.findMembership(organisationId, accessToken);
      },
      policyRevision: (organisationId) => {
        if (accessToken === null) throw new Error("chat tenancy read requires the session access token");
        return ports.policyRevision(organisationId, accessToken);
      },
    };

    const resolution = await resolveTenantContext({ request: { url: request.url }, hostOptions, userId: session.userId, store });
    if (!resolution.ok) return { ok: false, reason: resolution.reason };
    return { ok: true, context: resolution.context, accessToken };
  };
}

export type ChatPageState =
  | { kind: "ready"; context: TenantContext; accessToken: string | null }
  | { kind: "blocked"; reason: TenantFailureReason; message: string };

/**
 * The `/chat` page's own tenancy read. ADR-0006 rule 2: a page takes its host **only** from the proxy
 * header through `pageRoutedHost`, never from `Host` or `X-Forwarded-Host`, and `resolvePageTenantContext`
 * is the same single validation path a route handler walks (§4.1 step 6). The placeholder URL is the
 * merged idiom from `page-host.ts:56-63`, so `requestHost` stays the one decision point.
 */
export async function readChatPageState(
  pageHeaders: Headers,
  env: Partial<ChatEnv> = chatEnv(),
  hostOptions: HostAdapterOptions = DEV_HOST_OPTIONS,
): Promise<ChatPageState> {
  const routedHost = pageRoutedHost(pageHeaders);
  const host = requestHost({ url: routedHost === null ? "invalid:" : `https://${routedHost}/` }, hostOptions);
  if (host === null) return { kind: "blocked", reason: "missing_host", message: SAFE_FAILURE_MESSAGE.missing_host };

  const ports = buildIdentityPorts(env);
  const sessionStore = ports.sessionStore();
  const cookieHeader = pageHeaders.get("cookie");

  let userId: string | null = null;
  let accessToken: string | null = null;
  if (sessionStore !== null) {
    const session = await readSession({ cookieHeader, host, now: ports.now(), store: sessionStore });
    if (session.ok) {
      userId = session.userId;
      const cipher = ports.tokenCipher();
      if (cipher !== null) {
        const tokens = await readSessionTokens({ cookieHeader, host, now: ports.now(), store: sessionStore, cipher });
        if (tokens.ok) accessToken = tokens.tokens.accessToken;
      }
    }
  }

  const store: TenancyStore = {
    findHost: (h) => ports.findHost(h),
    findMembership: (organisationId) => {
      // The scoped read #175 landed: the membership is whatever the caller's own token resolves to.
      if (accessToken === null) throw new Error("chat tenancy read requires the session access token");
      return ports.findMembership(organisationId, accessToken);
    },
    policyRevision: (organisationId) => {
      if (accessToken === null) throw new Error("chat tenancy read requires the session access token");
      return ports.policyRevision(organisationId, accessToken);
    },
  };

  const resolution = await resolvePageTenantContext({ headers: pageHeaders, userId, store, hostOptions });
  if (!resolution.ok) return { kind: "blocked", reason: resolution.reason, message: SAFE_FAILURE_MESSAGE[resolution.reason] };
  return { kind: "ready", context: resolution.context, accessToken };
}

/**
 * The gateway bundle, or `null`. Deliberately not assembled here: naming a provider factory outside
 * the gateway is what `provider-boundary.test.ts` exists to catch, and an adapter built from a request
 * would be a route around the reviewed deployment config (AGENTS.md §4.3, §6).
 */
export function chatGatewayBundle(): GatewayBundle | null {
  return null;
}

export function chatSearch(): CorpusSearch {
  return NOT_WIRED_SEARCH;
}

export function buildChatHttpDeps(
  env: Partial<ChatEnv>,
  options: { hostOptions?: HostAdapterOptions; waitUntil?: (task: Promise<unknown>) => void } = {},
): ChatHttpDeps {
  const session = buildSessionReader(env, options.hostOptions ?? DEV_HOST_OPTIONS);
  const gateway = chatGatewayBundle();
  const postgrestBaseUrl = env.SUPABASE_URL;

  return {
    session,
    catalog: provisionalCatalog(),
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    runDeps: (context: TenantContext, accessToken: string | null): Omit<ChatRunDeps, "emit" | "grants"> => ({
      // Per request, per context: the only credential that can reach Postgres is this caller's own.
      store: createChatStore({ accessToken }, { postgrestBaseUrl }),
      search: chatSearch(),
      gateway,
    }),
  };
}

/** What `src/app/api/chat/route.ts` calls; split out so the route file stays one line of wiring. */
export function chatHttpDepsForRequest(): ChatHttpDeps {
  return buildChatHttpDeps(chatEnv(), { waitUntil: chatWaitUntil() });
}
