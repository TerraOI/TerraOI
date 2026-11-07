import { describe, expect, it } from "vitest";

import { createLocalBoxAdapter, createWorkersAiAdapter, type AdapterCallRequest, type FetchImpl } from "./adapters";

/**
 * The two M1 adapters are plain `fetch` calls (AGENTS.md §4.3: no provider SDK anywhere, so the
 * dependency count stays zero). Everything here runs against an injected `fetch`, and a real
 * response body never travels out of the adapter: it is the seam where a provider's own error
 * text — which can carry a key, a model id or an internal URL — is dropped (plan §12.2, §9.3).
 */

const ENDPOINT = { providerKey: "local_box", model: "open-weights-alpha" } as const;
const WORKERS_ENDPOINT = { providerKey: "workers_ai", model: "hosted-beta" } as const;

function capturingFetch(responses: Array<() => Response>): { fetch: FetchImpl; requests: Array<{ url: string; init: RequestInit }> } {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)] ?? responses[0];
    index += 1;
    return next ? next() : Response.json({ error: "unreachable" }, { status: 503 });
  };
  return { fetch: fetchImpl, requests };
}

const localBox = (fetchImpl: FetchImpl, secrets = { tokenId: "synthetic-id", tokenSecret: "synthetic-secret" }) =>
  createLocalBoxAdapter({
    endpoint: ENDPOINT,
    baseUrl: "https://box-tunnel.example.internal",
    secrets: () => secrets,
    fetchImpl,
  });

