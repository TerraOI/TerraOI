import { afterEach, describe, expect, it, vi } from "vitest";

import { POSTMARK_ENDPOINT_BASE, createPostmarkTransport, type FetchImpl } from "./postmark-adapter";
import { sendEmail, type EmailMessage } from "./email";

/**
 * The Postmark adapter, against the contract in
 * https://postmarkapp.com/developer/api/email-api and
 * https://postmarkapp.com/developer/api/overview (endpoint URL, authentication, HTTP response codes,
 * API error codes). Field names and the `X-Postmark-Server-Token` header are the provider's, so a
 * reviewer can diff this file against the documentation.
 *
 * A fake `fetch` records the request; the real-socket cases are in `postmark-loopback.test.ts`
 * (COORDINATION §6a: a security claim about what crossed the wire needs the loopback harness).
 */

// An HTTP header value must be Latin-1, so this fixture credential is plain ASCII (a typographic
// ellipsis here makes Node reject the request before it is sent).
const TOKEN = ["synthetic", "provider", "token"].join("-");
type FetchCall = { url: string; init: RequestInit };
const FROM = "no-reply@mail.terraoi.app";
const HOST = "company1.terraoi.app";

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: "owner1@company1.test",
    subject: "Sign in to Company1",
    text: `Use this link: https://${HOST}/auth/callback?code=abc123`,
    senderDisplayName: "Company1",
    ...overrides,
  };
}

function transport(options: {
  credential?: () => string | undefined;
  response?: () => Promise<Response> | Response;
  fetchImpl?: FetchImpl;
  endpointBase?: string;
  timeoutMs?: number;
}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchImpl =
    options.fetchImpl ??
    (async (url, init) => {
      calls.push({ url, init });
      return (await options.response?.()) ?? new Response(null, { status: 500 });
    });
  const adapter = createPostmarkTransport({
    credential: options.credential ?? (() => TOKEN),
    fromAddress: FROM,
    sendingDomain: "mail.terraoi.app",
    tenantHost: HOST,
    endpointBase: options.endpointBase,
    timeoutMs: options.timeoutMs,
    fetchImpl,
  });
  return { calls, adapter };
}

const okAck = (messageId = "0a129aee-e1cd-480d-b08d-4f48548ff48d") =>
  async () =>
    Response.json({ To: "owner1@company1.test", SubmittedAt: "2026-11-09T12:00:00Z", MessageID: messageId, ErrorCode: 0, Message: "OK" });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createPostmarkTransport — the documented request shape", () => {
  it("posts to /email on the documented endpoint with the server-token header", async () => {
    const { calls, adapter } = transport({ response: okAck() });
    const result = await sendEmail(message(), adapter);

    expect(result).toEqual({ status: "sent", providerMessageId: "0a129aee-e1cd-480d-b08d-4f48548ff48d" });
    expect(calls).toHaveLength(1);
    const call = calls[0] as FetchCall;
    expect(call.url).toBe(`${POSTMARK_ENDPOINT_BASE}/email`);
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    // The credential is on the wire — that is the contract; what must never happen is it appearing in
    // a returned value, a thrown error or a log line (see the leak cases below).
    expect(headers.get("x-postmark-server-token")).toBe(TOKEN);

    const body = JSON.parse(String(call.init.body)) as Record<string, string>;
    expect(body.From).toBe(`Company1 <${FROM}>`);
    expect(body.To).toBe("owner1@company1.test");
    expect(body.Subject).toBe("Sign in to Company1");
    expect(body.TextBody).toContain(`https://${HOST}/auth/callback`);
    // §64 keeps every TerraOI message on the transactional stream.
    expect(body.MessageStream).toBe("outbound");
  });

  it("sends ReplyTo and HtmlBody only when the message has them", async () => {
    const { calls, adapter } = transport({ response: okAck() });
    await sendEmail(message({ html: `<a href="https://${HOST}/auth/callback">x</a>`, replyTo: "support@terraoi.app" }), adapter);
    const body = JSON.parse(String((calls[0] as FetchCall).init.body)) as Record<string, string>;
    expect(body.HtmlBody).toContain("<a href=");
    expect(body.ReplyTo).toBe("support@terraoi.app");

    const bare = transport({ response: okAck() });
    await sendEmail(message(), bare.adapter);
    const bareBody = JSON.parse(String((bare.calls[0] as FetchCall).init.body)) as Record<string, string>;
    expect(bareBody.HtmlBody).toBeUndefined();
    expect(bareBody.ReplyTo).toBeUndefined();
  });

  it("ignores a caller endpoint override in a production runtime: the documented host is the only one", async () => {
    const { calls, adapter } = transport({ response: okAck(), endpointBase: "http://127.0.0.1:1" });
    vi.stubEnv("NODE_ENV", "production");
    await sendEmail(message(), adapter);
    expect((calls[0] as FetchCall).url).toBe(`${POSTMARK_ENDPOINT_BASE}/email`);
  });

  it("honours a loopback override only outside a production runtime, and only for a loopback host over http", async () => {
    const { calls, adapter } = transport({ response: okAck(), endpointBase: "http://127.0.0.1:4321" });
    await sendEmail(message(), adapter);
    expect((calls[0] as FetchCall).url).toBe("http://127.0.0.1:4321/email");

    const httpsOverride = transport({ response: okAck(), endpointBase: "https://proxy.test.invalid" });
    await sendEmail(message(), httpsOverride.adapter);
    expect((httpsOverride.calls[0] as FetchCall).url).toBe("https://proxy.test.invalid/email");

    // A plain-http non-loopback base would put a credential on the wire in the clear: refused, and the
    // adapter falls back to the documented host rather than sending anything to it.
    const unsafe = transport({ response: okAck(), endpointBase: "http://collector.test.invalid" });
    await sendEmail(message(), unsafe.adapter);
    expect((unsafe.calls[0] as FetchCall).url).toBe(`${POSTMARK_ENDPOINT_BASE}/email`);
  });
});

