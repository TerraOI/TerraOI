import { createJobApi, type JobDbBinding } from "./job-db";
import type { ObjectUrlMintBinding } from "./job-api-http";
import type { JobApiPort } from "./ocr-pull";

/**
 * Wiring seam for `src/app/api/jobs/*` (FAQ-0005). `JOB_DB` is a Hyperdrive binding the owner
 * attaches under env.staging (T-004 §20.8 / ADR-0005 §9) — never a connection string in this file.
 * `OBJECT_URL_MINT` is the service binding to `workers/` `ObjectUrlMint.mintObjectUrl` (#170).
 */
export type JobApiEnv = {
  JOB_DB?: JobDbBinding;
  OBJECT_URL_MINT?: ObjectUrlMintBinding;
};

export function jobApiFromEnv(env: JobApiEnv): JobApiPort | null {
  return createJobApi({ binding: env.JOB_DB ?? null });
}

export function objectUrlMintFromEnv(env: JobApiEnv): ObjectUrlMintBinding | null {
  return env.OBJECT_URL_MINT ?? null;
}
