import { z } from "zod";

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

import type { AdminRpcClient, AdminRpcFailureKind } from "./admin-rpc";

/**
 * Request boundary for `/admin/projects`, `/admin/collections` and their create routes
 * (T-202, plan §15.0 / §4.1). Tenant comes only from the routed host + membership; the create
 * body never carries an org id.
 */

export const MAX_ADMIN_BODY_BYTES = 16 * 1024;

export interface AdminPorts {
  now(): number;
  signingSecret(): string | null;
  sessionStore(): SessionStore | null;
  tokenCipher(): TokenCipher | null;
  findHost(host: string): Promise<HostRecord | null>;
  findMembership(organisationId: string, accessToken: string): Promise<MembershipRecord | null>;
  policyRevision(organisationId: string, accessToken: string): Promise<number>;
  adminRpc: AdminRpcClient;
}

export type AdminFormView =
  | { kind: "ready"; host: string; csrfToken: string }
  | { kind: "redirect"; location: string }
  | { kind: "no_access"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; message: string };

export type AdminProjectsView = AdminFormView;

type AuthenticatedAdminContext =
  | { ok: true; host: string; context: TenantContext; accessToken: string }
  | { ok: false; kind: "redirect" | "no_access" | "not_found" | "unavailable"; message: string };

function mapTenantFailure(reason: TenantFailureReason): AuthenticatedAdminContext {
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
  ports: AdminPorts;
}): Promise<AuthenticatedAdminContext> {
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

async function buildAdminFormView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<AdminFormView> {
  const auth = await resolveAuthenticatedContext(input);
  if (!auth.ok) {
    if (auth.kind === "redirect") return { kind: "redirect", location: "/login" };
    return { kind: auth.kind, message: auth.message };
  }

  const secret = input.ports.signingSecret();
  if (!hasUsableSecret(secret)) {
    return { kind: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure };
  }

  const csrfToken = await issueCsrfToken({ host: auth.host, secret, now: input.ports.now() });
  return { kind: "ready", host: auth.host, csrfToken };
}

export async function buildAdminProjectsView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<AdminFormView> {
  return buildAdminFormView(input);
}

export async function buildAdminCollectionsView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<AdminFormView> {
  return buildAdminFormView(input);
}

export async function buildAdminMembersView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<AdminFormView> {
  return buildAdminFormView(input);
}

const CreateProjectBodySchema = z.strictObject({
  csrfToken: z.string().min(1).max(512),
  key: z.string().min(1).max(63),
  name: z.string().min(1).max(200),
  visibility: z.enum(["organisation", "project"]),
});

const CreateCollectionBodySchema = z.strictObject({
  csrfToken: z.string().min(1).max(512),
  key: z.string().min(1).max(63),
  name: z.string().min(1).max(200),
  service: z.string().min(1).max(64),
  dataClass: z.enum(["public", "internal", "client_confidential"]),
  projectId: z.uuid().nullable(),
});

const MembershipRoleBodySchema = z.strictObject({
  csrfToken: z.string().min(1).max(512),
  action: z.enum(["grant", "revoke"]),
  userId: z.uuid(),
  roleId: z.uuid(),
});

const InviteMemberBodySchema = z.strictObject({
  csrfToken: z.string().min(1).max(512),
  email: z.string().min(1).max(254),
  roleId: z.uuid(),
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

function statusForRpcFailure(kind: AdminRpcFailureKind): number {
  switch (kind) {
    case "validation":
      return 422;
    case "constraint":
    case "rejected":
    case "last_admin":
    case "target_inactive":
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

type GuardedAdminPost<T> =
  | { ok: true; auth: Extract<AuthenticatedAdminContext, { ok: true }>; data: T }
  | { ok: false; response: Response };

/**
 * The guard pipeline every admin create POST shares (method, session, Origin, content type, body
 * cap, strict schema, CSRF), in one place so a new form cannot skip a step (supervisor round 1 on
 * #234). The schema must be a strict object: a body naming an organisation is refused, never stripped.
 */
async function guardAdminPost<T extends { csrfToken: string }>(
  input: { request: Request; hostOptions?: HostAdapterOptions; ports: AdminPorts },
  schema: z.ZodType<T>,
  invalidMessage: string,
): Promise<GuardedAdminPost<T>> {
  const { request, ports } = input;
  const refuse = (status: number, body: Record<string, unknown>): GuardedAdminPost<T> => ({
    ok: false,
    response: jsonReply(status, body),
  });
  if (request.method !== "POST") {
    return refuse(405, { ok: false, code: "method_not_allowed", message: "Method not allowed." });
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
    return refuse(status, { ok: false, code: auth.kind, message: auth.message });
  }

  if (!originAllowed(request, auth.host)) {
    return refuse(403, {
      ok: false,
      code: "origin_mismatch",
      message: "This request did not come from this workspace.",
    });
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return refuse(415, { ok: false, code: "unsupported_media_type", message: "Send a JSON body." });
  }

  const secret = ports.signingSecret();
  if (!hasUsableSecret(secret)) {
    return refuse(503, { ok: false, code: "unavailable", message: SAFE_FAILURE_MESSAGE.backend_failure });
  }

  const rawBody = await readCappedBody(request, MAX_ADMIN_BODY_BYTES);
  if (rawBody === null) {
    return refuse(413, { ok: false, code: "payload_too_large", message: "The request is too large." });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return refuse(400, { ok: false, code: "invalid_request", message: "The request body is not valid JSON." });
  }

  const body = schema.safeParse(parsedJson);
  if (!body.success) {
    return refuse(400, { ok: false, code: "invalid_request", message: invalidMessage });
  }

  const csrf = await verifyCsrfToken({
    token: body.data.csrfToken,
    host: auth.host,
    secret,
    now: ports.now(),
  });
  if (!csrf.ok) {
    return refuse(403, { ok: false, code: "csrf_invalid", message: "Refresh the page and try again." });
  }

  return { ok: true, auth, data: body.data };
}

function createdReply(
  created: Awaited<ReturnType<AdminRpcClient["createProject"]>>,
  idField: "projectId" | "collectionId",
): Response {
  if (!created.ok) {
    return jsonReply(statusForRpcFailure(created.kind), {
      ok: false,
      code: created.kind,
      message: created.message,
    });
  }
  return jsonReply(201, { ok: true, [idField]: created.id });
}

export async function handleCreateProject(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<Response> {
  const guarded = await guardAdminPost(input, CreateProjectBodySchema, "The project request is invalid.");
  if (!guarded.ok) return guarded.response;
  const { auth, data } = guarded;
  const created = await input.ports.adminRpc.createProject({
    context: auth.context,
    accessToken: auth.accessToken,
    key: data.key,
    name: data.name,
    visibility: data.visibility,
  });
  return createdReply(created, "projectId");
}

export async function handleCreateCollection(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<Response> {
  const guarded = await guardAdminPost(
    input,
    CreateCollectionBodySchema,
    "The collection request is invalid.",
  );
  if (!guarded.ok) return guarded.response;
  const { auth, data } = guarded;
  const created = await input.ports.adminRpc.createCollection({
    context: auth.context,
    accessToken: auth.accessToken,
    key: data.key,
    name: data.name,
    service: data.service,
    dataClass: data.dataClass,
    projectId: data.projectId,
  });
  return createdReply(created, "collectionId");
}

export async function handleMembershipRoleAction(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<Response> {
  // Supervisor round 1 on #236: the shared guard (round 1 on #234) rather than a copy of it, so the
  // three admin POSTs cannot drift apart on method, auth, origin, size, JSON or CSRF checks.
  const guarded = await guardAdminPost(
    input,
    MembershipRoleBodySchema,
    "The membership role request is invalid.",
  );
  if (!guarded.ok) return guarded.response;
  const { auth, data } = guarded;
  const { ports } = input;

  const args = {
    context: auth.context,
    accessToken: auth.accessToken,
    userId: data.userId,
    roleId: data.roleId,
  };
  const outcome =
    data.action === "grant"
      ? await ports.adminRpc.grantMembershipRole(args)
      : await ports.adminRpc.revokeMembershipRole(args);

  if (!outcome.ok) {
    return jsonReply(statusForRpcFailure(outcome.kind), {
      ok: false,
      code: outcome.kind,
      message: outcome.message,
    });
  }

  return jsonReply(200, { ok: true, action: data.action });
}

export async function handleInviteMember(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: AdminPorts;
}): Promise<Response> {
  // Supervisor round 1 on #237: the shared guard (round 1 on #234), not a copy of it.
  const guarded = await guardAdminPost(input, InviteMemberBodySchema, "The invite request is invalid.");
  if (!guarded.ok) return guarded.response;
  const { auth, data } = guarded;
  const { ports } = input;

  const invited = await ports.adminRpc.inviteMember({
    context: auth.context,
    accessToken: auth.accessToken,
    email: data.email,
    roleId: data.roleId,
  });

  if (!invited.ok) {
    return jsonReply(statusForRpcFailure(invited.kind), {
      ok: false,
      code: invited.kind,
      message: invited.message,
    });
  }

  return jsonReply(200, { ok: true });
}
