import { z } from "zod";

import { Answer } from "@/contracts/answer";
import { DataClass } from "@/contracts/data-class";
import type { TenantContext } from "@/contracts/tenant-context";
import {
  withTenantRpc,
  type FetchImpl,
  type TenantRpcArgs,
  type TenantRpcOutcome,
} from "@/platform/tenancy/tenant-rpc";

/**
 * The chat persistence port, and its PostgREST implementation over `withTenantRpc` — the one
 * sanctioned way to call a tenant-scoped RPC (T-101c, FAQ-0011, #163).
 *
 * Every method here maps one-to-one onto an RPC that `20261113020000_chat_persistence.sql` creates,
 * and that migration's suite is `035_chat_persistence.test.sql`. The pairing is the design: the SQL
 * owns every authorization decision (tenant scope, active membership, the `chat.ask` permission area,
 * conversation ownership, project audience, source readability, data class), and this module is a
 * transport that cannot change any of them. It sends no `p_organisation_id` of its own —
 * `TenantRpcArgs` makes that a compile error and the helper spreads the context's value last
 * (`tenant-rpc.ts:200-202`) — and it forges no actor, because no chat RPC takes a user parameter at
 * all: the database takes the actor from `auth.uid()` off the caller's own bearer.
 *
 * What a transport still owes, and what this module adds:
 *
 * 1. **A named failure vocabulary.** `withTenantRpc` reports `tenancy` for both SQLSTATE 28000 and
 *    42501. Those are different answers to different questions — "your session does not reach this
 *    tenant" and "that row is not yours, or that citation is not readable" — and the caller turns
 *    them into different surfaces (a sign-in prompt, or a generic refusal). Collapsing them is how a
 *    tenancy bug reads as a quiet empty page, which is what `tenant-rpc.ts:40-41` warns about.
 * 2. **A schema at the boundary.** `TenantRpcOutcome.data` is `unknown` by design, so each read is
 *    parsed here with Zod: an unexpected row shape becomes a `backend` failure rather than an
 *    `undefined` that propagates into an answer. AGENTS.md §2, applied to the database as much as to
 *    HTTP.
 *
 * The `answer` of a completed run is validated against the merged `Answer` contract, so nothing that
 * contract forbids — a provider name, a model id, a signed URL, a span the platform did not derive —
 * can ride back out of the database into a browser through this module (contracts/answer.ts, plan
 * §4.4, #10). The migration adds a second, independent guard on the same write.
 */

export type StoreFailure =
  /** No session identity, or no active membership in the tenant the context named (SQLSTATE 28000). */
  | "membership"
  /** The row is not yours, a citation is not readable, or the `chat.ask` area is missing (42501). */
  | "refused"
  /** Transport, timeout, 5xx, or a body that does not parse (fail closed, never a partial answer). */
  | "backend"
  /** This deployment is not wired: no base URL, no token, a malformed context. Nothing was dialled. */
  | "not_configured";

export type StoreResult<T> = { ok: true; value: T } | { ok: false; kind: StoreFailure; detail: string };

/**
 * Row timestamps are what PostgREST sends for a `timestamptz` column — `2026-11-13 09:00:00+00`, not
 * an ISO-8601 `T`/`Z` string — so this is a length-bounded string, not `z.iso.datetime()`, and nothing
 * downstream parses it. Inside an `answer` jsonb the `asOf` **is** ISO, because the Worker wrote it
 * (contracts/answer.ts), and the `Answer` schema enforces that where it appears.
 */
const RowTimestamp = z.string().min(1).max(64);

/** The nested run object `chat_load_conversation_v1` attaches to an assistant message. */
const RunSummaryShape = z.strictObject({
  id: z.uuid(),
  status: z.enum(["running", "answered", "partial", "refused", "unavailable"]),
  answerStatus: z.string().nullable(),
  dataClass: DataClass,
  policyRevision: z.number().int().nonnegative(),
  expertVersions: z.array(z.string()),
  corpusGenerations: z.array(z.number().int()),
  asOf: RowTimestamp,
  answer: Answer.nullable(),
});
export type StoredRunSummary = z.infer<typeof RunSummaryShape>;

