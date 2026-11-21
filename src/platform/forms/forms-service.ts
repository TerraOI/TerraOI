import { z } from "zod";

import type { FormTemplate } from "@/contracts/form-template";
import { VersionTag } from "@/contracts/keys";
import type { TenantContext } from "@/contracts/tenant-context";
import { issueCsrfToken, verifyCsrfToken } from "@/platform/identity/csrf";
import { readCappedBody } from "@/platform/identity/http-response";
import { readSessionTokens } from "@/platform/identity/session";
import type { SessionStore, TokenCipher } from "@/platform/identity/session-store";
import { hasUsableSecret } from "@/platform/identity/signed-token";
import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import {
  resolveTenantContext,
  SAFE_FAILURE_MESSAGE,
  type HostRecord,
  type MembershipRecord,
  type TenantFailureReason,
} from "@/platform/tenancy/resolve-tenant-context";

import type { FormsRpcClient, FormsRpcFailureKind } from "./forms-rpc";
import { extractFormFields, type FormFieldSpec } from "./template-schema";

/**
 * Request boundary for `/forms`, `/forms/[templateId]` and `POST /forms/submit` (plan §7.6, §4.1).
 *
 * Tenant identity comes strictly from the routed host plus live membership verification via
 * `resolveTenantContext`. Client payloads use strict Zod schemas so any forged `organisationId`,
 * `p_organisation_id` or `userId` is rejected before touching any port.
 */

export const MAX_FORM_BODY_BYTES = 128 * 1024;

export interface FormsPorts {
  now(): number;
  signingSecret(): string | null;
  sessionStore(): SessionStore | null;
  tokenCipher(): TokenCipher | null;
  findHost(host: string): Promise<HostRecord | null>;
  findMembership(organisationId: string, accessToken: string): Promise<MembershipRecord | null>;
  policyRevision(organisationId: string, accessToken: string): Promise<number>;
  listTemplates(context: TenantContext): Promise<FormTemplate[]>;
  findTemplate(context: TenantContext, templateId: string): Promise<FormTemplate | null>;
  formsRpc: FormsRpcClient;
}

export type FormsListView =
  | { kind: "ready"; host: string; templates: FormTemplate[] }
  | { kind: "redirect"; location: string }
  | { kind: "no_access"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; message: string };

export type FormDetailView =
  | {
      kind: "ready";
      host: string;
      template: FormTemplate;
      fields: FormFieldSpec[];
      csrfToken: string;
      supersedesSubmissionId?: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "no_access"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; message: string };

type AuthenticatedFormsContext =
  | { ok: true; host: string; context: TenantContext; accessToken: string }
  | { ok: false; kind: "redirect" | "no_access" | "not_found" | "unavailable"; message: string };

function mapTenantFailure(reason: TenantFailureReason): AuthenticatedFormsContext {
  switch (reason) {
    case "no_session":
      return { ok: false, kind: "redirect", message: SAFE_FAILURE_MESSAGE[reason] };
    case "not_a_member":
    case "membership_not_active":
    case "tenant_not_live":
      return { ok: false, kind: "no_access", message: SAFE_FAILURE_MESSAGE[reason] };
    case "backend_failure":
      return { ok: false, kind: "unavailable", message: SAFE_FAILURE_MESSAGE[reason] };
    case "missing_host":
    case "malformed_host":
    case "too_many_labels":
    case "preview_alias":
    case "ip_literal":
    case "unknown_host":
    case "reserved_host":
      return { ok: false, kind: "not_found", message: SAFE_FAILURE_MESSAGE[reason] };
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return { ok: false, kind: "not_found", message: SAFE_FAILURE_MESSAGE.unknown_host };
    }
  }
}

