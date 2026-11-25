import { IngestionJobPayload } from "@/contracts/ingestion-job";
import type { DataClass } from "@/contracts/data-class";

import type {
  AbortOutcome,
  AbortReason,
  LeaseHolder,
  LeaseRow,
  RenewOutcome,
} from "./ocr-pull";
import { DEFAULT_LEASE_SECONDS, DEFAULT_MAX_JOBS_PER_INVOCATION } from "./ocr-pull";

/**
 * Cloud **publish-stage** consumer (T-113 handoff): lease `publish` → `job_api.publish_version_v1`.
 *
 * Skeleton auto-publish only (plan §7.2 steps 7–8, F13). Policy-gated employee publish, review
 * queue, and revoke stay **T-213**. Outbox drain (`index_succeeded` → enqueue publish) lives in
 * `dispatch_outbox_v1`; this loop only consumes the queued stage.
 *
 * Mirrors `index-pull.ts` discipline: no listener, tenant only from the leased job row, closed
 * event vocabulary, fail closed without a credential. `publish_version_v1` itself is owned by
 * #219 on the merge train — this module calls it under the lease compare and does not vendor SQL.
 */

export type { LeaseRow, LeaseHolder, RenewOutcome, AbortOutcome };

/** Closed answers from `job_api.publish_version_v1` (#219). */
export type PublishVersionOutcome =
  | {
      outcome: "published";
      sourceId: string;
      sourceVersionId: string;
      previousVersionId: string | null;
      publishedAt: string;
      eventId: string | null;
    }
  | {
      outcome: "already_published";
      sourceId: string;
      sourceVersionId: string;
      previousVersionId: string | null;
    }
  | { outcome: "refused" };

/** @deprecated Prefer `PublishVersionOutcome` — kept for call-site clarity in unit tests. */
export type PublishOutcome = PublishVersionOutcome;

/**
 * Job-API surface the publish loop needs. `lease` is always `stage: "publish"`.
 * Adapter hashes the credential before SQL (#134).
 */
export interface PublishJobApiPort {
  lease(args: {
    credential: string;
    stage: "publish";
    leaseSeconds: number;
  }): Promise<LeaseRow | null>;
  renew(args: LeaseHolder & { credential: string; leaseSeconds: number }): Promise<RenewOutcome>;
  abort(args: LeaseHolder & { credential: string; reason: AbortReason }): Promise<AbortOutcome>;
  publishVersion(
    args: LeaseHolder & {
      credential: string;
      sourceVersionId: string;
      indexGeneration: number;
    },
  ): Promise<PublishVersionOutcome>;
}

export type PublishWorkerEvent =
  | { kind: "credential_unavailable" }
  | { kind: "no_work" }
  | { kind: "leased"; jobId: string; attempt: number; dataClass: DataClass }
  | { kind: "lease_row_rejected"; jobId: string }
  | { kind: "lease_lost"; jobId: string }
  | { kind: "mutation_refused"; jobId: string; call: "publishVersion" | "abort" }
  | { kind: "published"; jobId: string; sourceVersionId: string }
  | { kind: "already_published"; jobId: string; sourceVersionId: string }
  | { kind: "aborted"; jobId: string; reason: AbortReason };

export type PublishIterationOutcome =
  | { action: "credential_missing" }
  | { action: "no_work" }
  | { action: "lease_row_rejected" }
  | { action: "lease_lost" }
  | { action: "published"; sourceVersionId: string }
  | { action: "already_published"; sourceVersionId: string }
  | { action: "aborted"; reason: AbortReason }
  | { action: "refused" };

export interface PublishWorkerDeps {
  jobApi: PublishJobApiPort;
  credential: () => string | undefined;
  leaseSeconds: number;
  log: (event: PublishWorkerEvent) => void;
  now: () => number;
}

export function createPublishWorkerDeps(options: {
  jobApi: PublishJobApiPort;
  credential?: () => string | undefined;
  leaseSeconds?: number;
  log?: (event: PublishWorkerEvent) => void;
  now?: () => number;
  /** Env fallback for the worker token when `credential` is omitted. */
  env?: { TOI_WORKER_TOKEN?: string | undefined };
}): PublishWorkerDeps {
  return {
    jobApi: options.jobApi,
    credential: options.credential ?? (() => options.env?.TOI_WORKER_TOKEN),
    leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    log: options.log ?? (() => undefined),
    now: options.now ?? Date.now,
  };
}