/** The full run `chat_get_run_v1` returns — the resume read. */
const RunShape = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  status: z.enum(["running", "answered", "partial", "refused", "unavailable"]),
  answerStatus: z.string().nullable(),
  dataClass: DataClass,
  policyRevision: z.number().int().nonnegative(),
  expertKey: z.string().min(1).max(64),
  expertVersions: z.array(z.string()),
  corpusGenerations: z.array(z.number().int()),
  asOf: RowTimestamp,
  answer: Answer.nullable(),
  startedAt: RowTimestamp,
  completedAt: RowTimestamp.nullable(),
});
export type StoredRun = z.infer<typeof RunShape>;

const ConversationShape = z.strictObject({
  id: z.uuid(),
  expertKey: z.string().min(1).max(64),
  projectId: z.uuid().nullable(),
  status: z.enum(["open", "closed"]),
  createdAt: RowTimestamp,
  lastActivityAt: RowTimestamp,
});
export type StoredConversation = z.infer<typeof ConversationShape>;

const MessageShape = z.strictObject({
  id: z.uuid(),
  seq: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  bodyText: z.string().min(1),
  dataClass: DataClass,
  createdAt: RowTimestamp,
  runId: z.uuid().nullable(),
  run: RunSummaryShape.nullable(),
});
export type StoredMessage = z.infer<typeof MessageShape>;

export const HistoryShape = z.strictObject({
  conversation: ConversationShape,
  messages: z.array(MessageShape),
});
export type ConversationHistory = z.infer<typeof HistoryShape>;

const CompletedShape = z.strictObject({
  runId: z.uuid(),
  conversationId: z.uuid(),
  messageId: z.uuid(),
  status: z.enum(["answered", "partial", "refused", "unavailable"]),
  dataClass: DataClass,
  completedAt: RowTimestamp,
});
export type CompletedRun = z.infer<typeof CompletedShape>;

/** What one run may ask of the database: the seven RPCs this migration creates, and no other. */
export const CHAT_RPCS = {
  ensureConversation: "chat_ensure_conversation_v1",
  appendUserMessage: "chat_append_user_message_v1",
  startRun: "chat_start_run_v1",
  completeRun: "chat_complete_run_v1",
  getRun: "chat_get_run_v1",
  loadConversation: "chat_load_conversation_v1",
  listConversations: "chat_list_conversations_v1",
} as const;

export interface ChatStore {
  ensureConversation(
    context: TenantContext,
    input: { conversationId: string; expertKey: string; projectId: string | null },
  ): Promise<StoreResult<string>>;
  appendUserMessage(
    context: TenantContext,
    input: { conversationId: string; clientMessageId: string; bodyText: string; dataClass: DataClass },
  ): Promise<StoreResult<string>>;
  startRun(
    context: TenantContext,
    input: {
      runId: string;
      conversationId: string;
      idempotencyKey: string;
      expertKey: string;
      userMessageId: string;
      dataClass: DataClass;
    },
  ): Promise<StoreResult<string>>;
  completeRun(
    context: TenantContext,
    input: { runId: string; answer: z.infer<typeof Answer> },
  ): Promise<StoreResult<CompletedRun>>;
  getRun(context: TenantContext, input: { runId: string }): Promise<StoreResult<StoredRun>>;
  loadConversation(
    context: TenantContext,
    input: { conversationId: string },
  ): Promise<StoreResult<ConversationHistory>>;
  listConversations(context: TenantContext, input: { limit: number }): Promise<StoreResult<{ conversations: StoredConversation[] }>>;
}

// ---------------------------------------------------------------- failure mapping
function refused(outcome: Extract<TenantRpcOutcome, { ok: false }>, rpc: string): StoreResult<never> {
  if (outcome.kind === "tenancy") {
    // 28000 and 42501 are different answers, and both are named rather than merged (see header).
    return {
      ok: false,
      kind: outcome.sqlstate === "28000" ? "membership" : "refused",
      // `detail` is for operators only: the SQLSTATE, never the database's own words, which
      // `withTenantRpc` already discards (`tenant-rpc.ts:32-34`).
      detail: `${rpc}:${outcome.sqlstate}`,
    };
  }
  if (outcome.kind === "not_configured") return { ok: false, kind: "not_configured", detail: `${rpc}:${outcome.reason}` };
  return { ok: false, kind: "backend", detail: `${rpc}:${outcome.reason}` };
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown, rpc: string): StoreResult<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) return { ok: false, kind: "backend", detail: `${rpc}:unparsable` };
  return { ok: true, value: parsed.data };
}

