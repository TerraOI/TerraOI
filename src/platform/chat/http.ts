import type { TenantContext } from "@/contracts/tenant-context";
import { SAFE_FAILURE_MESSAGE, type TenantFailureReason } from "@/platform/tenancy/resolve-tenant-context";

import type { ChatRunDeps, ChatRunOutcome } from "./run-chat";
import { runChat } from "./run-chat";
import { readChatEnvelope, type EnvelopeRejection } from "./envelope";
import { createFrameChannel, sseResponse } from "./stream";
import { resolveExpertAccess } from "./experts";
import type { ExpertCatalog, RefusalNotice } from "./deps";

/**
 * `POST /api/chat` — the handler, kept free of framework imports so the whole HTTP surface is unit
 * testable (the route file only wires it, exactly as `api/knowledge/uploads/route.ts` does).
 *
 * The order below is the packet's acceptance list, and each step refuses in the narrowest way that
 * is still safe:
 *
 * 1. **Size, then shape, then identity.** An oversized or non-JSON body never reaches the tenancy
 *    read, so a malformed request cannot be used to probe which tenants exist.
 * 2. **The envelope is strict** (`envelope.ts`): posting `organisationId`, `userId`, `role`, `host`,
 *    `model` or any other key this contract has no place for is a 400, and the rejected key names are
 *    not echoed back — a validation message that lists them is a map of what not to try (plan §8.2).
 *    Nothing is stored or dialled for a request that fails here, which `http.test.ts` asserts by
 *    counting `runDeps` calls.
 * 3. **Tenant and member come from the request's routed host and the verified session only**
 *    (AGENTS.md §4.1, ADR-0006 rule 3): `session()` resolves both, and a handler reads the host from
 *    `request.url`, never from the page-only `x-toi-routed-host` header.
 * 4. **Expert access is checked before the stream opens**, so an unpermitted expert gets a status
 *    code rather than a 200 that ends with nothing in it. `runChat` checks it again, because it is the
 *    place the run is actually made — that duplicate is deliberate, not an accident of layering.
 * 5. **Status codes stop mattering once bytes flow.** After the SSE response is returned, everything
 *    is reported in frames and the run's outcome for logs; a mid-run failure ends the stream, it does
 *    not rewrite the status.
 *
 * Error bodies carry a closed reason key and one safe sentence — no tenant id, no table, no SQLSTATE,
 * no provider, no stack (`SAFE_FAILURE_MESSAGE`, `STORE_MESSAGE`, plan §8.2).
 */

export const CHAT_ENVELOPE_MESSAGE: Record<EnvelopeRejection, string> = {
  invalid_envelope: "That request was not understood.",
  no_user_message: "Ask a question to get an answer.",
  invalid_question: "That question cannot be used as sent.",
};

/** A request body bigger than a chat turn can need. Checked before it is parsed. */
export const MAX_CHAT_BODY_BYTES = 64 * 1024;

export type ChatSessionRead =
  | { ok: true; context: TenantContext; accessToken: string | null }
  | { ok: false; reason: TenantFailureReason };

export interface ChatHttpDeps {
  /** Routed host + verified session + membership, in the merged `resolveTenantContext` order. */
  session(request: Request): Promise<ChatSessionRead>;
  /** Built per verified context, so the access token in scope is the caller's and nobody else's. */
  runDeps(context: TenantContext, accessToken: string | null): Omit<ChatRunDeps, "emit" | "grants">;
  catalog: ExpertCatalog;
  /** Keeps a Worker run alive after the handler returns (Cloudflare `ctx.waitUntil`). */
  waitUntil?: (task: Promise<unknown>) => void;
  maxBodyBytes?: number;
}

/** Status by failure reason: `no_session` invites a sign-in, a tenancy refusal says 403, and an
 *  unavailable dependency is 503 — never a 200 with an empty answer where a permission failed. */
const SESSION_STATUS: Partial<Record<TenantFailureReason, number>> = {
  no_session: 401,
  not_a_member: 403,
  membership_not_active: 403,
  reserved_host: 403,
  tenant_not_live: 409,
  unknown_host: 404,
  missing_host: 404,
  malformed_host: 404,
  too_many_labels: 404,
  preview_alias: 404,
  ip_literal: 404,
  backend_failure: 503,
};

