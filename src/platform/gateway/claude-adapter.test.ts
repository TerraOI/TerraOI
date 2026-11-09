import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createClaudeAdapter,
  type AdapterCallOutcome,
  type AdapterCallRequest,
  type FetchImpl,
} from "./adapters";
import { callModelGateway, type GatewayCallInput } from "./call";
import { CircuitBook } from "./circuit";
import {
  RUN_ID,
  recordingMeter,
  registryOf,
  syntheticContext,
  testConfiguration,
} from "./gateway-fixtures";

/**
 * T-115f: the Claude adapter (plan §12.4 "Model chain", issue #46 ruling). Plain `fetch` against the
 * Anthropic Messages shape — **no SDK**, so the dependency count stays zero and the boundary guard in
 * `provider-boundary.test.ts` (which lists `api.anthropic.com` as a marker allowed only inside this
 * folder) keeps being the rule it claims to be.
 *
 * The evidence split is deliberate:
 *
 * * an injected `fetch` proves the **shape** of the outcome — classes, metering units, truncation;
 * * a loopback listener (COORDINATION.md §6a) proves what actually **crossed a socket**, which is the
 *   only way to test the two things a fake cannot: that the API key on the wire came from the secret
 *   read *during that call*, and that a provider's own error body stops inside the adapter.
 *
 * Every key below is synthetic and lives in a test-only environment variable. The real key is a
 * `wrangler secret` set by the owner (T-004 §20.8); no agent ever handles it, and this file never
 * reads a real credential.
 */

/** A variable *name*. The values written into it are always synthetic markers. */
const ENV_KEY = "TERRAOI_TEST_CLAUDE_KEY";

const CLAUDE_ENDPOINT = { providerKey: "claude", model: "hosted-gamma" } as const;

