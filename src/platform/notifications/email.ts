import { z } from "zod";

import { canonicalEmail } from "@/platform/identity/email";
import { parseHost } from "@/platform/tenancy/host";

/**
 * T-105: the one port transactional email goes through (magic link, invite, password reset, knowledge
 * notification). Plan §4.2, §5.1, §16 (white-label email), §4.1 step 6; the supervisor's ruling on
 * [#64](https://github.com/TerraOI/TerraOI/issues/64):
 *
 *   * **the app sends the email**, Supabase Auth does not — which is what keeps the #37(b) host-only
 *     session design intact;
 *   * one verified **TerraOI sending domain**, and the tenant's display name is the sender *name*
 *     (plan §5.1) — so the From **address** is configuration and is never taken from the caller or
 *     from tenant data;
 *   * links are built by the **tenant host resolver** (plan §4.1 step 6), never from a global site URL;
 *   * no fake success: an unconfigured transport answers the typed `unavailable`.
 *
 * Why the guards live here rather than in each caller: a magic-link email whose link points at another
 * tenant, the apex, or a `workers.dev` alias hands a live credential to a origin that is not the
 * tenant's, and a CR/LF in a single-line header field is a second header. Both are the kind of thing
 * one caller gets wrong eventually. Everything the sign-in and invite flows will pass through this
 * function is validated before any transport is reached, and the credential is not even read until the
 * message is acceptable — so a rejected message cannot cost a provider request.
 *
 * The types stay in this module on purpose: no `src/contracts/` change (the packet forbids it, and
 * `EmailMessage` is a platform port, not a cross-lane contract).
 */

/** Field caps. Generous where the provider is generous, tight where a header line is involved. */
export const EMAIL_LIMITS = {
  subject: 200,
  displayName: 100,
  text: 200_000,
  html: 200_000,
} as const;

/**
 * Closed set of safe codes. A reason never carries provider text, an address, or anything a caller
 * could reflect into a page: the packet asks for `rejected` "with a safe code", and a code that is a
 * member of this list is the only way to say it.
 */
export const EMAIL_REJECTION_REASONS = [
  "recipient", // the address is missing, malformed, or carries header material
  "sender", // the display name or the configured From is wrong: configuration, not content
  "subject",
  "body",
  "link_host", // a link in the message is not on the resolved tenant host
  "malformed", // a field the port does not accept at all
  "too_large",
  "not_configured", // the provider answered, but the deployment credential is not usable
  "rate_limited",
  "invalid_message", // the provider refused this message's fields
  "invalid_recipient", // the provider refused this recipient
  "provider", // any other provider refusal, described no further
] as const;

export type EmailRejectionReason = (typeof EMAIL_REJECTION_REASONS)[number];

export type SendEmailResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "unavailable" }
  | { status: "rejected"; reason: EmailRejectionReason };

