import type { DataClass } from "@/contracts/data-class";
import type { ProviderKey } from "@/contracts/keys";
import type { TaskClass } from "@/contracts/provider-route";

import type { ProviderEndpoint } from "./config";

/**
 * The M1 provider adapters (plan §12.4 rows 1–2 "Local box contract", plus the `verify` provider of
 * issue #9). This folder is the only place in the repository that reaches a model provider
 * (AGENTS.md §4.3), and there is **no provider SDK**: the dependency count stays zero and every
 * adapter is plain `fetch` against the provider's REST shape. DeepSeek/OpenRouter arrive with T-314;
 * Claude lands here with T-115f (#46), because a `verify` chain that starts at a provider with no
 * adapter degrades every answer to `partial`.
 *
 * Two rules live in this file:
 *
 * 1. **A provider's own error body stops here.** It can carry a key, an internal URL, a model id or
 *    a tenant fragment (plan §12.2, §9.3). The adapter classifies it into a closed failure kind and
 *    carries at most the HTTP status code; nothing else travels out, so nothing can leak into a
 *    run record, a log line or an employee-visible message.
 * 2. **`possiblyBilled` is decided by the one party that knows whether the request was sent.** A
 *    connection failure that never left the process is free; a timeout or a 5xx after the request
 *    was sent may already be spent (§12.3, "ambiguous timeouts count as potentially billed").
 */

export type ProviderFailureKind =
  | "connection"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "context_overflow"
  | "invalid_output"
  | "provider_denied"
  /**
   * The request itself is wrong — a required field this gateway builds is missing. Nothing was sent
   * and nothing can be billed, and the provider is not at fault: classifying it as
   * `provider_denied`/`provider_unavailable` would feed the circuit breaker and report our own wiring
   * bug as an outage (plan §12.4 chain-walking rule (b)). The chain must stop, not fail over.
   */
  | "invalid_request";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  text: string;
}

export interface AdapterCallRequest {
  /** Stable per (run, chain position, call): the metering idempotency key (§12.3). */
  attemptId: string;
  /**
   * The model this call must ask the provider for. The route layer resolves it per task: for a
   * `verify` task it is the **evaluated verifier model**, deliberately not the endpoint's composing
   * model (plan §12.4 rule (e)). An adapter that ignored this and sent `options.endpoint.model` would
   * ask the model that wrote the answer to verify it, and the audit row would then report the
   * composer — so a request naming no model is refused here rather than defaulted.
   */
  model: string;
  task: TaskClass;
  /** Informational: clearance is decided *before* the call, and the adapter must not branch on it. */
  dataClass: DataClass;
  messages: readonly ModelMessage[];
  maxOutputUnits: number;
  timeoutMs: number;
}

export type AdapterCallOutcome =
  | {
      ok: true;
      text: string;
      model: string;
      finishReason: "stop" | "length";
      usage?: { inputUnits: number; outputUnits: number };
    }
  | { ok: false; kind: ProviderFailureKind; possiblyBilled: boolean; statusCode?: number };

export interface ProviderAdapter {
  readonly providerKey: ProviderKey;
  complete(request: AdapterCallRequest): Promise<AdapterCallOutcome>;
  /** F37 health endpoint; absent means "unknown", which the gateway reads as unhealthy. */
  health?(): Promise<boolean>;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A request that names no model is a wiring bug, not a default: falling back to the endpoint's
 * composing model is exactly how rule (e) gets silently undone, so the adapter sends nothing.
 */
function modelOf(request: AdapterCallRequest): string | undefined {
  return typeof request.model === "string" && request.model.length > 0 ? request.model : undefined;
}

const CONTEXT_OVERFLOW_MARKERS = [
  "context",
  "too long",
  "maximum length",
  "input length",
  "token limit",
];

/** Classify an HTTP status. `observedText` is untrusted provider output: classify, never return. */
export function classifyStatus(
  status: number,
  observedText: string,
): { kind: ProviderFailureKind; possiblyBilled: boolean } {
  const text = observedText.toLowerCase();
  if (status === 429) return { kind: "rate_limited", possiblyBilled: false };
  if (status === 401 || status === 403) return { kind: "provider_denied", possiblyBilled: false };
  if (status === 400 && CONTEXT_OVERFLOW_MARKERS.some((marker) => text.includes(marker))) {
    return { kind: "context_overflow", possiblyBilled: false };
  }
  if (status >= 500) return { kind: "server_error", possiblyBilled: true };
  // A request this provider refuses (bad shape, unknown model, quota policy) is a provider-side
  // rejection: advance the chain, and assume nothing was generated.
  return { kind: "provider_denied", possiblyBilled: false };
}

function classifyThrown(error: unknown): { kind: ProviderFailureKind; possiblyBilled: boolean } {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    // The request left the process, so the provider may have generated and billed it (§12.3).
    return { kind: "timeout", possiblyBilled: true };
  }
  return { kind: "connection", possiblyBilled: false };
}

