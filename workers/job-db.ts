import { createHash } from "node:crypto";
import postgres from "postgres";

import type { DataClass } from "@/contracts/data-class";
import type { IngestionStage, JobExecutor } from "@/contracts/ingestion-job";

import type {
  AbortOutcome,
  AbortReason,
  ArtifactInput,
  CompleteOutcome,
  JobApiPort,
  LeaseRow,
  ObjectRefOutcome,
  RenewOutcome,
  RetargetOutcome,
  RetargetReason,
} from "./ocr-pull";

/**
 * Hyperdrive-backed `JobApiPort` for `toi_job_api` over `JOB_DB` (ADR-0005 §6, #134; T-211 PR-3a).
 *
 * Mirrors the SESSION_DB pattern: one short-lived `postgres` client per call, `prepare: false`,
 * `max: 1`, and `null` when the binding is missing so callers answer honest unavailable. The
 * presented worker token is hashed (SHA-256 hex) before any SQL — the compares match
 * `worker_credentials.token_hash` only (`scripts/worker-credential.mjs`).
 */

export type JobDbBinding = { connectionString: string };

export type JobSql = {
  <T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  end(options?: { timeout?: number }): Promise<void>;
};

export type JobDbDeps = {
  openSql?: () => JobSql;
  binding?: JobDbBinding | null;
};

