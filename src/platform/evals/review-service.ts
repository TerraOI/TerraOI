import { z } from "zod";

import { issueCsrfToken, verifyCsrfToken } from "@/platform/identity/csrf";
import { readCappedBody } from "@/platform/identity/http-response";
import { hasUsableSecret } from "@/platform/identity/signed-token";
import {
  originAllowed,
  resolveAuthenticatedContext,
  type AdminPorts,
} from "@/platform/tenancy/admin-service";
import type { HostAdapterOptions } from "@/platform/tenancy/host";
import { SAFE_FAILURE_MESSAGE } from "@/platform/tenancy/resolve-tenant-context";

import {
  SAFE_EVAL_REVIEW_MESSAGE,
  decideEvalCase,
  getEvalReviewCase,
  listEvalReviewQueue,
  type EvalCaseStatusFilter,
  type EvalReviewCase,
  type EvalReviewDeps,
  type EvalReviewFailureKind,
} from "./review-queue";

/**
 * Request boundary for the T-303 eval review screens (`/evals`, `/evals/<id>`, `POST /evals/decide`).
 * Tenant and reviewer come only from the routed host + session + membership; the decision body
 * carries the case id, the decision, whitelisted edits and the version token — never an org, a
 * reviewer or a timestamp of its own (plan §14.1 step 3, AGENTS.md §4.1).
 */

export type EvalReviewPorts = Omit<AdminPorts, "adminRpc"> & { review: EvalReviewDeps };

type Denied = { kind: "redirect"; location: string } | { kind: "no_access" | "not_found" | "unavailable"; message: string };

export type EvalReviewListView = { kind: "ready"; cases: EvalReviewCase[] } | Denied;
export type EvalCaseView = { kind: "ready"; case: EvalReviewCase; csrfToken: string } | { kind: "missing"; message: string } | Denied;

export const MAX_EVAL_DECISION_BODY_BYTES = 32 * 1024;
const MISSING_CASE_MESSAGE = "This case is not available to you.";

async function authenticate(input: { request: Request; hostOptions?: HostAdapterOptions; ports: EvalReviewPorts }) {
  const auth = await resolveAuthenticatedContext(input);
  if (!auth.ok) {
    const denied: Denied =
      auth.kind === "redirect" ? { kind: "redirect", location: "/login" } : { kind: auth.kind, message: auth.message };
    return { ok: false as const, denied };
  }
  return auth;
}

function failureView(kind: EvalReviewFailureKind, message: string): Denied {
  return kind === "no_access" ? { kind: "no_access", message } : { kind: "unavailable", message };
}

export async function buildEvalReviewListView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: EvalReviewPorts;
  status: EvalCaseStatusFilter;
}): Promise<EvalReviewListView> {
  const auth = await authenticate(input);
  if (!auth.ok) return auth.denied;
  const listed = await listEvalReviewQueue(auth.context, auth.accessToken, input.status, input.ports.review);
  if (!listed.ok) return failureView(listed.kind, listed.message);
  return { kind: "ready", cases: listed.cases };
}

export async function buildEvalCaseView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: EvalReviewPorts;
  caseId: string;
}): Promise<EvalCaseView> {
  const auth = await authenticate(input);
  if (!auth.ok) return auth.denied;
  const read = await getEvalReviewCase(auth.context, auth.accessToken, input.caseId, input.ports.review);
  if (!read.ok) return failureView(read.kind, read.message);
  if (read.case === null) return { kind: "missing", message: MISSING_CASE_MESSAGE };
  const secret = input.ports.signingSecret();
  if (!hasUsableSecret(secret)) return { kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  const csrfToken = await issueCsrfToken({ host: auth.host, secret, now: input.ports.now() });
  return { kind: "ready", case: read.case, csrfToken };
}

const EditsSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(4000).optional(),
    caseType: z.enum(["answerable", "needs_clarification", "must_refuse", "out_of_scope"]).optional(),
    expectedAnswerPoints: z.array(z.string().trim().min(1).max(2000)).min(1).max(50).optional(),
    expectedSource: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((edits) => Object.keys(edits).length > 0, { message: "an edit must change something" });

const DecisionBodySchema = z.discriminatedUnion("decision", [
  z.strictObject({
    csrfToken: z.string().min(1).max(512),
    caseId: z.uuid(),
    decision: z.literal("approve"),
    expectedUpdatedAt: z.string().min(1).max(64),
  }),
  z.strictObject({
    csrfToken: z.string().min(1).max(512),
    caseId: z.uuid(),
    decision: z.literal("reject"),
    expectedUpdatedAt: z.string().min(1).max(64),
  }),
  z.strictObject({
    csrfToken: z.string().min(1).max(512),
    caseId: z.uuid(),
    decision: z.literal("edit"),
    expectedUpdatedAt: z.string().min(1).max(64),
    edits: EditsSchema,
  }),
]);

function jsonReply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const STATUS_FOR: Record<EvalReviewFailureKind, number> = {
  validation: 422,
  conflict: 409,
  source_invalid: 409,
  no_access: 403,
  backend_failure: 503,
};

export async function handleEvalDecision(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: EvalReviewPorts;
}): Promise<Response> {
  const { request, ports } = input;
  if (request.method !== "POST") {
    return jsonReply(405, { ok: false, code: "method_not_allowed", message: "Method not allowed." });
  }
  const auth = await resolveAuthenticatedContext(input);
  if (!auth.ok) {
    const status = auth.kind === "redirect" ? 401 : auth.kind === "no_access" ? 403 : auth.kind === "unavailable" ? 503 : 404;
    return jsonReply(status, { ok: false, code: auth.kind, message: auth.message });
  }
  if (!originAllowed(request, auth.host)) {
    return jsonReply(403, { ok: false, code: "origin_mismatch", message: "This request did not come from this workspace." });
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonReply(415, { ok: false, code: "unsupported_media_type", message: "Send a JSON body." });
  }
  const secret = ports.signingSecret();
  if (!hasUsableSecret(secret)) {
    return jsonReply(503, { ok: false, code: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure });
  }
  const raw = await readCappedBody(request, MAX_EVAL_DECISION_BODY_BYTES);
  if (raw === null) {
    return jsonReply(413, { ok: false, code: "payload_too_large", message: "The request is too large." });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return jsonReply(400, { ok: false, code: "invalid_request", message: "The request body is not valid JSON." });
  }
  const body = DecisionBodySchema.safeParse(parsedJson);
  if (!body.success) {
    return jsonReply(422, { ok: false, code: "validation", message: SAFE_EVAL_REVIEW_MESSAGE.validation });
  }
  const csrf = await verifyCsrfToken({ token: body.data.csrfToken, host: auth.host, secret, now: ports.now() });
  if (!csrf.ok) {
    return jsonReply(403, { ok: false, code: "csrf_invalid", message: "Refresh the page and try again." });
  }

  const decided = await decideEvalCase(
    auth.context,
    auth.accessToken,
    {
      caseId: body.data.caseId,
      decision: body.data.decision,
      edits: body.data.decision === "edit" ? body.data.edits : {},
      expectedUpdatedAt: body.data.expectedUpdatedAt,
    },
    ports.review,
  );
  if (!decided.ok) {
    return jsonReply(STATUS_FOR[decided.kind], { ok: false, code: decided.kind, message: decided.message });
  }
  return jsonReply(200, { ok: true, updatedAt: decided.updatedAt });
}