function json(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sessionFailure(reason: TenantFailureReason): Response {
  return json(SESSION_STATUS[reason] ?? 400, { error: reason, message: SAFE_FAILURE_MESSAGE[reason] });
}

function declaredLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** How a request ended without a run: the status the employee got, and why, for logs only. */
export type ChatRefusalOutcome = { kind: "refused_request"; status: number; reason: string };

export interface ChatHandled {
  response: Response;
  /**
   * Settles when the run ends (or at once for a request that never started one). For the caller's
   * logging and for tests; nothing in it is ever rendered (an audit names providers, §9.3).
   */
  outcome: Promise<ChatRunOutcome | ChatRefusalOutcome>;
  /** Frames the transport refused to send: always empty for a correct caller (see `stream.ts`). */
  refusedFrames: () => number;
}

export async function handleChatPost(request: Request, deps: ChatHttpDeps): Promise<Response> {
  const handled = await chatRequest(request, deps);
  return handled.response;
}

/**
 * The same handler with the run's outcome reachable, which is what `http.test.ts` uses to assert that
 * a refused request dialled no store at all and that a delivered answer really was persisted first.
 */
export async function chatRequest(request: Request, deps: ChatHttpDeps): Promise<ChatHandled> {
  const maxBodyBytes = deps.maxBodyBytes ?? MAX_CHAT_BODY_BYTES;
  const declared = declaredLength(request);
  if (declared !== null && declared > maxBodyBytes) {
    return refused(json(413, { error: "invalid_envelope", message: CHAT_ENVELOPE_MESSAGE.invalid_envelope }), "oversized_body");
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return refused(json(400, { error: "invalid_envelope", message: CHAT_ENVELOPE_MESSAGE.invalid_envelope }), "unreadable_body");
  }
  if (new TextEncoder().encode(raw).length > maxBodyBytes) {
    return refused(json(413, { error: "invalid_envelope", message: CHAT_ENVELOPE_MESSAGE.invalid_envelope }), "oversized_body");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return refused(json(400, { error: "invalid_envelope", message: CHAT_ENVELOPE_MESSAGE.invalid_envelope }), "unparsable_body");
  }

  // Shape before identity: an unreadable envelope must not cost a tenant lookup, and the run deps are
  // never built for it, so no store call and no model call can happen for a malformed request.
  const envelope = readChatEnvelope(body);
  if (!envelope.ok) {
    return refused(
      json(400, { error: envelope.reason, message: CHAT_ENVELOPE_MESSAGE[envelope.reason] }),
      envelope.reason,
    );
  }

  const session = await deps.session(request);
  if (!session.ok) {
    const response = sessionFailure(session.reason);
    return refused(response, session.reason);
  }
  const { context, accessToken } = session;

  // Pre-flight expert check, before any bytes are committed to a stream.
  const access = await resolveExpertAccess({
    context,
    expertKey: envelope.request.expertKey,
    projectId: envelope.request.projectId ?? null,
    catalog: deps.catalog,
  });
  if (!access.ok) {
    const notice: RefusalNotice = access.notice;
    return refused(json(403, { error: notice.key, message: notice.message }), notice.key);
  }

  const channel = createFrameChannel();
  const runDeps: ChatRunDeps = {
    ...deps.runDeps(context, accessToken),
    grants: (ctx: TenantContext) => deps.catalog.grants(ctx),
    emit: (frame) => channel.push(frame),
  };

  const outcome = runChat({ context, request: envelope.request }, runDeps).finally(() => {
    // The channel closes whatever happened, so a fault inside the run cannot leave the employee's
    // browser waiting on a stream that will never carry an answer.
    channel.close();
  });
  // A Worker may answer the request before the run finishes; without this the run could be cut off
  // between the retrieval and the durable write, which is the worst place to be interrupted (F22).
  deps.waitUntil?.(outcome);

  const sse = sseResponse(channel);
  return { response: sse.response, outcome, refusedFrames: () => sse.refused.length };
}

function refused(response: Response, reason: string): ChatHandled {
  return {
    response,
    outcome: Promise.resolve<ChatRunOutcome | ChatRefusalOutcome>({
      kind: "refused_request",
      status: response.status,
      reason,
    }),
    refusedFrames: () => 0,
  };
}