describe("createPostmarkTransport — the credential is read per call (the gateway's Workers AI pattern)", () => {
  it("a rotated secret is used by the next call, so a factory-time read cannot freeze it", async () => {
    let token: string | undefined = undefined;
    const { calls, adapter } = transport({ credential: () => token, response: okAck() });

    expect(await sendEmail(message(), adapter)).toEqual({ status: "unavailable" });
    expect(calls).toHaveLength(0);

    token = TOKEN;
    expect((await sendEmail(message(), adapter)).status).toBe("sent");
    expect(new Headers((calls[0] as FetchCall).init.headers).get("x-postmark-server-token")).toBe(TOKEN);

    token = "synthetic-rotated-token";
    await sendEmail(message(), adapter);
    expect(new Headers((calls[1] as FetchCall).init.headers).get("x-postmark-server-token")).toBe("synthetic-rotated-token");
  });

  it("no credential means no request at all", async () => {
    const { calls, adapter } = transport({ credential: () => undefined, response: okAck() });
    expect(await sendEmail(message(), adapter)).toEqual({ status: "unavailable" });
    expect(calls).toHaveLength(0);
  });
});

describe("createPostmarkTransport — response classification, with no provider text escaping", () => {
  const cases: Array<{ label: string; response: () => Response; expected: { status: "unavailable" } | { status: "rejected"; reason: string } }> = [
    { label: "401 bad token", response: () => Response.json({ ErrorCode: 10, Message: "Request does not contain a valid Server or Account token." }, { status: 401 }), expected: { status: "rejected", reason: "not_configured" } },
    { label: "422 invalid field", response: () => Response.json({ ErrorCode: 403, Message: "Invalid request field(s): 'From'." }, { status: 422 }), expected: { status: "rejected", reason: "invalid_message" } },
    { label: "422 inactive recipient", response: () => Response.json({ ErrorCode: 406, Message: "You tried to send to a recipient that has been marked as inactive." }, { status: 422 }), expected: { status: "rejected", reason: "invalid_recipient" } },
    { label: "413 too large", response: () => Response.json({ ErrorCode: 0, Message: "too large" }, { status: 413 }), expected: { status: "rejected", reason: "too_large" } },
    { label: "429 rate limited", response: () => Response.json({ ErrorCode: 0, Message: "slow down" }, { status: 429 }), expected: { status: "rejected", reason: "rate_limited" } },
    { label: "415 media type", response: () => new Response(null, { status: 415 }), expected: { status: "rejected", reason: "provider" } },
    { label: "404 unknown", response: () => new Response(null, { status: 404 }), expected: { status: "rejected", reason: "provider" } },
    { label: "500 server error", response: () => Response.json({ ErrorCode: 101, Message: "You encountered an error that shouldn't have occurred." }, { status: 500 }), expected: { status: "unavailable" } },
    { label: "503 maintenance", response: () => Response.json({ ErrorCode: 100, Message: "The Postmark API is offline for maintenance." }, { status: 503 }), expected: { status: "unavailable" } },
    { label: "200 without an ack", response: () => Response.json({ ErrorCode: 0, Message: "OK" }), expected: { status: "unavailable" } },
    { label: "200 that is not an error-free ack", response: () => Response.json({ MessageID: "m-1", ErrorCode: 300, Message: "Send validation" }), expected: { status: "unavailable" } },
    { label: "a body that is not JSON at all", response: () => new Response("<html>gateway error</html>", { status: 502, headers: { "content-type": "text/html" } }), expected: { status: "unavailable" } },
  ];

  for (const { label, response, expected } of cases) {
    it(`${label} → ${expected.status}${"reason" in expected ? ` (${expected.reason})` : ""}`, async () => {
      const { adapter } = transport({ response });
      expect(await sendEmail(message(), adapter)).toEqual(expected);
    });
  }

  it("a provider error body that echoes the credential leaks it nowhere: not in the result, not in a log", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { adapter } = transport({
        response: () =>
          Response.json(
            { ErrorCode: 403, Message: `Invalid request field(s). Token ${TOKEN} was rejected for ${FROM}.` },
            { status: 422 },
          ),
      });
      const result = await sendEmail(message(), adapter);
      expect(result).toEqual({ status: "rejected", reason: "invalid_message" });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain("Invalid request");
      expect(JSON.stringify(result)).not.toContain(FROM);
      const logged = errors.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain("Invalid request");
      expect(logged).toContain("email");
    } finally {
      errors.mockRestore();
    }
  });

  it("a timeout is unavailable, and the request was cancelled rather than left hanging", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { adapter } = transport({
      timeoutMs: 60,
      fetchImpl: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal ?? undefined;
          signals.push(signal);
          const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted) abort();
          signal?.addEventListener("abort", abort);
        }),
    });
    const started = Date.now();
    expect(await sendEmail(message(), adapter)).toEqual({ status: "unavailable" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("a transport-level throw is unavailable and its message is not returned", async () => {
    const { adapter } = transport({
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED with token ${TOKEN}`);
      },
    });
    const result = await sendEmail(message(), adapter);
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });
});
