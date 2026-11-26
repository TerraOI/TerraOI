import { createJobApi, type JobDbBinding } from "./job-db";
import type { JobApiPort } from "./ocr-pull";

/**
 * Wiring seam for `src/app/api/jobs/*` (FAQ-0005). `JOB_DB` is a Hyperdrive binding the owner
 * attaches under env.staging (T-004 §20.8 / ADR-0005 §9) — never a connection string in this file.
 */
export type JobApiEnv = {
  JOB_DB?: JobDbBinding;
};

export function jobApiFromEnv(env: JobApiEnv): JobApiPort | null {
  return createJobApi({ binding: env.JOB_DB ?? null });
}
