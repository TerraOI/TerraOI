import { getCloudflareContext } from "@opennextjs/cloudflare";

import { jobApiFromEnv, type JobApiEnv } from "../../../../../workers/job-adapters";
import { handleJobLease, jobApiUnavailableResponse } from "../../../../../workers/job-api-http";

// Lane 2 HTTP surface (FAQ-0005, #152): box leases one extract job. Logic lives in workers/;
// this file only binds Hyperdrive and delegates.
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
  return handleJobLease(request, api);
}