/** What a caller may ask for. There is deliberately no From here: the sender is configuration. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  senderDisplayName: string;
  replyTo?: string;
}

/** What a transport receives: the message after this port has validated it, plus the composed sender. */
export interface EmailRequest {
  /** `"Company1 <no-reply@mail.terraoi.app>"` — display name from the caller, address from config. */
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export type TransportOutcome =
  | { ok: true; providerMessageId: string }
  | { ok: false; kind: "unavailable" }
  | { ok: false; kind: "rejected"; reason: EmailRejectionReason };

/**
 * A transport carries the deployment's sender configuration and the **resolved tenant host** this
 * message belongs to. The host is server-side data all the way down: for a route handler it comes from
 * `requestHost(request.url)` (ADR-0006 rule 3), for a page from the proxy-stamped header through
 * `page-host.ts` (ADR-0006 rule 2). This port does not trust it: it re-checks that it is a tenant host
 * and that every link in the message agrees with it.
 */
export interface EmailTransport {
  readonly fromAddress: string;
  readonly sendingDomain: string;
  readonly tenantHost: string;
  /**
   * Read at call time, never captured when the transport is built (the gateway's Workers AI pattern in
   * `src/platform/gateway/adapters.ts`: secret bindings are resolved per request, so a factory-time
   * read freezes a rotated credential for the life of the isolate). Never logged.
   */
  credential(): string | undefined;
  send(request: EmailRequest): Promise<TransportOutcome>;
}

/** Keys that would let a caller choose the sender. Checked case-insensitively. */
const SENDER_KEYS = new Set(["from", "fromaddress", "from_email", "fromemail", "sender", "reply_to_sender"]);

const messageShape = z.strictObject({
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  senderDisplayName: z.string(),
  replyTo: z.string().optional(),
});

// A single-line header field: no CR, no LF, no other control character, and no address punctuation
// that could re-open the field. `\u0000-\u001F` covers CR (13) and LF (10).
const HEADER_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// A display name is a name, not an address and not quoting: `<>` would let a display name smuggle an
// address (`Company1 <attacker@other.example>`), and `"\;:@` are the delimiters RFC 5322 reads.
const DISPLAY_NAME_UNSAFE = /[<>"\\@;:]/;

/** The body is content: line breaks are allowed, everything else in the C0 range is not. */
function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

function bodyIsSafe(body: string): boolean {
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body);
}

function addressOf(address: string): string | null {
  const canonical = canonicalEmail(address);
  return canonical === null ? null : canonical;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? address : address.slice(at + 1);
}

/** Absolute and protocol-relative URLs in a body. A bare domain in prose is not a link. */
const LINK_CANDIDATES = /https?:\/\/[^\s"'<>`)\]}]+|(?<![\w:])\/\/[^\s"'<>`)\]}]+/g;

function linksAreOnTenantHost(text: string, html: string | undefined, tenantHost: string): boolean {
  const expectedOrigin = `https://${tenantHost}`;
  for (const source of [text, html ?? ""]) {
    for (const match of source.matchAll(LINK_CANDIDATES)) {
      const candidate = match[0];
      const absolute = candidate.startsWith("//") ? `https:${candidate}` : candidate;
      let url: URL;
      try {
        url = new URL(absolute);
      } catch {
        // A string that looks like a link and does not parse is not one we will send.
        return false;
      }
      // Origin equality is the whole rule in one comparison: same scheme (https), same host, no port.
      // `http://company1.terraoi.app` and `https://company1.terraoi.app.evil.test` fail it outright.
      if (url.origin !== expectedOrigin) return false;
      // …and the host must also match character for character. `URL` silently lower-cases the host, so
      // origin equality alone would accept `https://Company1.terraoi.app` or a Unicode-look-alike case
      // variant; the resolved tenant host is already lowercase, so an exact prefix is the strict rule.
      const prefix = `https://${tenantHost}`;
      if (!absolute.startsWith(prefix)) return false;
      const remainder = absolute.slice(prefix.length);
      if (remainder.length > 0 && !"/?#".includes(remainder[0] as string)) return false;
    }
  }
  return true;
}

/**
 * The tenant-host link builder (plan §4.1 step 6): the only way a caller should assemble a link that
 * goes out in an email. It returns null rather than a URL for a host that is not a tenant origin, so
 * there is no global site URL to fall back to and no path-smuggling of a host into the second argument.
 */
export function tenantEmailLink(host: string, path: string): string | null {
  const parsedHost = parseHost(host);
  if (!parsedHost.ok || parsedHost.class !== "tenant") return null;
  if (typeof path !== "string" || path.length === 0) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (HEADER_CONTROL_CHARS.test(path) || /\s/.test(path)) return null;
  // A path may carry a query, but not a scheme, an authority, or an escaped newline.
  if (path.includes("://") || path.includes("@") || path.includes("\\")) return null;
  if (/%0d|%0a/i.test(path)) return null;
  if (path.toLowerCase().includes(parsedHost.host.toLowerCase())) return null;

  const link = `https://${parsedHost.host}${path}`;
  try {
    const url = new URL(link);
    if (url.origin !== `https://${parsedHost.host}`) return null;
    if (url.hostname !== parsedHost.host) return null;
  } catch {
    return null;
  }
  return link;
}

function resolveTenantHost(transport: EmailTransport): string | null {
  const parsedHost = parseHost(transport.tenantHost);
  if (!parsedHost.ok || parsedHost.class !== "tenant") return null;
  return parsedHost.host;
}

/**
 * The port. Validation first, then the credential, then the transport — in that order, so a bad
 * message costs nothing and a missing credential sends nothing.
 */
export async function sendEmail(message: EmailMessage, transport: EmailTransport): Promise<SendEmailResult> {
  const reject = (reason: EmailRejectionReason): SendEmailResult => {
    // Fixed marker plus the closed reason code, never the message content: a log line that echoes the
    // subject or the recipient is a second copy of personal data, and one that echoes a provider
    // response is how a credential escapes.
    console.error("email send refused", { step: "email_port", reason });
    return { status: "rejected", reason };
  };

  if (message === null || typeof message !== "object") return reject("malformed");
  for (const key of Object.keys(message)) {
    if (SENDER_KEYS.has(key.toLowerCase())) return reject("sender");
  }
  const parsed = messageShape.safeParse(message);
  if (!parsed.success) return reject("malformed");

  // The transport's own sender configuration, checked on every send rather than assumed at wiring
  // time: the address must exist, be canonical, and live on the one verified sending domain (#64).
  const fromAddress = addressOf(transport.fromAddress ?? "");
  if (fromAddress === null || domainOf(fromAddress) !== (transport.sendingDomain ?? "").toLowerCase()) {
    return reject("sender");
  }
  const tenantHost = resolveTenantHost(transport);
  if (tenantHost === null) return reject("link_host");

  const displayName = parsed.data.senderDisplayName;
  if (
    displayName.trim().length === 0 ||
    displayName.length > EMAIL_LIMITS.displayName ||
    HEADER_CONTROL_CHARS.test(displayName) ||
    DISPLAY_NAME_UNSAFE.test(displayName)
  ) {
    return reject("sender");
  }

  // Recipients are single-line header fields, so any CR or LF is refused before it is canonicalized:
  // trimming would quietly delete a trailing CRLF and leave the second header line behind.
  if (/[\r\n]/.test(parsed.data.to)) return reject("recipient");
  const to = addressOf(parsed.data.to);
  if (to === null) return reject("recipient");

  if (parsed.data.replyTo !== undefined) {
    if (/[\r\n]/.test(parsed.data.replyTo)) return reject("recipient");
    if (addressOf(parsed.data.replyTo) === null) return reject("recipient");
  }

  const subject = parsed.data.subject;
  if (subject.trim().length === 0 || subject.length > EMAIL_LIMITS.subject || HEADER_CONTROL_CHARS.test(subject)) {
    return reject("subject");
  }

  const text = normalizeBody(parsed.data.text);
  const html = parsed.data.html === undefined ? undefined : normalizeBody(parsed.data.html);
  if (text.trim().length === 0 || text.length > EMAIL_LIMITS.text || !bodyIsSafe(text)) return reject("body");
  if (html !== undefined && (html.length === 0 || html.length > EMAIL_LIMITS.html || !bodyIsSafe(html))) return reject("body");

  if (!linksAreOnTenantHost(text, html, tenantHost)) return reject("link_host");

  // Only now is the credential worth reading: the message may be sent, and the transport must not be
  // reached at all without one (the packet's "no network call" requirement, asserted in the tests).
  let credential: string | undefined;
  try {
    credential = transport.credential();
  } catch {
    console.error("email send unavailable", { step: "email_port", reason: "credential_binding" });
    return { status: "unavailable" };
  }
  if (typeof credential !== "string" || credential.length === 0) {
    console.error("email send unavailable", { step: "email_port", reason: "no_credential" });
    return { status: "unavailable" };
  }

  const request: EmailRequest = {
    from: `${displayName} <${fromAddress}>`,
    to,
    subject,
    text,
    ...(html === undefined ? {} : { html }),
    ...(parsed.data.replyTo === undefined ? {} : { replyTo: addressOf(parsed.data.replyTo) as string }),
  };

  let outcome: TransportOutcome;
  try {
    outcome = await transport.send(request);
  } catch {
    // The transport's error text belongs to the transport: it can name a host, a token, or a provider
    // response body. Nothing about it may reach a caller or a log line.
    console.error("email send unavailable", { step: "email_port", reason: "transport_threw" });
    return { status: "unavailable" };
  }

  if (outcome.ok) {
    if (typeof outcome.providerMessageId !== "string" || outcome.providerMessageId.length === 0) {
      console.error("email send unavailable", { step: "email_port", reason: "no_ack" });
      return { status: "unavailable" };
    }
    return { status: "sent", providerMessageId: outcome.providerMessageId };
  }
  if (outcome.kind === "unavailable") {
    console.error("email send unavailable", { step: "email_port", reason: "transport_unavailable" });
    return { status: "unavailable" };
  }
  if (!(EMAIL_REJECTION_REASONS as readonly string[]).includes(outcome.reason)) {
    console.error("email send unavailable", { step: "email_port", reason: "unknown_outcome" });
    return { status: "unavailable" };
  }
  // A provider refusal is logged too: the caller gets a closed code, and the operator needs to see
  // that an email was refused and by which class of failure — with no provider text attached.
  console.error("email send refused", { step: "email_port", reason: outcome.reason });
  return { status: "rejected", reason: outcome.reason };
}
