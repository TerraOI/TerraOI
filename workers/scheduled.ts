import {
  createJobApi,
  dispatchOutboxEvents,
  type DispatchOutboxResult,
  type JobDbBinding,
} from "./job-db";
import { createCloudExtractor } from "./cloud-extractor";
import {
  createCloudWorkerDeps,
  runCloudWorkerPull,
  type CloudWorkerEnv,
  type ExtractorPort,
  type IterationOutcome,
} from "./ocr-pull";

/**
 * Cron entry for the extraction deployment (#170): `triggers.crons` → `scheduled()` →
 * outbox dispatch (#99) then `runCloudWorkerPull`, bounded by `DEFAULT_MAX_JOBS_PER_INVOCATION`.
 *
 * Outbox dispatch runs whenever `JOB_DB` + `TOI_WORKER_TOKEN` are bound. Pull runs when
 * `resolveCloudExtractor()` returns the T-212-backed port (this cut).
 */

export type ScheduledEnv = CloudWorkerEnv & {
  JOB_DB?: JobDbBinding;
  TOI_WORKER_TOKEN?: string;
};

export type ScheduledDeps = {
  extractor?: ExtractorPort | null;
  fetchImpl?: typeof fetch;
  log?: (event:
    | { kind: "scheduled_skip"; reason: string }
    | { kind: "outbox_dispatch"; result: DispatchOutboxResult }
  ) => void;
  /** Override outbox dispatch in tests; default calls `dispatchOutboxEvents`. */
  dispatchOutbox?: (env: ScheduledEnv) => Promise<DispatchOutboxResult | null | { skipped: string }>;
};

export type ScheduledTickResult = {
  outbox: DispatchOutboxResult | { skipped: string };
  pull: IterationOutcome[] | { skipped: string };
};

/**
 * T-212-backed cloud extractor (#135). Returns a port so cron pull leases extract jobs.
 */
export function resolveCloudExtractor(): ExtractorPort | null {
  return createCloudExtractor();
}

const DEFAULT_OUTBOX_LIMIT = 32;

async function defaultDispatchOutbox(env: ScheduledEnv): Promise<DispatchOutboxResult | null | { skipped: string }> {
  if (env.JOB_DB === undefined) return { skipped: "job_db_unbound" };
  const token = env.TOI_WORKER_TOKEN;
  if (token === undefined || token.length === 0) return { skipped: "worker_token_missing" };
  return dispatchOutboxEvents({ binding: env.JOB_DB }, { credential: token, limit: DEFAULT_OUTBOX_LIMIT });
}

/**
 * One cron tick: drain extract_succeeded → index enqueue, then (if extractor wired) pull.
 */
export async function runScheduledTick(
  env: ScheduledEnv,
  deps: ScheduledDeps = {},
): Promise<ScheduledTickResult> {
  const dispatch = deps.dispatchOutbox ?? defaultDispatchOutbox;
  let outbox: DispatchOutboxResult | { skipped: string };
  try {
    const raw = await dispatch(env);
    if (raw === null) {
      outbox = { skipped: "job_db_unbound" };
    } else {
      outbox = raw;
    }
  } catch {
    outbox = { skipped: "dispatch_refused" };
  }
  if ("processed" in outbox) {
    deps.log?.({ kind: "outbox_dispatch", result: outbox });
  } else {
    deps.log?.({ kind: "scheduled_skip", reason: outbox.skipped });
  }

  const pull = await runScheduledCloudPull(env, deps);
  return { outbox, pull };
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
