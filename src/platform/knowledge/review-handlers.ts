import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";
import type {
  TenantFailureReason,
  TenantResolution,
} from "@/platform/tenancy/resolve-tenant-context";

import {
  MAX_REVIEW_REASON_CHARS,
  SAFE_REVIEW_RPC_MESSAGE,
  type ReviewRpcClient,
  type ReviewRpcFailureKind,
} from "./review-rpc";

/**
 * HTTP handlers for T-213 review/publish/revoke (F13/F14, plan §7.2 steps 7–9, FAQ-0005).
 *
 * Tenant and actor come only from `resolveContext` + the signed-in access token. Request bodies
 * never carry an organisation id. Routes stay thin; adapters may leave deps unbound (503) until
 * #37 wires identity into Workers — the same seam as uploads.
 */

const UUID = z.uuid();
// Strict: a body that names an organisation (or anything else) is refused, not silently stripped.
const Reason = z.string().trim().min(1).max(MAX_REVIEW_REASON_CHARS);
const DecisionBody = z.strictObject({
  sourceVersionId: UUID,
  decision: z.enum(["approve", "reject"]),
  reason: Reason.optional(),
});
const PublishBody = z.strictObject({ sourceVersionId: UUID });
const RevokeBody = z.strictObject({
  sourceId: UUID,
  reason: Reason.optional(),
});

const MAX_REQUEST_BODY_BYTES = 8_192;

export const SAFE_REVIEW_MESSAGES: Record<string, string> = {
  ...SAFE_REVIEW_RPC_MESSAGE,
  unauthorized: "Please sign in to continue.",
  forbidden: "You do not have access to this workspace.",
  not_found: "This address is not recognized.",
  origin_mismatch: "This request could not be verified.",
  unsupported_media_type: "Send JSON.",
  payload_too_large: "That request is too large.",
  invalid_request: "Check the fields and try again.",
  internal_error: "The service is temporarily unavailable. Please try again.",
  review_unavailable:
    "The service is temporarily unavailable. Please try again.",
};

export interface ReviewDeps {
  resolveContext(request: Request): Promise<TenantResolution>;
  accessToken(request: Request): Promise<string | null>;
  client: ReviewRpcClient;
}

const CONTEXT_STATUS: Record<TenantFailureReason, number> = {
  missing_host: 404,
  malformed_host: 404,
  too_many_labels: 404,
  preview_alias: 404,
  ip_literal: 404,
  unknown_host: 404,
  reserved_host: 404,
  tenant_not_live: 403,
  no_session: 401,
  not_a_member: 403,
  membership_not_active: 403,
  backend_failure: 503,
};

const FAILURE_STATUS: Record<ReviewRpcFailureKind, number> = {
  validation: 400,
  tenancy: 403,
  constraint: 409,
  rejected: 409,
  backend_failure: 503,
  not_configured: 503,
};

function reply(
  status: number,
  code: string,
  extra?: Record<string, unknown>,
): Response {
  const body =
    extra === undefined
      ? {
          error: {
            code,
            message:
              SAFE_REVIEW_MESSAGES[code] ?? SAFE_REVIEW_MESSAGES.internal_error,
          },
        }
      : extra;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function contextFailure(reason: TenantFailureReason): Response {
  const code =
    reason === "no_session"
      ? "unauthorized"
      : reason === "backend_failure"
        ? "internal_error"
        : reason === "not_a_member" ||
            reason === "membership_not_active" ||
            reason === "tenant_not_live"
          ? "forbidden"
          : "not_found";
  return reply(CONTEXT_STATUS[reason], code);
}

function originMismatch(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

function isJson(contentType: string | null): boolean {
  return (
    contentType?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!isJson(request.headers.get("content-type"))) {
    return { ok: false, response: reply(415, "unsupported_media_type") };
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, response: reply(413, "payload_too_large") };
  }
  const text = await request.text();
  if (text.length > MAX_REQUEST_BODY_BYTES)
    return { ok: false, response: reply(413, "payload_too_large") };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: reply(400, "invalid_request") };
  }
}

async function gate(
  request: Request,
  deps: ReviewDeps,
): Promise<
  | { ok: true; context: TenantContext; token: string }
  | { ok: false; response: Response }
> {
  const resolution = await deps.resolveContext(request);
  if (!resolution.ok)
    return { ok: false, response: contextFailure(resolution.reason) };
  if (originMismatch(request))
    return { ok: false, response: reply(403, "origin_mismatch") };
  const token = await deps.accessToken(request);
  if (token === null || token.trim().length === 0) {
    return { ok: false, response: reply(401, "unauthorized") };
  }
  return { ok: true, context: resolution.context, token };
}

function mapRpcFailure(kind: ReviewRpcFailureKind, message: string): Response {
  return reply(FAILURE_STATUS[kind], kind, {
    error: { code: kind, message },
  });
}

export async function handleReviewDecision(
  request: Request,
  deps: ReviewDeps,
): Promise<Response> {
  const gated = await gate(request, deps);
  if (!gated.ok) return gated.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = DecisionBody.safeParse(body.value);
  if (!parsed.success) return reply(400, "invalid_request");

  const outcome = await deps.client.reviewDecision({
    context: gated.context,
    accessToken: gated.token,
    sourceVersionId: parsed.data.sourceVersionId,
    decision: parsed.data.decision,
    reason: parsed.data.reason,
  });
  if (!outcome.ok) return mapRpcFailure(outcome.kind, outcome.message);
  return reply(200, "ok", { decisionId: outcome.id });
}

export async function handlePublishKnowledgeVersion(
  request: Request,
  deps: ReviewDeps,
): Promise<Response> {
  const gated = await gate(request, deps);
  if (!gated.ok) return gated.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = PublishBody.safeParse(body.value);
  if (!parsed.success) return reply(400, "invalid_request");

  const outcome = await deps.client.publishKnowledgeVersion({
    context: gated.context,
    accessToken: gated.token,
    sourceVersionId: parsed.data.sourceVersionId,
  });
  if (!outcome.ok) return mapRpcFailure(outcome.kind, outcome.message);
  return reply(200, "ok", { sourceVersionId: outcome.id });
}

export async function handleRevokeSource(
  request: Request,
  deps: ReviewDeps,
): Promise<Response> {
  const gated = await gate(request, deps);
  if (!gated.ok) return gated.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = RevokeBody.safeParse(body.value);
  if (!parsed.success) return reply(400, "invalid_request");

  const outcome = await deps.client.revokeSource({
    context: gated.context,
    accessToken: gated.token,
    sourceId: parsed.data.sourceId,
    reason: parsed.data.reason,
  });
  if (!outcome.ok) return mapRpcFailure(outcome.kind, outcome.message);
  return reply(200, "ok", { ok: true });
}
