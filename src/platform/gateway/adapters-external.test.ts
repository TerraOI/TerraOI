import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OPENROUTER_PINNED_MODELS,
  createDeepSeekAdapter,
  createOpenRouterAdapter,
  type AdapterCallRequest,
} from "./adapters";
import { callModelGateway } from "./call";
import { CircuitBook } from "./circuit";
import {
  RUN_ID,
  recordingMeter,
  registryOf,
  syntheticContext,
  testConfiguration,
} from "./gateway-fixtures";

/**
 * T-314 PR-1: DeepSeek and OpenRouter adapters (plan §12.4 rows 4–5). Plain `fetch`, no SDK.
 * Loopback proves the Bearer key and model id on the wire; injected fetch covers failure classes.
 */

const DEEPSEEK_ENV = "TERRAOI_TEST_DEEPSEEK_KEY";
const OPENROUTER_ENV = "TERRAOI_TEST_OPENROUTER_KEY";

const DEEPSEEK_ENDPOINT = { providerKey: "deepseek" as const, model: "hosted-delta" };
const OPENROUTER_ENDPOINT = { providerKey: "openrouter" as const, model: "hosted-epsilon" };

const CHAT_ANSWER = {
  id: "chatcmpl-synth",
  choices: [{ index: 0, message: { role: "assistant", content: "public answer" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
};

function requestFor(overrides: Partial<AdapterCallRequest> = {}): AdapterCallRequest {
  return {
    attemptId: "attempt-ext-1",
    model: "hosted-delta",
    task: "compose",
    dataClass: "public",
    messages: [
      { role: "system", text: "Answer from the pack." },
      { role: "user", text: "What is the limit?" },
    ],
    maxOutputUnits: 200,
    timeoutMs: 5_000,
    ...overrides,
  };
}

interface WireRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface WireReply {
  status: number;
  body: unknown;
}

let server: Server;
let base = "";
const sockets = new Set<Socket>();
const wire: WireRequest[] = [];
let responder: (request: WireRequest) => WireReply = () => ({ status: 200, body: CHAT_ANSWER });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: WireRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      wire.push(recorded);
      const reply = responder(recorded);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  delete process.env[DEEPSEEK_ENV];
  delete process.env[OPENROUTER_ENV];
});

describe("createDeepSeekAdapter", () => {
  it("posts the request model to /chat/completions with a Bearer key read at call time", async () => {
    process.env[DEEPSEEK_ENV] = "sk-synth-deepseek";
    wire.length = 0;
    responder = () => ({ status: 200, body: CHAT_ANSWER });
    const outcome = await createDeepSeekAdapter({
      endpoint: DEEPSEEK_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[DEEPSEEK_ENV],
    }).complete(requestFor({ model: "hosted-delta" }));
    expect(outcome).toMatchObject({ ok: true, text: "public answer", model: "hosted-delta" });
    expect(wire).toHaveLength(1);
    expect(wire[0]!.path).toBe("/chat/completions");
    expect(wire[0]!.headers.authorization).toBe("Bearer sk-synth-deepseek");
    const payload = JSON.parse(wire[0]!.body) as { model: string; max_tokens: number };
    expect(payload.model).toBe("hosted-delta");
    expect(payload.max_tokens).toBe(200);
    delete process.env[DEEPSEEK_ENV];
  });

  it("refuses with provider_denied when the key is missing (nothing leaves the process)", async () => {
    const outcome = await createDeepSeekAdapter({
      endpoint: DEEPSEEK_ENDPOINT,
      baseUrl: base,
      apiKey: () => undefined,
    }).complete(requestFor());
    expect(outcome).toEqual({ ok: false, kind: "provider_denied", possiblyBilled: false });
  });

  it("refuses a request with no model rather than substituting the endpoint default", async () => {
    const outcome = await createDeepSeekAdapter({
      endpoint: DEEPSEEK_ENDPOINT,
      baseUrl: base,
      apiKey: () => "sk-synth",
    }).complete(requestFor({ model: "" }));
    expect(outcome).toEqual({ ok: false, kind: "invalid_request", possiblyBilled: false });
  });
});

describe("createOpenRouterAdapter", () => {
  it("refuses a model outside the pinned allow-list before any fetch", async () => {
    let fetches = 0;
    const outcome = await createOpenRouterAdapter({
      endpoint: OPENROUTER_ENDPOINT,
      baseUrl: base,
      apiKey: () => "sk-or-synth",
      allowedModels: OPENROUTER_PINNED_MODELS,
      fetchImpl: async () => {
        fetches += 1;
        return new Response("{}", { status: 200 });
      },
    }).complete(requestFor({ model: "unpinned-evil-model" }));
    expect(outcome).toEqual({ ok: false, kind: "invalid_request", possiblyBilled: false });
    expect(fetches).toBe(0);
  });

  it("posts a pinned model to /chat/completions", async () => {
    process.env[OPENROUTER_ENV] = "sk-or-synth";
    wire.length = 0;
    const pinned = OPENROUTER_PINNED_MODELS[0]!;
    responder = () => ({
      status: 200,
      body: {
        ...CHAT_ANSWER,
        choices: [{ index: 0, message: { role: "assistant", content: "or answer" }, finish_reason: "stop" }],
      },
    });
    const outcome = await createOpenRouterAdapter({
      endpoint: OPENROUTER_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[OPENROUTER_ENV],
      allowedModels: OPENROUTER_PINNED_MODELS,
    }).complete(requestFor({ model: pinned }));
    expect(outcome).toMatchObject({ ok: true, text: "or answer", model: pinned });
    expect(wire[0]!.path).toBe("/chat/completions");
    expect(wire[0]!.headers.authorization).toBe("Bearer sk-or-synth");
    expect(JSON.parse(wire[0]!.body).model).toBe(pinned);
    delete process.env[OPENROUTER_ENV];
  });
});

describe("gateway: public compose through DeepSeek / OpenRouter (F19 reserve + audit)", () => {
  it("answers a public payload at DeepSeek's chain position and settles the reservation", async () => {
    process.env[DEEPSEEK_ENV] = "sk-synth-deepseek";
    wire.length = 0;
    responder = () => ({ status: 200, body: CHAT_ANSWER });
    const meter = recordingMeter();
    const deepseek = createDeepSeekAdapter({
      endpoint: DEEPSEEK_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[DEEPSEEK_ENV],
    });
    const result = await callModelGateway(
      {
        context: syntheticContext(),
        runId: RUN_ID,
        task: "compose",
        dataClass: "public",
        messages: [{ role: "user", text: "What is the public limit?" }],
        maxOutputUnits: 200,
        callTimeoutMs: 5_000,
        stageDeadlineMs: 10_000,
        chain: ["deepseek"],
      },
      {
        config: testConfiguration(),
        adapters: registryOf(deepseek),
        health: new CircuitBook(testConfiguration().circuit),
        meter,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.text).toBe("public answer");
    expect(result.providerKey).toBe("deepseek");
    expect(result.model).toBe("hosted-delta");
    expect(wire).toHaveLength(1);
    expect(meter.events[0]).toMatch(/^reserve:deepseek:/);
    expect(meter.events.some((event) => event.startsWith("reconcile:settled:"))).toBe(true);
    delete process.env[DEEPSEEK_ENV];
  });

  it("answers a public payload at OpenRouter's chain position with a pinned model", async () => {
    process.env[OPENROUTER_ENV] = "sk-or-synth";
    wire.length = 0;
    const pinned = OPENROUTER_PINNED_MODELS[0]!;
    responder = () => ({
      status: 200,
      body: {
        ...CHAT_ANSWER,
        choices: [{ index: 0, message: { role: "assistant", content: "or public" }, finish_reason: "stop" }],
      },
    });
    const meter = recordingMeter();
    const openrouter = createOpenRouterAdapter({
      endpoint: OPENROUTER_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[OPENROUTER_ENV],
      allowedModels: OPENROUTER_PINNED_MODELS,
    });
    const result = await callModelGateway(
      {
        context: syntheticContext(),
        runId: RUN_ID,
        task: "compose",
        dataClass: "public",
        messages: [{ role: "user", text: "Public fallback?" }],
        maxOutputUnits: 200,
        callTimeoutMs: 5_000,
        stageDeadlineMs: 10_000,
        chain: ["openrouter"],
      },
      {
        config: testConfiguration(),
        adapters: registryOf(openrouter),
        health: new CircuitBook(testConfiguration().circuit),
        meter,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.text).toBe("or public");
    expect(result.providerKey).toBe("openrouter");
    expect(result.model).toBe(pinned);
    expect(JSON.parse(wire[0]!.body).model).toBe(pinned);
    expect(meter.events[0]).toMatch(/^reserve:openrouter:/);
    delete process.env[OPENROUTER_ENV];
  });
});

describe("clearance: non-public payloads never reach DeepSeek or OpenRouter", () => {
  it("client_confidential compose records zero DeepSeek/OpenRouter calls on the wire", async () => {
    wire.length = 0;
    process.env[DEEPSEEK_ENV] = "sk-synth";
    process.env[OPENROUTER_ENV] = "sk-or-synth";
    responder = () => ({ status: 200, body: CHAT_ANSWER });
    const deepseek = createDeepSeekAdapter({
      endpoint: DEEPSEEK_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[DEEPSEEK_ENV],
    });
    const openrouter = createOpenRouterAdapter({
      endpoint: OPENROUTER_ENDPOINT,
      baseUrl: base,
      apiKey: () => process.env[OPENROUTER_ENV],
      allowedModels: OPENROUTER_PINNED_MODELS,
    });
    const result = await callModelGateway(
      {
        context: syntheticContext(),
        runId: RUN_ID,
        task: "compose",
        dataClass: "client_confidential",
        messages: [{ role: "user", text: "secret client fact" }],
        maxOutputUnits: 100,
        callTimeoutMs: 5_000,
        stageDeadlineMs: 10_000,
        chain: ["deepseek", "openrouter"],
      },
      {
        config: testConfiguration(),
        adapters: registryOf(deepseek, openrouter),
        health: new CircuitBook(testConfiguration().circuit),
        meter: recordingMeter(),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unavailable");
    expect(result).toMatchObject({ status: "unavailable", reason: "no_eligible_provider" });
    expect(wire).toHaveLength(0);
    delete process.env[DEEPSEEK_ENV];
    delete process.env[OPENROUTER_ENV];
  });

  it("restricted compose also leaves zero requests on both listeners", async () => {
    wire.length = 0;
    const deepseek = createDeepSeekAdapter({
      endpoint: DEEPSEEK_ENDPOINT,
      baseUrl: base,
      apiKey: () => "sk-synth",
    });
    const openrouter = createOpenRouterAdapter({
      endpoint: OPENROUTER_ENDPOINT,
      baseUrl: base,
      apiKey: () => "sk-or-synth",
      allowedModels: OPENROUTER_PINNED_MODELS,
    });
    const result = await callModelGateway(
      {
        context: syntheticContext(),
        runId: RUN_ID,
        task: "compose",
        dataClass: "restricted",
        messages: [{ role: "user", text: "restricted" }],
        maxOutputUnits: 100,
        callTimeoutMs: 5_000,
        stageDeadlineMs: 10_000,
        chain: ["deepseek", "openrouter"],
      },
      {
        config: testConfiguration(),
        adapters: registryOf(deepseek, openrouter),
        health: new CircuitBook(testConfiguration().circuit),
        meter: recordingMeter(),
      },
    );
    expect(result).toMatchObject({ ok: false, status: "unavailable", reason: "no_eligible_provider" });
    expect(wire).toHaveLength(0);
  });
});