describe("local_box adapter (plan §12.4 Local box contract)", () => {
  it("posts an OpenAI-compatible chat request to the tunnel with the Access service token", async () => {
    const capture = capturingFetch([
      () =>
        Response.json({
          choices: [{ message: { content: "Hold the trigger." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 7 },
        }),
    ]);
    const adapter = localBox(capture.fetch);
    const outcome = await adapter.complete({
      attemptId: "attempt-1",
      model: "open-weights-alpha",
      task: "compose",
      dataClass: "internal",
      messages: [{ role: "user", text: "Q?" }],
      maxOutputUnits: 400,
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({
      ok: true,
      text: "Hold the trigger.",
      model: "open-weights-alpha",
      finishReason: "stop",
      usage: { inputUnits: 30, outputUnits: 7 },
    });
    const [request] = capture.requests;
    expect(request?.url).toBe("https://box-tunnel.example.internal/v1/chat/completions");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("cf-access-key-id")).toBe("synthetic-id");
    expect(headers.get("cf-access-secret")).toBe("synthetic-secret");
    const body = JSON.parse(String(request?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("open-weights-alpha");
    expect(body.max_tokens).toBe(400);
    expect(body.messages).toEqual([{ role: "user", content: "Q?" }]);
  });

  it("posts the model named on the request, which for a verify call is the evaluated verifier model (plan §12.4 rule (e) on the wire)", async () => {
    const capture = capturingFetch([
      () =>
        Response.json({
          choices: [{ message: { content: "supported" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 7 },
        }),
    ]);
    const outcome = await localBox(capture.fetch).complete({
      attemptId: "attempt-verify-1",
      model: "open-weights-beta",
      task: "verify",
      dataClass: "internal",
      messages: [{ role: "user", text: "Is this supported by the evidence?" }],
      maxOutputUnits: 400,
      timeoutMs: 5_000,
    });
    // The endpoint's composing model is `open-weights-alpha`; asking it to verify its own answer is
    // exactly what rule (e) forbids, so the request's model is what must reach the wire.
    expect(outcome).toMatchObject({ ok: true, model: "open-weights-beta" });
    const posted = JSON.parse(String(capture.requests[0]?.init.body)) as Record<string, unknown>;
    expect(posted.model).toBe("open-weights-beta");
  });

  it("refuses a call that names no model instead of quietly sending the endpoint default", async () => {
    const capture = capturingFetch([() => Response.json({ ok: true })]);
    const outcome = await localBox(capture.fetch).complete({
      attemptId: "attempt-no-model",
      task: "verify",
      dataClass: "internal",
      messages: [{ role: "user", text: "Q?" }],
      maxOutputUnits: 400,
      timeoutMs: 5_000,
    } as unknown as AdapterCallRequest);
    expect(outcome).toMatchObject({ ok: false, kind: "provider_denied", possiblyBilled: false });
    expect(capture.requests).toHaveLength(0);
  });

  it("sends no request at all when the Access secret is missing (fail closed, no secret in code)", async () => {
    const capture = capturingFetch([() => Response.json({ ok: true })]);
    const adapter = createLocalBoxAdapter({
      endpoint: ENDPOINT,
      baseUrl: "https://box-tunnel.example.internal",
      secrets: () => undefined,
      fetchImpl: capture.fetch,
    });
    const outcome = await adapter.complete({
      attemptId: "attempt-1",
      model: "open-weights-alpha",
      task: "compose",
      dataClass: "internal",
      messages: [{ role: "user", text: "Q?" }],
      maxOutputUnits: 400,
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "provider_denied", possiblyBilled: false });
    expect(capture.requests).toHaveLength(0);
  });

  it("a 5xx is a server_error that may already be billed, and the provider's body never escapes", async () => {
    const capture = capturingFetch([
      () =>
        Response.json(
          { error: { message: "upstream failed for key sk-synthetic-leak-check on open-weights-alpha" } },
          { status: 500 },
        ),
    ]);
    const outcome = await localBox(capture.fetch).complete({
      attemptId: "attempt-1",
      model: "open-weights-alpha",
      task: "compose",
      dataClass: "internal",
      messages: [{ role: "user", text: "Q?" }],
      maxOutputUnits: 400,
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "server_error", possiblyBilled: true, statusCode: 500 });
    expect(JSON.stringify(outcome)).not.toMatch(/sk-|upstream|open-weights/);
  });

  it("429 is rate_limited (not billed) and a hung connection becomes an ambiguous timeout", async () => {
    const capture = capturingFetch([() => new Response(null, { status: 429 })]);
    const rateLimited = await localBox(capture.fetch).complete({
      attemptId: "attempt-1",
      model: "open-weights-alpha",
      task: "compose",
      dataClass: "internal",
      messages: [{ role: "user", text: "Q?" }],
      maxOutputUnits: 400,
      timeoutMs: 5_000,
    });
    expect(rateLimited).toMatchObject({ ok: false, kind: "rate_limited", possiblyBilled: false });

    const hanging: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "TimeoutError"));
        });
      });
    const timeout = await localBox(hanging).complete({
      attemptId: "attempt-2",
      model: "open-weights-alpha",
      task: "compose",
      dataClass: "internal",
      messages: [{ role: "user", text: "Q?" }],
      maxOutputUnits: 400,
      timeoutMs: 20,
    });
    expect(timeout).toMatchObject({ ok: false, kind: "timeout", possiblyBilled: true });
  });

  it("a refused connection is a clean failure with no liability", async () => {
    const refusing: FetchImpl = async () => {
      throw new TypeError("fetch failed: tunnel unavailable");
    };
    const outcome = await localBox(refusing).complete({
      attemptId: "attempt-1",
      model: "open-weights-alpha",
      task: "compose",
      dataClass: "internal",
      messages: [{ role: "user", text: "Q?" }],
      maxOutputUnits: 400,
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "connection", possiblyBilled: false });
    expect(JSON.stringify(outcome)).not.toMatch(/tunnel|fetch failed/);
  });

  it("health is the box's own endpoint, and a non-2xx answer means unhealthy", async () => {
    const capture = capturingFetch([() => Response.json({ ok: true }), () => new Response(null, { status: 503 })]);
    const adapter = localBox(capture.fetch);
    expect(await adapter.health?.()).toBe(true);
    expect(await adapter.health?.()).toBe(false);
    expect(capture.requests[0]?.url).toBe("https://box-tunnel.example.internal/health");
  });
});

describe("workers_ai adapter (Cloudflare Workers AI REST)", () => {
  const adapterFor = (fetchImpl: FetchImpl) =>
    createWorkersAiAdapter({
      endpoint: WORKERS_ENDPOINT,
      accountId: "synthetic-account",
      apiToken: () => "synthetic-token",
      fetchImpl,
    });

  it("runs the pinned model through the account REST endpoint and reports usage in units", async () => {
    const capture = capturingFetch([
      () =>
        Response.json({
          success: true,
          result: { response: "Set the gain to 4.", usage: { prompt_tokens: 22, completion_tokens: 5 } },
        }),
    ]);
    const outcome = await adapterFor(capture.fetch).complete({
      attemptId: "attempt-1",
      model: "hosted-beta",
      task: "condense",
      dataClass: "public",
      messages: [{ role: "user", text: "Summarise." }],
      maxOutputUnits: 200,
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({
      ok: true,
      text: "Set the gain to 4.",
      model: "hosted-beta",
      finishReason: "stop",
      usage: { inputUnits: 22, outputUnits: 5 },
    });
    const [request] = capture.requests;
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai/run/hosted-beta",
    );
    expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer synthetic-token");
  });

  it("a context-length rejection is context_overflow, and the body is not carried out", async () => {
    const capture = capturingFetch([
      () => Response.json({ success: false, errors: [{ message: "input exceeds the model context window" }] }, { status: 400 }),
    ]);
    const outcome = await adapterFor(capture.fetch).complete({
      attemptId: "attempt-1",
      model: "hosted-beta",
      task: "condense",
      dataClass: "public",
      messages: [{ role: "user", text: "Summarise." }],
      maxOutputUnits: 200,
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "context_overflow", possiblyBilled: false });
    expect(JSON.stringify(outcome)).not.toMatch(/context window|exceeds/);
  });

  it("an unparseable success envelope is invalid_output, which is already billed work", async () => {
    const capture = capturingFetch([() => Response.json({ success: true, result: { unexpected: 1 } })]);
    const outcome = await adapterFor(capture.fetch).complete({
      attemptId: "attempt-1",
      model: "hosted-beta",
      task: "condense",
      dataClass: "public",
      messages: [{ role: "user", text: "Summarise." }],
      maxOutputUnits: 200,
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "invalid_output", possiblyBilled: true });
  });

  it("runs the model named on the request through the account endpoint, not the pinned composing model", async () => {
    const capture = capturingFetch([
      () =>
        Response.json({
          success: true,
          result: { response: "supported", usage: { prompt_tokens: 22, completion_tokens: 5 } },
        }),
    ]);
    const outcome = await adapterFor(capture.fetch).complete({
      attemptId: "attempt-verify-2",
      model: "hosted-gamma-verifier",
      task: "verify",
      dataClass: "internal",
      messages: [{ role: "user", text: "Is this supported?" }],
      maxOutputUnits: 200,
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ ok: true, model: "hosted-gamma-verifier" });
    const [request] = capture.requests;
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai/run/hosted-gamma-verifier",
    );
  });

  it("no token means no request (fail closed)", async () => {
    const capture = capturingFetch([() => Response.json({ ok: true })]);
    const adapter = createWorkersAiAdapter({
      endpoint: WORKERS_ENDPOINT,
      accountId: "synthetic-account",
      apiToken: () => undefined,
      fetchImpl: capture.fetch,
    });
    const outcome = await adapter.complete({
      attemptId: "attempt-1",
      model: "hosted-beta",
      task: "condense",
      dataClass: "public",
      messages: [{ role: "user", text: "Summarise." }],
      maxOutputUnits: 200,
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "provider_denied", possiblyBilled: false });
    expect(capture.requests).toHaveLength(0);
  });
});
