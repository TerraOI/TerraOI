import { createJobApi, type JobDbBinding } from "./job-db";
import {
  createCloudWorkerDeps,
  runCloudWorkerPull,
  type CloudWorkerEnv,
  type ExtractorPort,
  type IterationOutcome,
} from "./ocr-pull";

/**
 * Cron entry for the extraction deployment (#170): `triggers.crons` → `scheduled()` →
 * `runCloudWorkerPull`, bounded by `DEFAULT_MAX_JOBS_PER_INVOCATION`.
 *
 * The T-212 in-process extractor is not wired on this branch yet. Until
 * `resolveCloudExtractor()` returns a port, the cron is a no-op (no lease, no abort) so a
 * missing extractor cannot burn attempt caps.
 */

export type ScheduledEnv = CloudWorkerEnv & {
  JOB_DB?: JobDbBinding;
  TOI_WORKER_TOKEN?: string;
};

export type ScheduledDeps = {
  extractor?: ExtractorPort | null;
  fetchImpl?: typeof fetch;
  log?: (event: { kind: "scheduled_skip"; reason: string }) => void;
};

/**
 * Hook T-212 replaces: return the cloud `ExtractorPort`, or `null` to keep the cron idle.
 */
export function resolveCloudExtractor(): ExtractorPort | null {
  return null;
}

export async function runScheduledCloudPull(
  env: ScheduledEnv,
  deps: ScheduledDeps = {},
): Promise<IterationOutcome[] | { skipped: string }> {
  const extractor = deps.extractor !== undefined ? deps.extractor : resolveCloudExtractor();
  if (extractor === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "extractor_unwired" });
    return { skipped: "extractor_unwired" };
  }
  if (env.JOB_DB === undefined) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }
  const jobApi = createJobApi({ binding: env.JOB_DB });
  if (jobApi === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }

  const cloudDeps = createCloudWorkerDeps({
    env,
    jobApi,
    extractor,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  return runCloudWorkerPull(cloudDeps);
}
