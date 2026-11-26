import {
  CreateKnowledgeSubmissionRequest,
  ReviewKnowledgeSubmissionRequest,
} from "@/contracts/knowledge-submission";
import type { TenantContext } from "@/contracts/tenant-context";
import type { TenantFailureReason, TenantResolution } from "@/platform/tenancy/resolve-tenant-context";

import {
  SAFE_SUBMISSION_RPC_MESSAGE,
  type SubmissionRpcClient,
  type SubmissionRpcFailureKind,
} from "./submission-rpc";

/**
 * HTTP handlers for T-302b F15 submissions (plan §9, FAQ-0005, ADR-0013).
 *
 * Tenant and actor come only from `resolveContext` + the signed-in access token. Bodies never
 * carry an organisation id. Adapters may leave deps unbound (503) until #37 — same seam as uploads.
 */

/** Proposed text can be up to 200k; allow a small JSON envelope on top. */
const MAX_REQUEST_BODY_BYTES = 220_000;

export const SAFE_SUBMISSION_MESSAGES: Record<string, string> = {
  ...SAFE_SUBMISSION_RPC_MESSAGE,
  unauthorized: "Please sign in to continue.",
  forbidden: "You do not have access to this workspace.",
  not_found: "This address is not recognized.",
  origin_mismatch: "This request could not be verified.",
  unsupported_media_type: "Send JSON.",
  payload_too_large: "That request is too large.",
  invalid_request: "Check the fields and try again.",
  internal_error: "The service is temporarily unavailable. Please try again.",
  submissions_unavailable: "The service is temporarily unavailable. Please try again.",
};

export interface SubmissionDeps {
  resolveContext(request: Request): Promise<TenantResolution>;
  accessToken(request: Request): Promise<string | null>;
  client: SubmissionRpcClient;
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

const FAILURE_STATUS: Record<SubmissionRpcFailureKind, number> = {
  validation: 400,
  tenancy: 403,
  constraint: 409,
  rejected: 409,
  backend_failure: 503,
  not_configured: 503,
};

function reply(status: number, code: string, extra?: Record<string, unknown>): Response {
  const body =
    extra === undefined
      ? { error: { code, message: SAFE_SUBMISSION_MESSAGES[code] ?? SAFE_SUBMISSION_MESSAGES.internal_error } }
      : extra;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function contextFailure(reason: TenantFailureReason): Response {
  const code =
    reason === "no_session"
      ? "unauthorized"
      : reason === "backend_failure"
        ? "internal_error"
        : reason === "not_a_member" || reason === "membership_not_active" || reason === "tenant_not_live"
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
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
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
  if (text.length > MAX_REQUEST_BODY_BYTES) return { ok: false, response: reply(413, "payload_too_large") };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: reply(400, "invalid_request") };
  }
}

async function gate(
  request: Request,
  deps: SubmissionDeps,
): Promise<{ ok: true; context: TenantContext; token: string } | { ok: false; response: Response }> {
  const resolution = await deps.resolveContext(request);
  if (!resolution.ok) return { ok: false, response: contextFailure(resolution.reason) };
  if (originMismatch(request)) return { ok: false, response: reply(403, "origin_mismatch") };
  const token = await deps.accessToken(request);
  if (token === null || token.trim().length === 0) {
    return { ok: false, response: reply(401, "unauthorized") };
  }
  return { ok: true, context: resolution.context, token };
}

function mapRpcFailure(kind: SubmissionRpcFailureKind, message: string): Response {
  return reply(FAILURE_STATUS[kind], kind, {
    error: { code: kind, message },
  });
}

export async function handleCreateSubmission(request: Request, deps: SubmissionDeps): Promise<Response> {
  const gated = await gate(request, deps);
  if (!gated.ok) return gated.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = CreateKnowledgeSubmissionRequest.safeParse(body.value);
  if (!parsed.success) return reply(400, "invalid_request");

  const outcome = await deps.client.submit({
    context: gated.context,
    accessToken: gated.token,
    collectionId: parsed.data.collectionId,
    kind: parsed.data.kind,
    proposedText: parsed.data.proposedText,
    contextDataClass: parsed.data.contextDataClass,
    citedSourceVersionIds: parsed.data.citedSourceVersionIds,
    agentRunId: parsed.data.agentRunId,
    reviewBy: parsed.data.reviewBy,
  });
  if (!outcome.ok) return mapRpcFailure(outcome.kind, outcome.message);
  return reply(201, "ok", { submissionId: outcome.id });
}

export async function handleReviewSubmission(
  request: Request,
  deps: SubmissionDeps,
  submissionId: string,
): Promise<Response> {
  const gated = await gate(request, deps);
  if (!gated.ok) return gated.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = ReviewKnowledgeSubmissionRequest.safeParse(body.value);
  if (!parsed.success) return reply(400, "invalid_request");

  const outcome = await deps.client.review({
    context: gated.context,
    accessToken: gated.token,
    submissionId,
    decision: parsed.data.decision,
    reason: parsed.data.reason,
  });
  if (!outcome.ok) return mapRpcFailure(outcome.kind, outcome.message);
  return reply(200, "ok", { submissionId: outcome.id });
}