const ANSWER_BODY = {
  type: "message",
  role: "assistant",
  model: "hosted-gamma",
  content: [{ type: "text", text: "supported" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 41, output_tokens: 11 },
};

function requestFor(overrides: Partial<AdapterCallRequest> = {}): AdapterCallRequest {
  return {
    attemptId: "attempt-1",
    model: "hosted-gamma",
    task: "verify",
    dataClass: "internal",
    messages: [
      { role: "system", text: "Judge only the cited spans." },
      { role: "user", text: "Is this claim supported?" },
    ],
    maxOutputUnits: 400,
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** The Anthropic error envelope: the `type` inside it is what makes the failure class precise. */
function errorBody(type: string, message: string): unknown {
  return { type: "error", error: { type, message } };
}

// ---------------------------------------------------------------- the loopback harness (§6a)

interface WireRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface WireReply {
  status: number;
  body: unknown;
  /** Never answer at all, so the adapter's own timeout is the only thing that can end the call. */
  hold?: boolean;
}

let server: Server;
let base = "";
const sockets = new Set<Socket>();
const wire: WireRequest[] = [];
let responder: (request: WireRequest) => WireReply = () => ({ status: 200, body: ANSWER_BODY });

/** An adapter pointed at the loopback listener, taking its key from the test environment per call. */
function loopback(overrides: Partial<AdapterCallRequest> = {}): Promise<AdapterCallOutcome> {
  return createClaudeAdapter({
    endpoint: CLAUDE_ENDPOINT,
    baseUrl: base,
    apiKey: () => process.env[ENV_KEY],
  }).complete(requestFor(overrides));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: WireRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        // Node lower-cases header names, so the assertion below reads exactly what arrived.
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      wire.push(recorded);
      const reply = responder(recorded);
      if (reply.hold === true) return;
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env[ENV_KEY];
});

function wireBody(index: number): Record<string, unknown> {
  const entry = wire[index];
  if (entry === undefined) throw new Error(`expected a request on the wire at ${index}`);
  return JSON.parse(entry.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------- what crossed the socket

describe("claude adapter over a loopback listener (COORDINATION §6a)", () => {
  it("sends the key read during that call, so a rotation reaches the next request", async () => {
    // Workers resolves secret bindings per request, exactly like the Workers AI token (`4dd0501`).
    // A key captured when the adapter is built would never see a rotation and would freeze a cold
    // start into `provider_denied` for the life of the isolate.
    responder = () => ({ status: 200, body: ANSWER_BODY });
    process.env[ENV_KEY] = "synthetic-key-alpha";
    const adapter = createClaudeAdapter({
      endpoint: CLAUDE_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[ENV_KEY],
    });
    expect((await adapter.complete(requestFor({ attemptId: "attempt-call-1" }))).ok).toBe(true);
    process.env[ENV_KEY] = "synthetic-key-beta";
    expect((await adapter.complete(requestFor({ attemptId: "attempt-call-2" }))).ok).toBe(true);

    const postedKeys = wire.map((entry) => entry.headers["x-api-key"]);
    expect(postedKeys).toEqual(["synthetic-key-alpha", "synthetic-key-beta"]);
    expect(wire[0]?.method).toBe("POST");
    expect(wire[0]?.path).toBe("/v1/messages");
    // Anthropic authenticates with `x-api-key`; a Bearer credential would be the other provider's
    // scheme and a rotated value would silently stop being sent.
    expect(wire[0]?.headers["authorization"]).toBeUndefined();
    expect(wire[0]?.headers["anthropic-version"]).toBeTruthy();
  });

  it("asks for the model the route chose, and the cap it was given, on the wire", async () => {
    // #76 was this bug in the other direction: a chain selected a verifier model and the call path
    // never passed it to an adapter that hardcoded its own. For a `verify` task the route resolves
    // `endpoint.verifierModel`, which is deliberately not `endpoint.model`.
    responder = () => ({ status: 200, body: { ...ANSWER_BODY, content: [{ type: "text", text: "partial" }] } });
    process.env[ENV_KEY] = "synthetic-key-alpha";
    const outcome = await loopback({ model: "hosted-gamma-verifier", maxOutputUnits: 311, attemptId: "attempt-wire-model" });
    const posted = wireBody(wire.length - 1);
    expect(posted.model).toBe("hosted-gamma-verifier");
    expect(posted.model).not.toBe(CLAUDE_ENDPOINT.model);
    expect(posted.max_tokens).toBe(311);
    expect(outcome).toMatchObject({ ok: true, model: "hosted-gamma-verifier", text: "partial" });
  });

  it("hoists the system turn out of `messages`, because that is the Messages API shape", async () => {
    responder = () => ({ status: 200, body: ANSWER_BODY });
    process.env[ENV_KEY] = "synthetic-key-alpha";
    await loopback({ attemptId: "attempt-system-shape" });
    const posted = wireBody(wire.length - 1);
    expect(posted.system).toBe("Judge only the cited spans.");
    expect(posted.messages).toEqual([{ role: "user", content: "Is this claim supported?" }]);
  });

  it("a 500 is a possibly-billed outage carrying only the status: no provider body, no key", async () => {
    responder = () => ({
      status: 500,
      body: errorBody("api_error", `upstream failure for ${process.env[ENV_KEY] ?? ""} at internal.host:6379`),
    });
    process.env[ENV_KEY] = "synthetic-key-leak-check";
    const outcome = await loopback({ attemptId: "attempt-500" });
    expect(outcome).toMatchObject({ ok: false, kind: "server_error", possiblyBilled: true, statusCode: 500 });
    // Nothing but the closed kind and the status leaves: this object is what an attempt record and a
    // run audit would store (plan §12.2, §9.3).
    expect(JSON.stringify(outcome)).not.toMatch(/synthetic-key|internal\.host|api_error|upstream/i);
    responder = () => ({ status: 200, body: ANSWER_BODY });
  });

  it("a 401 is provider_denied with no provider text, and the key still does not escape", async () => {
    responder = () => ({ status: 401, body: errorBody("authentication_error", "invalid x-api-key") });
    process.env[ENV_KEY] = "synthetic-key-leak-check";
    const outcome = await loopback({ attemptId: "attempt-401" });
    expect(outcome).toMatchObject({ ok: false, kind: "provider_denied", possiblyBilled: false, statusCode: 401 });
    expect(JSON.stringify(outcome)).not.toMatch(/x-api-key|synthetic-key/i);
  });

  it("a hung provider hits the call timeout and stays ambiguous", async () => {
    responder = () => ({ status: 200, body: {}, hold: true });
    process.env[ENV_KEY] = "synthetic-key-alpha";
    const started = Date.now();
    const outcome = await loopback({ attemptId: "attempt-hang", timeoutMs: 120 });
    expect(outcome).toMatchObject({ ok: false, kind: "timeout", possiblyBilled: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    responder = () => ({ status: 200, body: ANSWER_BODY });
  });

  it("no credential in the environment means no socket request at all", async () => {
    delete process.env[ENV_KEY];
    const before = wire.length;
    const adapter = createClaudeAdapter({
      endpoint: CLAUDE_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[ENV_KEY],
    });
    const outcome = await adapter.complete(requestFor({ attemptId: "attempt-no-key" }));
    // Fail closed before the network: an unauthenticated call would burn quota and leak a prompt.
    expect(outcome).toMatchObject({ ok: false, kind: "provider_denied", possiblyBilled: false });
    expect(wire).toHaveLength(before);
  });

  it("a `restricted` payload reaches nothing: the socket records zero requests (the filter decides)", async () => {
    // The #46 ruling's other half: this slice does not relax clearance, and the proof is a count on
    // the wire, not a code reading. `claude` is capped at `client_confidential` (§12.4 default
    // matrix), so a restricted payload must never build a request at all.
    wire.length = 0;
    responder = () => ({ status: 200, body: ANSWER_BODY });
    process.env[ENV_KEY] = "synthetic-key-alpha";
    const meter = recordingMeter();
    const claude = createClaudeAdapter({
      endpoint: CLAUDE_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[ENV_KEY],
    });
    const result = await callModelGateway(
      {
        context: syntheticContext(),
        runId: RUN_ID,
        task: "compose",
        dataClass: "restricted",
        messages: [{ role: "user", text: "Read the calibration log." }],
        maxOutputUnits: 128,
        callTimeoutMs: 5_000,
        stageDeadlineMs: 20_000,
        chain: ["claude"],
      },
      {
        config: testConfiguration(),
        adapters: registryOf(claude),
        health: new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 }),
        meter,
      },
    );
    expect(result).toMatchObject({ ok: false, status: "unavailable", reason: "no_eligible_provider" });
    expect(wire).toHaveLength(0);
    expect(meter.events).toEqual([]);
  });

  it("a missing secret ends the routed call as unavailable, with the socket never opened (T-115f box)", async () => {
    // The packet line is "a missing secret is `unavailable`, never a crash or a logged key". At the
    // adapter that is a typed failure; at the gateway it is an `unavailable` result, and the attempt
    // record that reaches the run audit must still name no credential.
    wire.length = 0;
    responder = () => ({ status: 200, body: ANSWER_BODY });
    delete process.env[ENV_KEY];
    const meter = recordingMeter();
    const claude = createClaudeAdapter({
      endpoint: CLAUDE_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[ENV_KEY],
    });
    const result = await callModelGateway<string>(
      {
        context: syntheticContext(),
        runId: RUN_ID,
        task: "verify",
        composedWith: { providerKey: "local_box", model: "open-weights-alpha" },
        minTier: "large",
        passTag: "claim-1",
        dataClass: "internal",
        messages: [{ role: "user", text: "Is this supported?" }],
        maxOutputUnits: 128,
        callTimeoutMs: 5_000,
        stageDeadlineMs: 20_000,
        chain: ["claude"],
      },
      {
        config: testConfiguration(),
        adapters: registryOf(claude),
        health: new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 }),
        meter,
      },
    );
    expect(result).toMatchObject({ ok: false, status: "unavailable", reason: "all_attempts_failed" });
    if (result.ok) throw new Error("expected an unavailable result");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ providerKey: "claude", outcome: "provider_denied", reconciled: "released" });
    expect(wire).toHaveLength(0);
    // The reservation is released, not held: nothing was sent, so nothing may be counted as spent.
    expect(meter.events).toEqual([
      `reserve:claude:${RUN_ID}:1:verify:claim-1`,
      `reconcile:released:${RUN_ID}:1:verify:claim-1`,
    ]);
    expect(JSON.stringify(result)).not.toMatch(/x-api-key|synthetic-key|anthropic/i);
  });

  it("routes a verify through the gateway and the verifier model is what reaches the socket (plan §12.4 rule (e))", async () => {
    // The whole path, not the adapter alone: route → call → adapter → wire. This is the exact shape
    // of the #76 finding, which no adapter-level test could see.
    wire.length = 0;
    responder = () => ({ status: 200, body: ANSWER_BODY });
    process.env[ENV_KEY] = "synthetic-key-alpha";
    const meter = recordingMeter();
    const claude = createClaudeAdapter({
      endpoint: CLAUDE_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[ENV_KEY],
    });
    const input: GatewayCallInput<string> = {
      context: syntheticContext(),
      runId: RUN_ID,
      task: "verify",
      // Composed elsewhere, at a different model: rule (e) forbids the composer verifying its own answer.
      composedWith: { providerKey: "local_box", model: "open-weights-alpha" },
      minTier: "large",
      passTag: "claim-0",
      dataClass: "internal",
      messages: [{ role: "user", text: "Is this supported?" }],
      maxOutputUnits: 128,
      callTimeoutMs: 5_000,
      stageDeadlineMs: 20_000,
      chain: ["local_box", "claude"],
    };
    const result = await callModelGateway(input, {
      config: testConfiguration(),
      adapters: registryOf(claude),
      health: new CircuitBook({ openAfterFailures: 2, cooldownMs: 30_000 }),
      meter,
    });
    if (!result.ok) throw new Error(`expected the routed call to answer, got ${result.reason}`);
    // The reviewed endpoint records `verifierModel: hosted-gamma` for claude; that, not
    // `endpoint.model` of any other row, is what the socket must carry.
    expect(wire).toHaveLength(1);
    expect(wireBody(0).model).toBe("hosted-gamma");
    expect(wireBody(0).max_tokens).toBe(128);
    expect(result.model).toBe("hosted-gamma");
    expect(result.usage).toEqual({ inputUnits: 41, outputUnits: 11 });
    expect(meter.events).toEqual([
      `reserve:claude:${RUN_ID}:2:verify:claim-0`,
      `reconcile:settled:${RUN_ID}:2:verify:claim-0`,
    ]);
    expect(JSON.stringify(result.attempts)).not.toMatch(/synthetic-key|x-api-key/i);
  });
});

