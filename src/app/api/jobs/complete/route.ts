import { getCloudflareContext } from "@opennextjs/cloudflare";

import { jobApiFromEnv, type JobApiEnv } from "../../../../../workers/job-adapters";
import { handleJobComplete, jobApiUnavailableResponse } from "../../../../../workers/job-api-http";

export const dynamic = "force-dynamic";

function jobEnv(): JobApiEnv {
  try {
    return getCloudflareContext().env as JobApiEnv;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  const api = jobApiFromEnv(jobEnv());
  if (api === null) return Promise.resolve(jobApiUnavailableResponse());
  return handleJobComplete(request, api);
}