function digestOf(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

/** SHA-256 hex of a presented worker credential — what crosses the #170 binding hop. */
export function digestWorkerCredential(credential: string): string {
  return digestOf(credential);
}

function openFromBinding(binding: JobDbBinding): JobSql {
  return postgres(binding.connectionString, { prepare: false, max: 1 }) as unknown as JobSql;
}

function isPgCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

function artifactsToSql(artifacts: readonly ArtifactInput[]): unknown {
  return artifacts.map((artifact) => {
    const row: Record<string, unknown> = {
      artifact_index: artifact.artifactIndex,
      body_text: artifact.bodyText,
    };
    if (artifact.locator !== undefined) row.locator = artifact.locator;
    if (artifact.confidence !== undefined) row.confidence = artifact.confidence;
    if (artifact.notes !== undefined) row.notes = artifact.notes;
    return row;
  });
}

function expiresAtIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function asStage(value: unknown): IngestionStage | null {
  return value === "validate" || value === "extract" || value === "index" || value === "publish"
    ? value
    : null;
}

function asExecutor(value: unknown): JobExecutor | null {
  return value === "cloud_worker" || value === "local_box" ? value : null;
}

function asDataClass(value: unknown): DataClass | null {
  return value === "public" || value === "internal" || value === "client_confidential" || value === "restricted"
    ? value
    : null;
}

function mapLeaseRow(row: Record<string, unknown>): LeaseRow | null {
  if (row.o_found !== true) return null;
  const stage = asStage(row.o_stage);
  const executor = asExecutor(row.o_executor);
  const dataClass = asDataClass(row.o_data_class);
  if (
    typeof row.o_job_id !== "string" ||
    typeof row.o_organisation_id !== "string" ||
    typeof row.o_source_version_id !== "string" ||
    typeof row.o_parser_generation !== "string" ||
    typeof row.o_lease_token !== "string" ||
    typeof row.o_index_generation !== "number" ||
    typeof row.o_fence !== "number" ||
    typeof row.o_attempt !== "number" ||
    stage === null ||
    executor === null ||
    dataClass === null
  ) {
    return null;
  }
  return {
    jobId: row.o_job_id,
    organisationId: row.o_organisation_id,
    sourceVersionId: row.o_source_version_id,
    stage,
    executor,
    parserGeneration: row.o_parser_generation,
    indexGeneration: row.o_index_generation,
    dataClass,
    leaseToken: row.o_lease_token,
    fence: row.o_fence,
    attempt: row.o_attempt,
  };
}

/**
 * Builds the port. Returns `null` when `JOB_DB` is unbound — honest unavailable for the HTTP
 * surface and for the cloud worker loop (SESSION_DB precedent).
 */
export function createJobApi(deps: JobDbDeps): JobApiPort | null {
  const open: (() => JobSql) | null =
    deps.openSql ?? (deps.binding ? () => openFromBinding(deps.binding as JobDbBinding) : null);
  if (open === null) return null;
  const openSql = open;

  async function withSql<T>(run: (sql: JobSql) => Promise<T>): Promise<T> {
    const sql = openSql();
    try {
      return await run(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  return {
    async lease({ credential, stage, leaseSeconds }) {
      const tokenHash = digestOf(credential);
      const rows = await withSql(async (sql) =>
        sql`
          select o_found, o_job_id, o_organisation_id, o_source_version_id, o_stage, o_executor,
                 o_parser_generation, o_index_generation, o_data_class, o_lease_token, o_fence, o_attempt
            from job_api.lease_parse_job_v1(${tokenHash}, ${stage}, ${leaseSeconds})
        `,
      );
      const row = rows[0];
      if (!row) return null;
      return mapLeaseRow(row);
    },

    async renew({ credential, jobId, leaseToken, fence, leaseSeconds }) {
      const tokenHash = digestOf(credential);
      const rows = await withSql(async (sql) =>
        sql<{ o_outcome: string; o_expires_at: Date | string | null; o_fence: number | null }>`
          select o_outcome, o_expires_at, o_fence
            from job_api.renew_parse_lease_v1(
              ${tokenHash}, ${jobId}::uuid, ${leaseToken}, ${fence}, ${leaseSeconds}
            )
        `,
      );
      const row = rows[0];
      if (!row || row.o_outcome !== "renewed") return { outcome: "refused" };
      const expiresAt = expiresAtIso(row.o_expires_at);
      if (expiresAt === null || typeof row.o_fence !== "number") return { outcome: "refused" };
      return { outcome: "renewed", expiresAt, fence: row.o_fence } satisfies RenewOutcome;
    },

    async objectRefForLease({ credential, jobId, leaseToken, fence }) {
      const tokenHash = digestOf(credential);
      const rows = await withSql(async (sql) =>
        sql`
          select o_found, o_object_ref, o_data_class, o_executor
            from job_api.object_ref_for_lease_v1(
              ${tokenHash}, ${jobId}::uuid, ${leaseToken}, ${fence}
            )
        `,
      );
      const row = rows[0];
      if (!row || row.o_found !== true) return { found: false } satisfies ObjectRefOutcome;
      const dataClass = asDataClass(row.o_data_class);
      const executor = asExecutor(row.o_executor);
      if (typeof row.o_object_ref !== "string" || dataClass === null || executor === null) {
        return { found: false };
      }
      return { found: true, objectRef: row.o_object_ref, dataClass, executor };
    },

    async complete(args) {
      const tokenHash = digestOf(args.credential);
      const artifacts = artifactsToSql(args.artifacts);
      const notes = [...args.notes];
      try {
        const rows = await withSql(async (sql) =>
          sql<{ o_outcome: string; o_artifact_count: number | null }>`
            select o_outcome, o_artifact_count
              from job_api.complete_parse_job_v1(
                ${tokenHash},
                ${args.jobId}::uuid,
                ${args.leaseToken},
                ${args.fence},
                ${args.sourceVersionId}::uuid,
                ${args.stage},
                ${args.indexGeneration},
                ${artifacts},
                ${notes},
                ${args.confidence}
              )
          `,
        );
        const row = rows[0];
        if (!row) return { outcome: "refused" } satisfies CompleteOutcome;
        if (row.o_outcome === "completed" && typeof row.o_artifact_count === "number") {
          return { outcome: "completed", artifactCount: row.o_artifact_count };
        }
        if (row.o_outcome === "already_completed" && typeof row.o_artifact_count === "number") {
          return { outcome: "already_completed", artifactCount: row.o_artifact_count };
        }
        return { outcome: "refused" };
      } catch (err) {
        if (isPgCode(err, "42501")) return { outcome: "refused" };
        throw err;
      }
    },

    async abort({ credential, jobId, leaseToken, fence, reason }: {
      credential: string;
      jobId: string;
      leaseToken: string;
      fence: number;
      reason: AbortReason;
    }) {
      const tokenHash = digestOf(credential);
      const rows = await withSql(async (sql) =>
        sql<{ o_outcome: string }>`
          select o_outcome
            from job_api.abort_parse_job_v1(
              ${tokenHash}, ${jobId}::uuid, ${leaseToken}, ${fence}, ${reason}
            )
        `,
      );
      const row = rows[0];
      if (!row || row.o_outcome !== "aborted") return { outcome: "refused" } satisfies AbortOutcome;
      return { outcome: "aborted" };
    },

    async retarget({ credential, jobId, leaseToken, fence, reason }: {
      credential: string;
      jobId: string;
      leaseToken: string;
      fence: number;
      reason: RetargetReason;
    }) {
      const tokenHash = digestOf(credential);
      const rows = await withSql(async (sql) =>
        sql<{ o_outcome: string }>`
          select o_outcome
            from job_api.retarget_extract_job_v1(
              ${tokenHash}, ${jobId}::uuid, ${leaseToken}, ${fence}, ${reason}
            )
        `,
      );
      const row = rows[0];
      if (!row || row.o_outcome !== "retargeted") return { outcome: "refused" } satisfies RetargetOutcome;
      return { outcome: "retargeted" };
    },
  };
}

/**
 * Lease compare using a credential **hash** already computed by the app Worker (#170).
 * The service-binding hop must not carry the raw token; this is the only SQL entry that
 * accepts the digest as-is.
 */
export async function lookupObjectRefByTokenHash(
  deps: JobDbDeps,
  args: { tokenHash: string; jobId: string; leaseToken: string; fence: number },
): Promise<ObjectRefOutcome> {
  const open: (() => JobSql) | null =
    deps.openSql ?? (deps.binding ? () => openFromBinding(deps.binding as JobDbBinding) : null);
  if (open === null) return { found: false };

  const sql = open();
  try {
    const rows = await sql`
      select o_found, o_object_ref, o_data_class, o_executor
        from job_api.object_ref_for_lease_v1(
          ${args.tokenHash}, ${args.jobId}::uuid, ${args.leaseToken}, ${args.fence}
        )
    `;
    const row = rows[0];
    if (!row || row.o_found !== true) return { found: false };
    const dataClass = asDataClass(row.o_data_class);
    const executor = asExecutor(row.o_executor);
    if (typeof row.o_object_ref !== "string" || dataClass === null || executor === null) {
      return { found: false };
    }
    return { found: true, objectRef: row.o_object_ref, dataClass, executor };
  } catch {
    return { found: false };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
