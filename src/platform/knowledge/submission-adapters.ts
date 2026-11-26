import type { SubmissionDeps } from "./submission-handlers";
import { SAFE_SUBMISSION_MESSAGES } from "./submission-handlers";

/**
 * Wiring seam for the submissions routes (FAQ-0005).
 *
 * Nothing is wired yet, deliberately. The F15 RPCs need the signed-in user's access token so
 * `withTenantRpc` dials PostgREST as that user (FAQ-0011 / ADR-0003 §7). How a Worker carries that
 * verified identity is open supervisor decision #37 — the same seam uploads and review wait on.
 * Writing an identity read from a header here would pre-empt it, so `submissionDeps()` stays null
 * and the routes answer 503.
 */
export function submissionDeps(): SubmissionDeps | null {
  return null;
}

export function submissionUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "submissions_unavailable",
        message: SAFE_SUBMISSION_MESSAGES.submissions_unavailable,
      },
    }),
    {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    },
  );
}
