import type { UploadDeps } from "./upload-session";
import { SAFE_UPLOAD_MESSAGES } from "./upload-session";

/**
 * Wiring seam for the upload routes (FAQ-0005: the route file is the auth boundary, so it lives in
 * Lane 2 next to the handler it delegates to).
 *
 * Nothing is wired yet, deliberately. The two adapters `UploadDeps` needs are open supervisor
 * decisions: #37 (how a Worker carries the verified employee identity into Postgres so the scoped
 * RPC sees `auth.uid()`) and #38 (which bucket and which credential own private knowledge objects
 * and the upload grant). Writing either one here would pre-empt them — an identity read from a
 * header, or a service-role key in a route — so `uploadDeps()` stays null and the routes answer 503.
 *
 * When those issues are decided, the change is additive: a Postgres `UploadStore` implementing the
 * scoped RPCs (`begin_upload_session_v1`, `register_source_version_v1`,
 * `record_upload_outcome_v1`) and a storage `ObjectStore` appear in this file, and no handler,
 * route or test changes.
 */
export function uploadDeps(): UploadDeps | null {
  return null;
}

export function uploadUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "storage_unavailable", message: SAFE_UPLOAD_MESSAGES.storage_unavailable } }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
