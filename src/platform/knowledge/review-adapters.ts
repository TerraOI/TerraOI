import type { ReviewDeps } from "./review-handlers";
import { SAFE_REVIEW_MESSAGES } from "./review-handlers";

/**
 * Wiring seam for the review routes (FAQ-0005).
 *
 * Nothing is wired yet, deliberately. The review RPCs need the signed-in user's access token so
 * `withTenantRpc` dials PostgREST as that user (FAQ-0011 / ADR-0003 §7). How a Worker carries that
 * verified identity is open supervisor decision #37 — the same seam uploads wait on. Writing an
 * identity read from a header here would pre-empt it, so `reviewDeps()` stays null and the routes
 * answer 503.
 *
 * When #37 is decided, the change is additive: a `resolveContext` + `accessToken` pair and a
 * `createReviewRpcClient` appear in this file, and no handler, route or test changes.
 */
export function reviewDeps(): ReviewDeps | null {
  return null;
}

export function reviewUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "review_unavailable", message: SAFE_REVIEW_MESSAGES.review_unavailable },
    }),
    {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    },
  );
}