/** One publish job, start to finish. Platform refusals become outcomes, not throws. */
export async function runPublishWorkerIteration(
  deps: PublishWorkerDeps,
): Promise<PublishIterationOutcome> {
  const credential = deps.credential();
  if (credential === undefined || credential.length === 0) {
    deps.log({ kind: "credential_unavailable" });
    return { action: "credential_missing" };
  }

  const lease = await deps.jobApi.lease({
    credential,
    stage: "publish",
    leaseSeconds: deps.leaseSeconds,
  });
  if (lease === null) {
    deps.log({ kind: "no_work" });
    return { action: "no_work" };
  }
  deps.log({
    kind: "leased",
    jobId: lease.jobId,
    attempt: lease.attempt,
    dataClass: lease.dataClass,
  });

  if (lease.executor !== "cloud_worker" || lease.stage !== "publish") {
    deps.log({ kind: "lease_row_rejected", jobId: lease.jobId });
    return { action: "lease_row_rejected" };
  }

  const parsed = IngestionJobPayload.safeParse({
    jobId: lease.jobId,
    organisationId: lease.organisationId,
    sourceVersionId: lease.sourceVersionId,
    stage: lease.stage,
    executor: lease.executor,
    dataClass: lease.dataClass,
    parserGeneration: lease.parserGeneration,
    indexGeneration: lease.indexGeneration,
    attempt: lease.attempt,
    leaseToken: lease.leaseToken,
    issuedAt: new Date(deps.now()).toISOString(),
  });
  if (!parsed.success) {
    deps.log({ kind: "lease_row_rejected", jobId: lease.jobId });
    return { action: "lease_row_rejected" };
  }
  const payload = parsed.data;
  const holder: LeaseHolder = {
    jobId: lease.jobId,
    leaseToken: lease.leaseToken,
    fence: lease.fence,
  };

  const renewed = await deps.jobApi.renew({
    credential,
    ...holder,
    leaseSeconds: deps.leaseSeconds,
  });
  if (renewed.outcome !== "renewed") {
    deps.log({ kind: "lease_lost", jobId: holder.jobId });
    return { action: "lease_lost" };
  }

  const published = await deps.jobApi.publishVersion({
    credential,
    ...holder,
    sourceVersionId: payload.sourceVersionId,
    indexGeneration: payload.indexGeneration,
  });

  if (published.outcome === "published") {
    deps.log({
      kind: "published",
      jobId: holder.jobId,
      sourceVersionId: published.sourceVersionId,
    });
    return { action: "published", sourceVersionId: published.sourceVersionId };
  }
  if (published.outcome === "already_published") {
    deps.log({
      kind: "already_published",
      jobId: holder.jobId,
      sourceVersionId: published.sourceVersionId,
    });
    return { action: "already_published", sourceVersionId: published.sourceVersionId };
  }

  deps.log({ kind: "mutation_refused", jobId: holder.jobId, call: "publishVersion" });
  const stillHeld = await deps.jobApi.renew({
    credential,
    ...holder,
    leaseSeconds: deps.leaseSeconds,
  });
  if (stillHeld.outcome !== "renewed") {
    deps.log({ kind: "lease_lost", jobId: holder.jobId });
    return { action: "lease_lost" };
  }

  // Closed refuse on a live lease: parent revoked / index incomplete / clearance — abort so
  // the job does not sit leased forever. Policy-gated employee publish stays T-213.
  const reason: AbortReason = "source_revoked";
  const aborted = await deps.jobApi.abort({ credential, ...holder, reason });
  if (aborted.outcome === "aborted") {
    deps.log({ kind: "aborted", jobId: holder.jobId, reason });
    return { action: "aborted", reason };
  }
  deps.log({ kind: "mutation_refused", jobId: holder.jobId, call: "abort" });
  return { action: "refused" };
}

export async function runPublishWorkerPull(
  deps: PublishWorkerDeps,
  options: { maxJobs?: number } = {},
): Promise<PublishIterationOutcome[]> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS_PER_INVOCATION;
  const outcomes: PublishIterationOutcome[] = [];
  for (let taken = 0; taken < maxJobs; taken += 1) {
    const outcome = await runPublishWorkerIteration(deps);
    outcomes.push(outcome);
    if (
      outcome.action === "no_work" ||
      outcome.action === "credential_missing" ||
      outcome.action === "lease_row_rejected" ||
      outcome.action === "lease_lost"
    ) {
      break;
    }
  }
  return outcomes;
}
