import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";
import { withTenantRpc, type TenantRpcConfig } from "@/platform/tenancy/tenant-rpc";

import type {
  BeginSessionResult,
  RegisterResult,
  UploadSession,
  UploadStore,
} from "./upload-session";
/**
 * Postgres `UploadStore` over the capture RPCs (#37(b), FAQ-0011, #163).
 *
 * Every write goes through `withTenantRpc` with the caller's access token. The organisation is
 * taken from `TenantContext` only; `auth.uid()` comes from the token. `findSession` uses a scoped
 * read RPC because the table's SELECT policy requires `current_organisation_id()` (set inside the
 * RPC), so a bare PostgREST select would always see no rows.
 */

const BeginRow = z.strictObject({
  o_session_id: z.uuid(),
  o_object_ref: z.string().min(1),
  o_max_size_bytes: z.number().int().positive(),
  o_expires_at: z.string().min(1),
  o_state: z.enum(["awaiting_upload", "completed", "quarantined", "failed", "expired"]),
  o_reused: z.boolean(),
});

const SessionRow = z.strictObject({
  o_session_id: z.uuid(),
  o_organisation_id: z.uuid(),
  o_collection_id: z.uuid(),
  o_created_by: z.uuid(),
  o_idempotency_key: z.string().min(1),
  o_object_ref: z.string().min(1),
  o_max_size_bytes: z.number().int().positive(),
  o_state: z.enum(["awaiting_upload", "completed", "quarantined", "failed", "expired"]),
  o_reason_code: z.string().nullable(),
  o_expires_at: z.string().min(1),
  o_created_at: z.string().min(1),
  o_source_id: z.uuid().nullable(),
  o_source_version_id: z.uuid().nullable(),
});

const RegisterRow = z.strictObject({
  o_source_id: z.uuid(),
  o_source_version_id: z.uuid(),
  o_state: z.string().min(1),
  o_already_uploaded: z.boolean(),
});

function asRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data === null || data === undefined) return [];
  return [data];
}

function mapSession(row: z.infer<typeof SessionRow>): UploadSession {
  return {
    id: row.o_session_id,
    organisationId: row.o_organisation_id,
    collectionId: row.o_collection_id,
    createdBy: row.o_created_by,
    idempotencyKey: row.o_idempotency_key,
    objectRef: row.o_object_ref,
    maxBytes: row.o_max_size_bytes,
    state: row.o_state,
    reasonCode: row.o_reason_code,
    expiresAt: row.o_expires_at,
    createdAt: row.o_created_at,
    sourceId: row.o_source_id,
    sourceVersionId: row.o_source_version_id,
  };
}

export interface PostgresUploadStoreDeps {
  /** Fresh context for this request (organisation from host + membership). */
  context: TenantContext;
  /** Caller's Supabase access token (ADR-0003 / #37(b)). */
  accessToken: string;
  rpc: TenantRpcConfig;
}

export function createPostgresUploadStore(deps: PostgresUploadStoreDeps): UploadStore {
  return {
    async beginSession(cmd): Promise<BeginSessionResult> {
      const outcome = await withTenantRpc(
        deps.context,
        "begin_upload_session_v1",
        {
          p_collection_id: cmd.collectionId,
          p_idempotency_key: cmd.idempotencyKey,
          p_filename: cmd.filename,
          p_declared_size_bytes: cmd.maxBytes,
        },
        deps.accessToken,
        deps.rpc,
      );
      if (!outcome.ok) {
        if (outcome.kind === "tenancy") {
          if (outcome.sqlstate === "28000") return { status: "no_tenant_scope" };
          return { status: "not_publishable" };
        }
        throw new Error("begin_upload_session_v1 unavailable");
      }
      const rows = asRows(outcome.data);
      if (rows.length === 0) throw new Error("begin_upload_session_v1 returned no row");
      const parsed = BeginRow.safeParse(rows[0]);
      if (!parsed.success) throw new Error("begin_upload_session_v1 shape mismatch");
      const row = parsed.data;
      // Map SQLSTATE-shaped refusals that PostgREST may surface as empty + error already handled.
      // Quota and collection refusals arrive as tenancy above; a successful row is always ok.
      return {
        status: "ok",
        session: {
          id: row.o_session_id,
          organisationId: cmd.organisationId,
          collectionId: cmd.collectionId,
          createdBy: deps.context.userId,
          idempotencyKey: cmd.idempotencyKey,
          objectRef: row.o_object_ref,
          maxBytes: row.o_max_size_bytes,
          state: row.o_state,
          reasonCode: null,
          expiresAt: row.o_expires_at,
          createdAt: new Date().toISOString(),
          sourceId: null,
          sourceVersionId: null,
        },
      };
    },

    async findSession(cmd): Promise<UploadSession | null> {
      const outcome = await withTenantRpc(
        deps.context,
        "find_upload_session_v1",
        { p_upload_session_id: cmd.uploadId },
        deps.accessToken,
        deps.rpc,
      );
      if (!outcome.ok) {
        if (outcome.kind === "tenancy") return null;
        throw new Error("find_upload_session_v1 unavailable");
      }
      const rows = asRows(outcome.data);
      if (rows.length === 0) return null;
      const parsed = SessionRow.safeParse(rows[0]);
      if (!parsed.success) throw new Error("find_upload_session_v1 shape mismatch");
      const session = mapSession(parsed.data);
      if (session.organisationId !== cmd.organisationId || session.createdBy !== cmd.userId) {
        return null;
      }
      return session;
    },

    async registerVersion(cmd): Promise<RegisterResult> {
      const outcome = await withTenantRpc(
        deps.context,
        "register_source_version_v1",
        {
          p_upload_session_id: cmd.uploadId,
          p_content_hash: cmd.contentHash,
          p_size_bytes: cmd.sizeBytes,
          p_media_type: cmd.mediaType,
        },
        deps.accessToken,
        deps.rpc,
      );
      if (!outcome.ok) {
        if (outcome.kind === "tenancy") return { status: "refused", reason: "not_publishable" };
        throw new Error("register_source_version_v1 unavailable");
      }
      const rows = asRows(outcome.data);
      if (rows.length === 0) return { status: "refused", reason: "session_not_found" };
      const parsed = RegisterRow.safeParse(rows[0]);
      if (!parsed.success) {
        // The RPC raises with a fixed message for closed/expired/etc.; PostgREST may surface that
        // as backend_failure. When we get a row that fails the shape, refuse generically.
        return { status: "refused", reason: "session_closed" };
      }
      return {
        status: "ok",
        sourceId: parsed.data.o_source_id,
        sourceVersionId: parsed.data.o_source_version_id,
        state: "received",
        alreadyUploaded: parsed.data.o_already_uploaded,
      };
    },

    async recordOutcome(cmd): Promise<void> {
      const outcome = await withTenantRpc(
        deps.context,
        "record_upload_outcome_v1",
        {
          p_upload_session_id: cmd.uploadId,
          p_state: cmd.state,
          p_reason_code: cmd.reason,
        },
        deps.accessToken,
        deps.rpc,
      );
      if (!outcome.ok) throw new Error("record_upload_outcome_v1 unavailable");
    },
  };
}
