import type { EmailRejectionReason, EmailRequest, EmailTransport, TransportOutcome } from "./email";

/**
 * The one provider adapter (T-105). **Postmark**, Email API:
 *
 *   `POST https://api.postmarkapp.com/email` with `X-Postmark-Server-Token`, `Accept: application/json`
 *   and a JSON body (`From`, `To`, `Subject`, `TextBody`, `HtmlBody`, `ReplyTo`, `MessageStream`);
 *   a successful send answers `200` with `MessageID` and `ErrorCode: 0`
 *   (<https://postmarkapp.com/developer/api/email-api>); the endpoint, the authentication header, the
 *   HTTP response codes and the API error codes are on
 *   <https://postmarkapp.com/developer/api/overview>.
 *
 * Why Postmark, as #64 delegates that choice to this PR:
 *   * it is a transactional-only service, which is the whole of this packet's use, and its default
 *     message stream `outbound` is the transactional one — bulk mail has to be asked for by name;
 *   * its contract is one documented JSON call with a static API token in a header, so the adapter is
 *     plain `fetch` and the repo adds **no npm dependency**, exactly like `gateway/adapters.ts` and the
 *     Claude adapter in #145;
 *   * it answers a machine-readable `ErrorCode` per failure, so a refusal can be mapped onto this
 *     port's closed reason codes without repeating the provider's words (which is what leaks).
 *   * Verified-sending-domain setup is the owner's human step: Postmark account, SPF/DKIM/DMARC for
 *     the TerraOI sending domain, and `wrangler secret put POSTMARK_SERVER_TOKEN` (T-004 §20.8).
 *
 * Swapping vendors is meant to be one file: `EmailTransport` in `email.ts` is the seam, and the port —
 * not this file — is where the sender, the link host and the injection guards live.
 */

export const POSTMARK_ENDPOINT_BASE = "https://api.postmarkapp.com";

/** Postmark's transactional stream. Bulk mail must name a stream deliberately. */
export const POSTMARK_TRANSACTIONAL_STREAM = "outbound";

/** A request of the shape the adapter makes; tests record it instead of performing it. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface PostmarkTransportOptions {
  fromAddress: string;
  sendingDomain: string;
  tenantHost: string;
  /** The `POSTMARK_SERVER_TOKEN` binding, read at call time (see `EmailTransport.credential`). */
  credential: () => string | undefined;
  /** Defaults to the transactional stream. */
  messageStream?: string;
  /** Wall-clock ceiling for the provider call; a provider that goes quiet is `unavailable`. */
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  /**
   * Development/test override for the endpoint base. This is what the loopback harness in
   * `postmark-loopback.test.ts` points at a `127.0.0.1` listener. It is **not** available in a
   * production runtime (see `resolveEndpoint`), so it cannot become a way to redirect a credential.
   */
  endpointBase?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isNonDeployableRuntime(): boolean {
  // Fail closed on an unknown environment: only the two runtimes that are never deployed may redirect
  // the provider endpoint. Workers does not set NODE_ENV, so a production Worker cannot reach this.
  return typeof process !== "undefined" && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");
}

function resolveEndpoint(override: string | undefined): string {
  if (typeof override !== "string" || override.length === 0) return POSTMARK_ENDPOINT_BASE;
  if (!isNonDeployableRuntime()) return POSTMARK_ENDPOINT_BASE;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    return POSTMARK_ENDPOINT_BASE;
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) return POSTMARK_ENDPOINT_BASE;
  if (url.protocol === "https:") return url.origin;
  // Plain http is for loopback only: a credential in the clear to a remote host is not a test fixture.
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return POSTMARK_ENDPOINT_BASE;
}

/**
 * Postmark's documented response codes mapped onto this port's closed codes. Nothing from the response
 * body is copied anywhere: the provider's `Message` is a free-text sentence that can quote an address,
 * a field value, or — in a misconfigured account — a token.
 */
function classifyFailure(status: number, errorCode: unknown): TransportOutcome {
  if (status >= 500) return { ok: false, kind: "unavailable" };
  if (status === 401) return { ok: false, kind: "rejected", reason: "not_configured" };
  if (status === 429) return { ok: false, kind: "rejected", reason: "rate_limited" };
  if (status === 413) return { ok: false, kind: "rejected", reason: "too_large" };
  if (status === 422) {
    // 406 is "recipient marked as inactive"; every other 422 is about the message's fields.
    return { ok: false, kind: "rejected", reason: errorCode === 406 ? "invalid_recipient" : "invalid_message" };
  }
  if (status >= 400) return { ok: false, kind: "rejected", reason: "provider" };
  return { ok: false, kind: "unavailable" };
}

export function createPostmarkTransport(options: PostmarkTransportOptions): EmailTransport {
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((url, init) => (globalThis.fetch as unknown as FetchImpl)(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stream = options.messageStream ?? POSTMARK_TRANSACTIONAL_STREAM;

  return {
    fromAddress: options.fromAddress,
    sendingDomain: options.sendingDomain,
    tenantHost: options.tenantHost,
    // A function on purpose: the caller (`sendEmail`) reads it when it has decided the message is
    // worth sending, and the value is never stored on this object, logged, or returned.
    credential: () => options.credential(),

    async send(request: EmailRequest): Promise<TransportOutcome> {
      const token = options.credential();
      if (typeof token !== "string" || token.length === 0) {
        // No request at all. The loopback suite asserts the listener was never contacted.
        return { ok: false, kind: "unavailable" };
      }

      const base = resolveEndpoint(options.endpointBase);
      const payload: Record<string, string> = {
        From: request.from,
        To: request.to,
        Subject: request.subject,
        TextBody: request.text,
        MessageStream: stream,
      };
      if (request.html !== undefined) payload.HtmlBody = request.html;
      if (request.replyTo !== undefined) payload.ReplyTo = request.replyTo;

      let response: Response;
      try {
        response = await fetchImpl(`${base}/email`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": token,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // A timeout, a DNS failure, a TLS problem, an aborted socket: all one answer, and none of the
        // error's text (which can name the host, the URL, or on some stacks the request headers) is
        // kept. `unavailable` means "we do not know whether it was accepted", so a caller must not
        // tell the user the email went out.
        return { ok: false, kind: "unavailable" };
      }

      let ack: unknown;
      try {
        ack = await response.json();
      } catch {
        ack = undefined;
      }
      const errorCode = (ack as { ErrorCode?: unknown } | undefined)?.ErrorCode;

      if (response.ok) {
        const messageId = (ack as { MessageID?: unknown } | undefined)?.MessageID;
        const cleanAck = errorCode === 0 || errorCode === undefined;
        if (typeof messageId === "string" && messageId.length > 0 && cleanAck) {
          return { ok: true, providerMessageId: messageId };
        }
        // A 200 that is not an accepted send is a provider problem, not a fake success.
        return { ok: false, kind: "unavailable" };
      }

      return classifyFailure(response.status, errorCode);
    },
  };
}

/** The reason codes this adapter can produce, so a reviewer can see the mapping is closed. */
export const POSTMARK_REASONS: readonly EmailRejectionReason[] = [
  "not_configured",
  "rate_limited",
  "too_large",
  "invalid_recipient",
  "invalid_message",
  "provider",
];
