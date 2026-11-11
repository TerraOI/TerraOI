import type { TenantContext } from "@/contracts/tenant-context";

/**
 * `withTenantRpc` — the one way this repository calls a tenant-scoped RPC (T-101c; FAQ-0011; plan
 * §4.3:245-249; §11 F03; #163 ruling).
 *
 * **One call, one transaction.** A tenant-scoped RPC takes `p_organisation_id` and establishes its
 * own transaction-local scope as its first statement, so this helper's whole job is to put the
 * organisation from `TenantContext` — and nothing else — into that argument, and to dial PostgREST
 * **as the signed-in user**. `auth.uid()`, the membership check inside the scope helper and RLS then
 * behave exactly as the merged SQL assumes (ADR-0003 §7).
 *
 * Four things this module never does:
 *
 * 1. **Take the tenant from anywhere but the context.** `p_organisation_id` is not a legal argument:
 *    `TenantRpcArgs` makes it a compile error, and the body is assembled with the context's value
 *    *last*, so even an object that reached the call through a cast cannot pick the tenant. A
 *    context whose organisation is not an id is refused rather than forwarded. The argument only
 *    *selects* a tenant; the merged membership check decides (#163).
 * 2. **Carry a scope between calls.** No scope helper is ever dialled as a request of its own, no
 *    session variable is set from here, and there is no module-level mutable: two interleaved
 *    contexts are two independent requests (F03). That is the reason FAQ-0011 exists — one PostgREST
 *    request is one transaction, and a previous call's setting does not reach the next one.
 * 3. **Hold a credential.** The bearer on the request is the caller's user access token, passed in
 *    per call and read at call time. Nothing here touches a deployment secret, a publishable key or
 *    a privileged key, and nothing here has a default host: the PostgREST base is configuration, and
 *    an unbound base means no request leaves the process.
 * 4. **Repeat what the database said.** A PostgREST error body can name a role, a schema, a pooler
 *    host or a row. Its `code` classifies; the rest stops here, so it cannot reach a run record, a
 *    log line or an employee-visible message.
 *
 * Failure vocabulary (the caller decides what an employee sees, from `SAFE_TENANT_RPC_MESSAGE` or
 * its own copy of it):
 *
 * - `tenancy` — SQLSTATE `28000` or `42501`: the scope helper refused this user, or the grant is
 *   missing. Never an empty result and never `no_accessible_evidence`: "no rows" and "not allowed"
 *   are different answers, and collapsing them is how a tenancy bug reads as a quiet empty page.
 * - `backend_failure` — transport, timeout, 5xx, a rejected request, or a body that is not JSON. An
 *   expired session arrives here too (`PGRST301` is not a SQLSTATE); refreshing it is T-102's job,
 *   not this helper's.
 * - `not_configured` — this deployment or caller is wired wrong, and **nothing was dialled**. Kept
 *   apart from `backend_failure` for the reason `site/handle-pilot-inquiry.ts` gives: an operator has
 *   to be able to tell a missing binding from a down backend.
 *
 * `data` is `unknown` on purpose: this helper is a transport, not a schema. Each caller validates
 * what its RPC returns with Zod at its own boundary (AGENTS.md §2).
 */

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** The tenant argument, named once so an RPC packet can cite the same string (FAQ-0011 rule 1). */
export const TENANT_ARGUMENT = "p_organisation_id";

/**
 * What a caller may pass. The tenant key is the helper's own, so it is not assignable here
 * (`string` is not `never`): choosing the tenant is a **compile error**, and the acceptance test
 * pins that with `// @ts-expect-error` — an unused directive is itself a typecheck failure, so the
 * pin cannot rot.
 */
export type TenantRpcArgs = Record<string, unknown> & { p_organisation_id?: never };

export interface TenantRpcConfig {
  /**
   * Where PostgREST lives, from deployment configuration — **no default host** (a built-in one would
   * be a host literal doing authorization-adjacent work). An unbound or malformed base is a named
   * refusal with no request. Plain http is accepted only for loopback, which is what the COORDINATION
   * §6a harness dials; anywhere else is https.
   */
  postgrestBaseUrl: string | undefined;
  /** Injectable for unit tests. The loopback harness leaves it out and uses the real `fetch`. */
  fetchImpl?: FetchImpl;
  /** Bounds connect + send + read. A Worker request must not hang on a quiet database. */
  timeoutMs?: number;
}

/** The SQLSTATEs that mean "the scope refused this user" (FAQ-0011, `20261105060000_tenancy_core.sql`). */
const TENANCY_SQLSTATES = ["28000", "42501"] as const;
export type TenancySqlState = (typeof TENANCY_SQLSTATES)[number];

export type BackendFailureReason = "transport" | "timeout" | "server_error" | "rejected" | "invalid_response";

export type NotConfiguredReason =
  | "postgrest_base_unbound"
  | "postgrest_base_invalid"
  | "access_token_unbound"
  | "access_token_invalid"
  | "context_invalid"
  | "rpc_name_invalid"
  | "scope_helper_forbidden";

export type TenantRpcFailure =
  | { ok: false; kind: "tenancy"; sqlstate: TenancySqlState }
  | { ok: false; kind: "backend_failure"; reason: BackendFailureReason }
  | { ok: false; kind: "not_configured"; reason: NotConfiguredReason };