async function readOutcomeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function post(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<Response | { failure: { kind: ProviderFailureKind; possiblyBilled: boolean } }> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { failure: classifyThrown(error) };
  }
}

function usageOf(reported: unknown): { inputUnits: number; outputUnits: number } | undefined {
  if (typeof reported !== "object" || reported === null) return undefined;
  const record = reported as Record<string, unknown>;
  const inputUnits = record["prompt_tokens"] ?? record["input_tokens"];
  const outputUnits = record["completion_tokens"] ?? record["output_tokens"];
  if (typeof inputUnits !== "number" || typeof outputUnits !== "number") return undefined;
  return { inputUnits, outputUnits };
}

export interface LocalBoxAdapterOptions {
  endpoint: ProviderEndpoint;
  /** Tunnel base URL from deployment configuration; the box is reachable inbound only (§13). */
  baseUrl: string;
  /**
   * The Cloudflare Access service token, read from the deployment's secrets at call time
   * (`wrangler secret`, plan §12.4 "Local box contract"). It is never stored in the repository and
   * never written to a log; absent means "do not send anything".
   */
  secrets: () => { tokenId: string; tokenSecret: string } | undefined;
  fetchImpl?: FetchImpl;
}

export function createLocalBoxAdapter(options: LocalBoxAdapterOptions): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headersOf = (): Record<string, string> | undefined => {
    const secrets = options.secrets();
    if (secrets === undefined) return undefined;
    return {
      "content-type": "application/json",
      "cf-access-key-id": secrets.tokenId,
      "cf-access-secret": secrets.tokenSecret,
    };
  };

  return {
    providerKey: options.endpoint.providerKey,
    async complete(request) {
      const headers = headersOf();
      if (headers === undefined) return { ok: false, kind: "provider_denied", possiblyBilled: false };
      const model = modelOf(request);
      if (model === undefined) return { ok: false, kind: "invalid_request", possiblyBilled: false };

      const response = await post(
        `${base}/v1/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputUnits,
            messages: request.messages.map((message) => ({ role: message.role, content: message.text })),
          }),
        },
        request.timeoutMs,
        fetchImpl,
      );
      if ("failure" in response) return { ok: false, ...response.failure };

      const body = await readOutcomeText(response);
      if (!response.ok) return { ok: false, ...classifyStatus(response.status, body), statusCode: response.status };

      const completion = asRecord(parseJson(body));
      const choice = asRecord(Array.isArray(completion?.["choices"]) ? completion["choices"][0] : undefined);
      const message = asRecord(choice?.["message"]);
      const text = message?.["content"];
      if (typeof text !== "string" || text.length === 0) {
        // The provider answered and generated: that is billed work with nothing usable in it.
        return { ok: false, kind: "invalid_output", possiblyBilled: true };
      }
      const usage = usageOf(completion?.["usage"]);
      return {
        ok: true,
        text,
        model,
        finishReason: choice?.["finish_reason"] === "length" ? "length" : "stop",
        ...(usage === undefined ? {} : { usage }),
      };
    },
    async health() {
      const headers = headersOf();
      if (headers === undefined) return false;
      const response = await post(`${base}/health`, { method: "GET", headers }, 5_000, fetchImpl);
      if ("failure" in response) return false;
      return response.ok;
    },
  };
}

export interface WorkersAiAdapterOptions {
  endpoint: ProviderEndpoint;
  accountId: string;
  /** Workers AI REST token from the deployment's secrets; absent means "do not send anything". */
  apiToken: () => string | undefined;
  fetchImpl?: FetchImpl;
}

export function createWorkersAiAdapter(options: WorkersAiAdapterOptions): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const runUrl = (model: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${encodeURIComponent(model)}`;

  return {
    providerKey: options.endpoint.providerKey,
    async complete(request) {
      // Read the binding when the call is made, not when the adapter is built. Workers resolves secret
      // bindings per request, so a factory-time read is wrong in both directions: a rotated token is
      // never seen, and an adapter built at a cold start that raced the binding would answer
      // `provider_denied` for the whole life of the isolate. The local box already reads its Access
      // headers per call for the same reason.
      const token = options.apiToken();
      if (token === undefined || token.length === 0) {
        return { ok: false, kind: "provider_denied", possiblyBilled: false };
      }
      const model = modelOf(request);
      if (model === undefined) return { ok: false, kind: "invalid_request", possiblyBilled: false };
      const response = await post(
        runUrl(model),
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            model,
            messages: request.messages.map((message) => ({ role: message.role, content: message.text })),
            max_tokens: request.maxOutputUnits,
          }),
        },
        request.timeoutMs,
        fetchImpl,
      );
      if ("failure" in response) return { ok: false, ...response.failure };

      const body = await readOutcomeText(response);
      if (!response.ok) return { ok: false, ...classifyStatus(response.status, body), statusCode: response.status };

      const envelope = asRecord(parseJson(body));
      if (envelope === undefined) return { ok: false, kind: "invalid_output", possiblyBilled: true };
      if (envelope["success"] !== true) {
        return { ok: false, ...classifyStatus(200, JSON.stringify(envelope["errors"] ?? "")) };
      }
      const result = asRecord(envelope["result"]);
      const text = result?.["response"];
      if (typeof text !== "string" || text.length === 0) {
        return { ok: false, kind: "invalid_output", possiblyBilled: true };
      }
      const usage = usageOf(result?.["usage"]);
      return {
        ok: true,
        text,
        model,
        finishReason: "stop",
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}

/**
 * T-115f: the Claude adapter, the provider `verify` starts at in M1 (plan §12.4 per-task chains,
 * issue #9). Plain `fetch` against the Messages shape like every other adapter here: no SDK is
 * installed, so the dependency count stays zero (AGENTS.md §6) and the import-boundary guard in
 * `provider-boundary.test.ts` stays the rule it claims to be.
 *
 * Three things this adapter never does:
 *
 * * **decide clearance.** The route already dropped any provider not cleared for this data class,
 *   and `request.dataClass` is informational here — branching on it would be a second, divergent
 *   copy of the matrix (§12.4, and this slice does not relax it).
 * * **substitute a model.** `request.model` is what the route chose — for a `verify` call the
 *   *evaluated verifier model*, deliberately not this endpoint's composing model. #76 was exactly
 *   an adapter ignoring that and using its own default, so the value goes on the wire verbatim and a
 *   request naming no model sends nothing.
 * * **repeat the provider's error body.** An Anthropic error carries a `message` that can name a key,
 *   an internal host or a fragment of the prompt. Its `type` classifies; its `message` stops here.
 *
 * It also registers **no `health()`**: a probe against a billed Messages endpoint spends the same
 * quota an answer needs, and passive F37 checks are T-314. `workers_ai` is registered without one for
 * the same reason — a provider with no probe is unprobed, not dead.
 */
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export interface ClaudeAdapterOptions {
  endpoint: ProviderEndpoint;
  /**
   * Defaults to the platform API. The override exists for the loopback harness (COORDINATION.md §6a)
   * and for a reviewed proxy — like the local box's tunnel base, it is deployment configuration and
   * is never taken from a request.
   */
  baseUrl?: string;
  /**
   * The Anthropic API key, read from the Worker's secret binding **when the call is made**, exactly
   * like the Workers AI token above: secret bindings are per-request, so a construction-time read
   * never sees a rotation and freezes a cold-start race into `provider_denied` for the life of the
   * isolate. It is never stored in the repository, never logged and never returned (T-004 §20.8 sets
   * it with `wrangler secret`; agents never handle the real value).
   */
  apiKey: () => string | undefined;
  fetchImpl?: FetchImpl;
}

/**
 * Anthropic's own error discriminator beats a bare status where they disagree: a 400 can mean our
 * request was malformed, our prompt was over the window, or the account is out of standing, and those
 * three need three different answers. An unrecognised type falls back to the shared status rule.
 */
function claudeFailure(
  status: number,
  errorType: string | undefined,
  observedMessage: string,
): { kind: ProviderFailureKind; possiblyBilled: boolean } {
  if (errorType === "rate_limit_error" || status === 429) return { kind: "rate_limited", possiblyBilled: false };
  if (errorType === "overloaded_error" || status >= 500) return { kind: "server_error", possiblyBilled: true };
  if (errorType === "authentication_error" || errorType === "permission_error" || status === 401 || status === 403) {
    return { kind: "provider_denied", possiblyBilled: false };
  }
  // A body the provider refused because it is too big is a payload fact, not a wiring bug: the chain
  // advances, and nothing was generated.
  if (errorType === "request_too_large" || status === 413) return { kind: "context_overflow", possiblyBilled: false };
  // A 400/404 saying *this request* is wrong, or naming a model that does not exist, is our wiring:
  // `invalid_request` stops the walk instead of handing the same broken body to the next provider and
  // then opening a circuit for a provider that is perfectly healthy (§12.4 chain rule (b)).
  if (errorType === "invalid_request_error" || errorType === "not_found_error" || status === 404) {
    if (CONTEXT_OVERFLOW_MARKERS.some((marker) => observedMessage.toLowerCase().includes(marker))) {
      return { kind: "context_overflow", possiblyBilled: false };
    }
    return { kind: "invalid_request", possiblyBilled: false };
  }
  return classifyStatus(status, observedMessage);
}

export function createClaudeAdapter(options: ClaudeAdapterOptions): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "");

  return {
    providerKey: options.endpoint.providerKey,
    async complete(request) {
      const apiKey = options.apiKey();
      if (apiKey === undefined || apiKey.length === 0) {
        // Fail closed before the socket: no key means no request, so no prompt leaves the process and
        // nothing is billable. The gateway reports the call as unavailable, never as a crash.
        return { ok: false, kind: "provider_denied", possiblyBilled: false };
      }
      const model = modelOf(request);
      if (model === undefined) return { ok: false, kind: "invalid_request", possiblyBilled: false };

      const systemTurns = request.messages.filter((message) => message.role === "system");
      const turns = request.messages.filter((message) => message.role !== "system");
      if (turns.length === 0) {
        // The Messages API needs at least one user or assistant turn. Sending an impossible shape would
        // land in the audit trail as a provider rejection; this is a request this gateway built wrong.
        return { ok: false, kind: "invalid_request", possiblyBilled: false };
      }

      const response = await post(
        `${base}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Anthropic's scheme is a header, not a Bearer credential: an `authorization` value here
            // would be a different provider's habit and would silently stop authenticating.
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model,
            // `max_tokens` is required by this API, and `maxOutputUnits` is the cap the stage asked
            // for — the same value the reservation was sized against (§12.3).
            max_tokens: request.maxOutputUnits,
            ...(systemTurns.length > 0 ? { system: systemTurns.map((message) => message.text).join("\n\n") } : {}),
            messages: turns.map((message) => ({ role: message.role, content: message.text })),
          }),
        },
        request.timeoutMs,
        fetchImpl,
      );
      if ("failure" in response) return { ok: false, ...response.failure };

      const body = await readOutcomeText(response);
      if (!response.ok) {
        const envelope = asRecord(parseJson(body));
        const error = asRecord(envelope?.["error"]);
        const errorType = typeof error?.["type"] === "string" ? (error["type"] as string) : undefined;
        const message = typeof error?.["message"] === "string" ? (error["message"] as string) : body;
        return { ok: false, ...claudeFailure(response.status, errorType, message), statusCode: response.status };
      }

      const completion = asRecord(parseJson(body));
      const blocks = Array.isArray(completion?.["content"]) ? completion["content"] : [];
      // A response can be several blocks; only `text` blocks are answer content, and a refusal to
      // produce any is unusable work, not an empty answer.
      const text = blocks
        .map((block) => {
          const record = asRecord(block);
          return record?.["type"] === "text" && typeof record["text"] === "string" ? record["text"] : "";
        })
        .join("");
      if (text.length === 0) return { ok: false, kind: "invalid_output", possiblyBilled: true };

      // `stop_reason: "max_tokens"` is the output cap: the text is a partial answer, and call.ts must
      // not read it as complete (it treats `length` as a failed attempt and keeps the liability).
      // An absent or unrecognised reason still reads as `stop` here — #87's `unknown` value belongs to
      // the slice that widens the union and the attempt record, and this one does not touch either.
      const stopReason = typeof completion?.["stop_reason"] === "string" ? (completion["stop_reason"] as string) : undefined;
      const usage = usageOf(completion?.["usage"]);
      return {
        ok: true,
        text,
        model,
        finishReason: stopReason === "max_tokens" ? "length" : "stop",
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