async function resolveAuthenticatedContext(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: FormsPorts;
}): Promise<AuthenticatedFormsContext> {
  const { ports } = input;
  const parsed = parseHost(requestHost({ url: input.request.url }, input.hostOptions));
  if (!parsed.ok) return mapTenantFailure(parsed.reason);
  if (parsed.class !== "tenant") return mapTenantFailure("reserved_host");

  const sessionStore = ports.sessionStore();
  const tokenCipher = ports.tokenCipher();
  if (sessionStore === null || tokenCipher === null) {
    return { ok: false, kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  }

  const tokens = await readSessionTokens({
    cookieHeader: input.request.headers.get("cookie"),
    host: parsed.host,
    now: ports.now(),
    store: sessionStore,
    cipher: tokenCipher,
  });

  const userId = tokens.ok ? tokens.userId : null;
  const accessToken = tokens.ok ? tokens.tokens.accessToken : null;

  if (!tokens.ok && (tokens.reason === "store_failure" || tokens.reason === "undecryptable")) {
    return { ok: false, kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  }

  const resolution = await resolveTenantContext({
    request: { url: input.request.url },
    hostOptions: input.hostOptions,
    userId,
    store: {
      findHost: (host) => ports.findHost(host),
      findMembership: async (organisationId) => {
        if (accessToken === null) return null;
        return ports.findMembership(organisationId, accessToken);
      },
      policyRevision: async (organisationId) => {
        if (accessToken === null) throw new Error("missing access token");
        return ports.policyRevision(organisationId, accessToken);
      },
    },
  });

  if (!resolution.ok) return mapTenantFailure(resolution.reason);
  if (accessToken === null) {
    return { ok: false, kind: "redirect", message: SAFE_FAILURE_MESSAGE.no_session };
  }

  return { ok: true, host: parsed.host, context: resolution.context, accessToken };
}

export async function buildFormsListView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: FormsPorts;
}): Promise<FormsListView> {
  const auth = await resolveAuthenticatedContext(input);
  if (!auth.ok) {
    if (auth.kind === "redirect") return { kind: "redirect", location: "/login" };
    return { kind: auth.kind, message: auth.message };
  }

  try {
    const templates = await input.ports.listTemplates(auth.context);
    return { kind: "ready", host: auth.host, templates };
  } catch {
    return { kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  }
}

export async function buildFormDetailView(input: {
  request: Request;
  templateId: string;
  supersedesSubmissionId?: string;
  hostOptions?: HostAdapterOptions;
  ports: FormsPorts;
}): Promise<FormDetailView> {
  const auth = await resolveAuthenticatedContext(input);
  if (!auth.ok) {
    if (auth.kind === "redirect") return { kind: "redirect", location: "/login" };
    return { kind: auth.kind, message: auth.message };
  }

  if (!z.uuid().safeParse(input.templateId).success) {
    return { kind: "not_found", message: "That form is not available." };
  }

  const secret = input.ports.signingSecret();
  if (!hasUsableSecret(secret)) {
    return { kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  }

  let template: FormTemplate | null;
  try {
    template = await input.ports.findTemplate(auth.context, input.templateId);
  } catch {
    return { kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  }
  if (template === null) {
    return { kind: "not_found", message: "That form is not available." };
  }

  let fields: FormFieldSpec[];
  try {
    fields = extractFormFields(template);
  } catch {
    return { kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  }

  const csrfToken = await issueCsrfToken({ host: auth.host, secret, now: input.ports.now() });
  const supersedes =
    input.supersedesSubmissionId !== undefined && z.uuid().safeParse(input.supersedesSubmissionId).success
      ? input.supersedesSubmissionId
      : undefined;

  return {
    kind: "ready",
    host: auth.host,
    template,
    fields,
    csrfToken,
    ...(supersedes === undefined ? {} : { supersedesSubmissionId: supersedes }),
  };
}

const FormActionBodySchema = z.strictObject({
  action: z.enum(["draft", "submit"]),
  csrfToken: z.string().min(1).max(512),
  templateId: z.uuid(),
  templateVersion: VersionTag,
  values: z.record(z.string(), z.unknown()),
  submissionId: z.uuid().optional(),
  supersedesSubmissionId: z.uuid().optional(),
});

function jsonReply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function originAllowed(request: Request, host: string): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  if (origin === `https://${host}`) return true;
  if (process.env.NODE_ENV === "development") {
    try {
      return origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  return false;
}

function statusForRpcFailure(kind: FormsRpcFailureKind): number {
  switch (kind) {
    case "validation":
      return 422;
    case "version_closed":
    case "rejected":
      return 409;
    case "tenancy":
      return 403;
    case "backend_failure":
    case "not_configured":
      return 503;
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return 503;
    }
  }
}

export async function handleFormAction(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: FormsPorts;
}): Promise<Response> {
  const { request, ports } = input;
  if (request.method !== "POST") {
    return jsonReply(405, { ok: false, code: "method_not_allowed", message: "Method not allowed." });
  }

  const auth = await resolveAuthenticatedContext(input);
  if (!auth.ok) {
    const status =
      auth.kind === "redirect"
        ? 401
        : auth.kind === "no_access"
          ? 403
          : auth.kind === "unavailable"
            ? 503
            : 404;
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

  const rawBody = await readCappedBody(request, MAX_FORM_BODY_BYTES);
  if (rawBody === null) {
    return jsonReply(413, { ok: false, code: "payload_too_large", message: "The submission is too large." });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return jsonReply(400, { ok: false, code: "invalid_request", message: "The request body is not valid JSON." });
  }

  const body = FormActionBodySchema.safeParse(parsedJson);
  if (!body.success) {
    return jsonReply(400, { ok: false, code: "invalid_request", message: "The form submission request is invalid." });
  }

  const csrf = await verifyCsrfToken({
    token: body.data.csrfToken,
    host: auth.host,
    secret,
    now: ports.now(),
  });
  if (!csrf.ok) {
    return jsonReply(403, { ok: false, code: "csrf_invalid", message: "Your form session expired. Reload the page and try again." });
  }

  let template: FormTemplate | null;
  try {
    template = await ports.findTemplate(auth.context, body.data.templateId);
  } catch {
    return jsonReply(503, { ok: false, code: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure });
  }
  if (template === null) {
    return jsonReply(404, { ok: false, code: "not_found", message: "That form is not available." });
  }

  if (template.status !== "published" || template.version !== body.data.templateVersion) {
    return jsonReply(409, {
      ok: false,
      code: "version_closed",
      message: `Template version ${body.data.templateVersion} is no longer open for submissions.`,
    });
  }

  if (body.data.action === "draft") {
    const result = await ports.formsRpc.saveDraft({
      context: auth.context,
      accessToken: auth.accessToken,
      template,
      templateVersion: body.data.templateVersion,
      values: body.data.values,
      ...(body.data.supersedesSubmissionId === undefined
        ? {}
        : { supersedesSubmissionId: body.data.supersedesSubmissionId }),
    });
    if (!result.ok) {
      return jsonReply(statusForRpcFailure(result.kind), {
        ok: false,
        code: result.kind,
        message: result.message,
        ...(result.fieldErrors === undefined ? {} : { fieldErrors: result.fieldErrors }),
      });
    }
    return jsonReply(201, {
      ok: true,
      state: "draft",
      submissionId: result.submissionId,
      templateId: template.id,
      templateVersion: template.version,
    });
  }

  const result =
    body.data.submissionId !== undefined
      ? await ports.formsRpc.submitDraft({
          context: auth.context,
          accessToken: auth.accessToken,
          submissionId: body.data.submissionId,
        })
      : await ports.formsRpc.saveAndSubmit({
          context: auth.context,
          accessToken: auth.accessToken,
          template,
          templateVersion: body.data.templateVersion,
          values: body.data.values,
          ...(body.data.supersedesSubmissionId === undefined
            ? {}
            : { supersedesSubmissionId: body.data.supersedesSubmissionId }),
        });

  if (!result.ok) {
    return jsonReply(statusForRpcFailure(result.kind), {
      ok: false,
      code: result.kind,
      message: result.message,
      ...(result.fieldErrors === undefined ? {} : { fieldErrors: result.fieldErrors }),
      ...(result.draftSubmissionId === undefined ? {} : { draftSubmissionId: result.draftSubmissionId }),
    });
  }

  return jsonReply(200, {
    ok: true,
    state: "submitted",
    submissionId: result.submissionId,
    templateId: template.id,
    templateVersion: template.version,
  });
}