export interface ChatStoreConfig {
  /** Where PostgREST lives, from deployment configuration — no default host (`tenant-rpc.ts:69-73`). */
  postgrestBaseUrl: string | undefined;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * The store for one request. The access token is bound here rather than passed per call, so the only
 * credential in scope is the signed-in user's own and no call site can supply a different one by
 * accident; `withTenantRpc` still reads it at call time (`tenant-rpc.ts:214-217`). A null token is
 * legal input and produces `not_configured` with nothing dialled.
 */
export function createChatStore(
  deps: { accessToken: string | null | undefined },
  config: ChatStoreConfig,
): ChatStore {
  const rpcConfig = {
    postgrestBaseUrl: config.postgrestBaseUrl,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  };

  async function call(rpc: string, context: TenantContext, args: TenantRpcArgs): Promise<TenantRpcOutcome> {
    return withTenantRpc(context, rpc, args, deps.accessToken, rpcConfig);
  }

  async function oneUuid(rpc: string, context: TenantContext, args: TenantRpcArgs): Promise<StoreResult<string>> {
    const outcome = await call(rpc, context, args);
    if (!outcome.ok) return refused(outcome, rpc);
    const parsed = z.uuid().safeParse(outcome.data);
    if (!parsed.success) return { ok: false, kind: "backend", detail: `${rpc}:unparsable` };
    return { ok: true, value: parsed.data };
  }

  return {
    async ensureConversation(context, input) {
      return oneUuid(CHAT_RPCS.ensureConversation, context, {
        p_conversation_id: input.conversationId,
        p_expert_key: input.expertKey,
        p_project_id: input.projectId,
      });
    },

    async appendUserMessage(context, input) {
      return oneUuid(CHAT_RPCS.appendUserMessage, context, {
        p_conversation_id: input.conversationId,
        p_client_message_id: input.clientMessageId,
        p_body_text: input.bodyText,
        p_data_class: input.dataClass,
      });
    },

    async startRun(context, input) {
      return oneUuid(CHAT_RPCS.startRun, context, {
        p_run_id: input.runId,
        p_conversation_id: input.conversationId,
        p_idempotency_key: input.idempotencyKey,
        p_expert_key: input.expertKey,
        p_user_message_id: input.userMessageId,
        p_data_class: input.dataClass,
      });
    },

    async completeRun(context, input) {
      const rpc = CHAT_RPCS.completeRun;
      const outcome = await call(rpc, context, { p_run_id: input.runId, p_answer: input.answer });
      if (!outcome.ok) return refused(outcome, rpc);
      return parseWith(CompletedShape, outcome.data, rpc);
    },

    async getRun(context, input) {
      const rpc = CHAT_RPCS.getRun;
      const outcome = await call(rpc, context, { p_run_id: input.runId });
      if (!outcome.ok) return refused(outcome, rpc);
      return parseWith(RunShape, outcome.data, rpc);
    },

    async loadConversation(context, input) {
      const rpc = CHAT_RPCS.loadConversation;
      const outcome = await call(rpc, context, { p_conversation_id: input.conversationId });
      if (!outcome.ok) return refused(outcome, rpc);
      return parseWith(HistoryShape, outcome.data, rpc);
    },

    async listConversations(context, input) {
      const rpc = CHAT_RPCS.listConversations;
      const outcome = await call(rpc, context, { p_limit: input.limit });
      if (!outcome.ok) return refused(outcome, rpc);
      return parseWith(z.strictObject({ conversations: z.array(ConversationShape) }), outcome.data, rpc);
    },
  };
}

/**
 * Employee-visible text for a store failure, in the shape the tenancy and RPC helpers already use.
 * It names no table, no row, no SQLSTATE and no provider, and a missing binding is deliberately the
 * same sentence as an outage (`SAFE_TENANT_RPC_MESSAGE`, `SAFE_FAILURE_MESSAGE`).
 */
export const STORE_MESSAGE: Record<StoreFailure, string> = {
  membership: "Please sign in to continue.",
  refused: "You do not have access to this conversation.",
  backend: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};
