import { getCloudflareContext } from "@opennextjs/cloudflare";

import { objectUrlMintFromEnv, type JobApiEnv } from "../../../../../workers/job-adapters";
import { handleJobObjectUrl, jobApiUnavailableResponse } from "../../../../../workers/job-api-http";

// Lane 2 HTTP surface (FAQ-0005, #152/#170): box asks for a short-lived object URL.
// Signing lives on the workers/ deployment; this route only hashes the credential and
// forwards { tokenHash, jobId, leaseToken, fence } over OBJECT_URL_MINT.
export const dynamic = "force-dynamic";

function jobEnv(): JobApiEnv {
  try {
    return getCloudflareContext().env as JobApiEnv;
  } catch {
    return {};
  }
}

export function POST(request: Request): Promise<Response> {
  const mint = objectUrlMintFromEnv(jobEnv());
  if (mint === null) return Promise.resolve(jobApiUnavailableResponse());
  return handleJobObjectUrl(request, mint);
}
