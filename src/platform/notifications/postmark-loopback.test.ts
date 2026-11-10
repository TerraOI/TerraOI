import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createPostmarkTransport } from "./postmark-adapter";
import { sendEmail, type EmailMessage } from "./email";

/**
 * The loopback harness COORDINATION §6a requires for claims about what crossed a socket.
 *
 * A stubbed `fetch` cannot prove the three things that matter here: that the credential is read at
 * call time and actually put on the wire, that a provider's own error words never come back out in a
 * returned value or a log line, and that "no credential" really means **no network attempt**. So
 * these tests drive the adapter's real `fetch` against a plain Node `http` listener on `127.0.0.1`
 * with `listen(0)` — no fixed port, no Docker, no external network — and assert on the bytes the
 * server received and the bytes it sent back.
 */

// Header values are Latin-1: this fixture credential is built from ASCII on purpose, so the harness
// fails on the assertion it means to make and not on an encoding accident.
const TOKEN = ["synthetic", "provider", "token"].join("-");
const FROM = "no-reply@mail.terraoi.app";
const HOST = "company1.terraoi.app";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: "owner1@company1.test",
    subject: "Sign in to Company1",
    text: `Use this link: https://${HOST}/auth/callback?code=abc123`,
    senderDisplayName: "Company1",
    ...overrides,
  };
}

type Scenario = (request: Seen, respond: (init: { status: number; body: string; contentType?: string }) => void) => void;

let server: Server | null = null;
let seen: Seen[] = [];
let scenario: Scenario = () => {
  throw new Error("no scenario set");
};

function startServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const instance = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const request: Seen = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        seen.push(request);
        // `connection: close` is what lets afterEach() close the server without waiting on a
        // keep-alive from undici; the harness must not leak a handle into the next test file.
        res.setHeader("connection", "close");
        scenario(request, ({ status, body, contentType = "application/json" }) => {
          res.writeHead(status, { "content-type": contentType });
          res.end(body);
        });
      });
    });
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => {
      server = instance;
      const address = instance.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function stopServer(): Promise<void> {
  const instance = server;
  server = null;
  if (instance === null) return;
  instance.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    instance.close(() => resolve());
  });
}

let base = "";

beforeEach(async () => {
  seen = [];
  base = await startServer();
});

afterEach(async () => {
  await stopServer();
});

afterAll(async () => {
  // The §6a requirement stated explicitly: whatever a case did to the listener, it is closed here.
  await stopServer();
});

function adapterFor(options: { credential?: () => string | undefined; timeoutMs?: number } = {}) {
  return createPostmarkTransport({
    credential: options.credential ?? (() => TOKEN),
    fromAddress: FROM,
    sendingDomain: "mail.terraoi.app",
    tenantHost: HOST,
    endpointBase: base,
    timeoutMs: options.timeoutMs,
  });
}

describe("the Postmark adapter over a real loopback socket (COORDINATION §6a)", () => {
  it("the request that crosses the wire is the documented Postmark call", async () => {
    scenario = (_request, respond) =>
      respond({
        status: 200,
        body: JSON.stringify({
          To: "owner1@company1.test",
          SubmittedAt: "2026-11-09T12:00:00Z",
          MessageID: "b2f1e0a6-8a3e-4f0a-9e1c-7a2c5d0e4f11",
          ErrorCode: 0,
          Message: "OK",
        }),
      });

    const result = await sendEmail(message({ html: `<a href="https://${HOST}/auth/callback">x</a>` }), adapterFor());
    expect(result).toEqual({ status: "sent", providerMessageId: "b2f1e0a6-8a3e-4f0a-9e1c-7a2c5d0e4f11" });

    expect(seen).toHaveLength(1);
    const request = seen[0] as Seen;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/email");
    expect(request.headers["x-postmark-server-token"]).toBe(TOKEN);
    expect(request.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(request.body) as Record<string, string>;
    expect(body.From).toBe(`Company1 <${FROM}>`);
    expect(body.To).toBe("owner1@company1.test");
    expect(body.Subject).toBe("Sign in to Company1");
    expect(body.HtmlBody).toContain(`https://${HOST}/auth/callback`);
    expect(body.MessageStream).toBe("outbound");

    // The credential belongs on the wire and nowhere else: not in what the caller gets back.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("with no credential the listener is never contacted at all", async () => {
    scenario = (_request, respond) => respond({ status: 200, body: JSON.stringify({ MessageID: "never", ErrorCode: 0 }) });

    expect(await sendEmail(message(), adapterFor({ credential: () => undefined }))).toEqual({ status: "unavailable" });
    expect(seen).toHaveLength(0);
  });

  it("a provider 422 that repeats the credential in its Message leaks it into no result and no log line", async () => {
    scenario = (_request, respond) =>
      respond({
        status: 422,
        body: JSON.stringify({ ErrorCode: 403, Message: `Invalid 'From' field: ${FROM} with token ${TOKEN}` }),
      });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await sendEmail(message(), adapterFor());
      expect(result).toEqual({ status: "rejected", reason: "invalid_message" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(FROM);
      expect(serialized).not.toContain("Invalid");
      const logged = errors.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain("Invalid 'From' field");
      expect(logged).toContain("email");
      expect(seen).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("a provider 500 is unavailable, and the socket shows the attempt really happened", async () => {
    scenario = (_request, respond) =>
      respond({ status: 500, body: JSON.stringify({ ErrorCode: 101, Message: `token ${TOKEN} blew up` }) });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await sendEmail(message(), adapterFor())).toEqual({ status: "unavailable" });
      expect(seen).toHaveLength(1);
      const logged = errors.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain("blew up");
    } finally {
      errors.mockRestore();
    }
  });

  it("a provider that accepts the connection and never answers is unavailable inside the timeout", async () => {
    scenario = () => {
      // Deliberately no `respond`: the connection is open and the response never comes.
    };

    const started = Date.now();
    expect(await sendEmail(message(), adapterFor({ timeoutMs: 250 }))).toEqual({ status: "unavailable" });
    const elapsed = Date.now() - started;
    expect(seen).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("a 200 whose body is not a Postmark ack is unavailable, not a fake success", async () => {
    scenario = (_request, respond) => respond({ status: 200, body: "<html>sent, probably</html>", contentType: "text/html" });
    expect(await sendEmail(message(), adapterFor())).toEqual({ status: "unavailable" });
    expect(seen).toHaveLength(1);
  });
});