export type TenantRpcOutcome = { ok: true; data: unknown } | TenantRpcFailure;

/**
 * Employee-visible text, in the shape of `SAFE_FAILURE_MESSAGE` in `resolve-tenant-context.ts`. It
 * names no tenant, no table, no SQLSTATE and no provider, and a missing binding is deliberately the
 * same sentence as an outage.
 */
export const SAFE_TENANT_RPC_MESSAGE: Record<TenantRpcFailure["kind"], string> = {
  tenancy: "You do not have access to this workspace.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};

/** A Postgres identifier, and nothing else: this value is dialled into the request path. */
const RPC_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/**
 * The scope helpers themselves (FAQ-0011): they run **inside** a scoped RPC, as its first statement,
 * in the same transaction as its work. Dialling one as a request of its own would open a second
 * transaction whose setting the work never sees, which is precisely the bug FAQ-0011 and #163 exist
 * to prevent — so a caller cannot ask for them here, and one call stays one RPC call.
 */
const FORBIDDEN_RPC: readonly string[] = ["set_tenant_scope", "clear_tenant_scope"];
const ORGANISATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A bearer that can be a header value at all: printable, no space, no CR/LF injection surface. */
const BEARER_TOKEN = /^[!-~]+$/;
// Closed vocabulary, not state: no module-level mutable holds anything per call, per connection or
// per process (F03 — that is the leak FAQ-0011 closes).
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];
const DEFAULT_TIMEOUT_MS = 10_000;

function tenancySqlState(code: unknown): TenancySqlState | undefined {
  if (typeof code !== "string") return undefined;
  for (const state of TENANCY_SQLSTATES) if (code === state) return state;
  return undefined;
}

function resolveBase(raw: string | undefined): { ok: true; base: string } | { ok: false; reason: NotConfiguredReason } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) return { ok: false, reason: "postgrest_base_unbound" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "postgrest_base_invalid" };
  }
  if (url.protocol === "https:") return { ok: true, base: trimmed };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return { ok: true, base: trimmed };
  return { ok: false, reason: "postgrest_base_invalid" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A thrown transport error is a fact about the connection, never text to hand on. */
function thrownReason(error: unknown): BackendFailureReason {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "transport";
}

/**
 * One tenant-scoped RPC: a single POST to the named function's rpc path, carrying the caller's
 * arguments plus `p_organisation_id` from the context, authenticated as the signed-in user.
 */
export async function withTenantRpc(
  ctx: TenantContext,
  name: string,
  args: TenantRpcArgs,
  token: string | null | undefined,
  config: TenantRpcConfig,
): Promise<TenantRpcOutcome> {
  // The context is the only source of the tenant, and an unparsed context is a wiring bug: refuse
  // rather than dial an id the database would only refuse later.
  const organisationId = ctx?.organisationId;
  if (typeof organisationId !== "string" || !ORGANISATION_ID.test(organisationId)) {
    return { ok: false, kind: "not_configured", reason: "context_invalid" };
  }
  if (typeof name !== "string" || !RPC_NAME.test(name)) {
    return { ok: false, kind: "not_configured", reason: "rpc_name_invalid" };
  }
  if (FORBIDDEN_RPC.includes(name)) {
    return { ok: false, kind: "not_configured", reason: "scope_helper_forbidden" };
  }
  const base = resolveBase(config.postgrestBaseUrl);
  if (!base.ok) return { ok: false, kind: "not_configured", reason: base.reason };
  if (token === undefined || token === null || token.trim().length === 0) {
    return { ok: false, kind: "not_configured", reason: "access_token_unbound" };
  }
  if (!BEARER_TOKEN.test(token)) {
    return { ok: false, kind: "not_configured", reason: "access_token_invalid" };
  }

  // The caller's arguments first, the context's organisation last: the tenant key cannot be shadowed
  // by anything the caller built, even through a cast.
  const body = JSON.stringify({ ...args, [TENANT_ARGUMENT]: organisationId });
  const url = `${base.base.replace(/\/+$/, "")}/rpc/${name}`;
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // The user's own credential, read when the call is made — the same reason the gateway reads
        // its secret bindings per call (ADR-0003 §7).
        authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return { ok: false, kind: "backend_failure", reason: thrownReason(error) };
  }

  if (!response.ok) {
    // Only a failed answer is read as a diagnosis, and only for its SQLSTATE: an RPC row that happens
    // to carry a `code` column equal to a SQLSTATE must not be mistaken for a refusal.
    const refused = tenancySqlState(asRecord(parseJson(text))?.["code"]);
    if (refused !== undefined) {
      // The SQLSTATE is the fact, and it outranks the status: a scope refusal must never be read as
      // "no rows", whatever number PostgREST chose to answer it with.
      return { ok: false, kind: "tenancy", sqlstate: refused };
    }
    return {
      ok: false,
      kind: "backend_failure",
      reason: response.status >= 500 ? "server_error" : "rejected",
    };
  }
  if (text.trim().length === 0) return { ok: true, data: null };
  const data = parseJson(text);
  if (data === undefined) return { ok: false, kind: "backend_failure", reason: "invalid_response" };
  return { ok: true, data };
}