// ---------------------------------------------------------------- classification with an injected fetch

function capturingFetch(replies: Array<() => Response>): { fetch: FetchImpl; requests: Array<{ url: string; init: RequestInit }> } {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = replies[Math.min(index, replies.length - 1)] ?? replies[0];
    index += 1;
    return next ? next() : Response.json({ ok: true });
  };
  return { fetch: fetchImpl, requests };
}

function fakeAdapterFor(replies: Array<() => Response>, apiKey: () => string | undefined = () => "synthetic-key") {
  const capture = capturingFetch(replies);
  return {
    ...capture,
    adapter: createClaudeAdapter({
      endpoint: CLAUDE_ENDPOINT,
      baseUrl: "https://api.anthropic.com",
      apiKey,
      fetchImpl: capture.fetch,
    }),
  };
}

const json = (body: unknown, status = 200) => () => Response.json(body, { status });

describe("claude adapter failure taxonomy and metering (plan §12.4, §12.3)", () => {
  it("429 is rate_limited, not billed, and marks the quota for the route", async () => {
    const h = fakeAdapterFor([json(errorBody("rate_limit_error", "rate limit reached"), 429)]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-429" }));
    expect(outcome).toMatchObject({ ok: false, kind: "rate_limited", possiblyBilled: false, statusCode: 429 });
  });

  it("529 overloaded_error is the outage class and may already be billed", async () => {
    const h = fakeAdapterFor([json(errorBody("overloaded_error", "Overloaded"), 529)]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-529" }));
    expect(outcome).toMatchObject({ ok: false, kind: "server_error", possiblyBilled: true, statusCode: 529 });
  });

  it("a 400 that means our request was wrong is invalid_request, so the chain stops instead of walking", async () => {
    // The point of #76's class: an outage reading would fail the chain over to the next provider,
    // hand it the same broken request and three calls later open a circuit that is not unhealthy.
    const h = fakeAdapterFor([json(errorBody("invalid_request_error", "`max_tokens` must be positive"), 400)]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-400-shape" }));
    expect(outcome).toMatchObject({ ok: false, kind: "invalid_request", possiblyBilled: false, statusCode: 400 });
    expect(JSON.stringify(outcome)).not.toMatch(/max_tokens.*positive|invalid_request_error/);
  });

  it("a 404 unknown model is also our wiring, not the provider's", async () => {
    const h = fakeAdapterFor([json(errorBody("not_found_error", "model not found"), 404)]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-404", model: "hosted-nope" }));
    expect(outcome).toMatchObject({ ok: false, kind: "invalid_request", possiblyBilled: false, statusCode: 404 });
  });

  it("a prompt over the context window is context_overflow, and the provider's wording stays inside", async () => {
    const h = fakeAdapterFor([
      json(errorBody("invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"), 400),
    ]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-toolong" }));
    expect(outcome).toMatchObject({ ok: false, kind: "context_overflow", possiblyBilled: false });
    expect(JSON.stringify(outcome)).not.toMatch(/tokens|maximum/i);
  });

  it("an unparseable body is never guessed at: only the status leaves", async () => {
    const h = fakeAdapterFor([() => new Response("<html>gateway refused</html>", { status: 502 })]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-html" }));
    expect(outcome).toMatchObject({ ok: false, kind: "server_error", possiblyBilled: true, statusCode: 502 });
    expect(JSON.stringify(outcome)).not.toMatch(/html|gateway refused/i);
  });

  it("stop_reason max_tokens is truncation, so an over-cap answer is never treated as complete", async () => {
    const h = fakeAdapterFor([
      json({ ...ANSWER_BODY, content: [{ type: "text", text: "{\"claims\":" }], stop_reason: "max_tokens" }),
    ]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-truncated" }));
    expect(outcome).toMatchObject({ ok: true, finishReason: "length", text: "{\"claims\":" });
  });

  it("joins the text blocks and meters the provider's units", async () => {
    const h = fakeAdapterFor([
      json({
        ...ANSWER_BODY,
        content: [
          { type: "text", text: "The span " },
          { type: "text", text: "supports the claim." },
        ],
        usage: { input_tokens: 60, output_tokens: 14 },
      }),
    ]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-blocks" }));
    expect(outcome).toEqual({
      ok: true,
      text: "The span supports the claim.",
      model: "hosted-gamma",
      finishReason: "stop",
      usage: { inputUnits: 60, outputUnits: 14 },
    });
  });

  it("an answer with no text block is invalid_output on work that is already billed", async () => {
    const h = fakeAdapterFor([json({ ...ANSWER_BODY, content: [], stop_reason: "end_turn" })]);
    const outcome = await h.adapter.complete(requestFor({ attemptId: "attempt-empty" }));
    expect(outcome).toMatchObject({ ok: false, kind: "invalid_output", possiblyBilled: true });
  });

  it("refuses a request naming no model, and sends nothing", async () => {
    const h = fakeAdapterFor([json(ANSWER_BODY)]);
    const outcome = await h.adapter.complete({
      ...requestFor({ attemptId: "attempt-no-model" }),
      model: undefined as unknown as string,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "invalid_request", possiblyBilled: false });
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a request with no user turn instead of burning a call on an impossible shape", async () => {
    const h = fakeAdapterFor([json(ANSWER_BODY)]);
    const outcome = await h.adapter.complete({
      ...requestFor({ attemptId: "attempt-no-user" }),
      messages: [{ role: "system", text: "Judge only the cited spans." }],
    });
    expect(outcome).toMatchObject({ ok: false, kind: "invalid_request", possiblyBilled: false });
    expect(h.requests).toHaveLength(0);
  });

  it("registers no health endpoint, so an unprobed claude is not scored by this slice (health is T-314)", async () => {
    const h = fakeAdapterFor([json(ANSWER_BODY)]);
    // A paid or quota-consuming request used as a health check is a deployment decision with a cost,
    // and the passive-check packet owns it. `workers_ai` has the same shape for the same reason.
    expect(h.adapter.health).toBeUndefined();
  });
});
