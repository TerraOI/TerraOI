import type { DataClass } from "@/contracts/data-class";
import type { ProviderKey } from "@/contracts/keys";
import type { ClearanceMatrix } from "@/contracts/provider-route";
import type { TenantContext } from "@/contracts/tenant-context";

import { callModelGateway, type GatewayDeps } from "@/platform/gateway/call";

/**
 * F30 `condenseQuery` — rewrite a follow-up into a standalone search query (plan §8.1 step 5).
 *
 * History is **injected** (F17 / Lane 1). This module never reads chat tables (T-104). Condensation
 * is a search rewrite only: the original question stays for composition; both strings are recorded.
 */

/** One F17 turn the asker is authorized to see. */
export type AuthorizedHistoryTurn = {
  role: "user" | "assistant";
  text: string;
  /** Must equal `TenantContext.userId` — another user's turn is refused, not rewritten. */
  conversationUserId: string;
};

export type CondenseExpertPolicy = {
  key: string;
  version: string;
  modelChains: { condense: readonly ProviderKey[] };
  limits: { maxOutputTokens: number; stageDeadlineMs: number };
};

export type CondenseInput = {
  context: TenantContext;
  runId: string;
  followUp: string;
  authorizedHistory: readonly AuthorizedHistoryTurn[];
  expert: CondenseExpertPolicy;
  dataClass: DataClass;
  tenantPolicy?: Partial<ClearanceMatrix>;
};

export type CondenseSkipReason =
  | "unauthorized_history"
  | "unavailable"
  | "empty"
  | "oversized"
  | "invented_entity"
  | "scope_widened";

export type CondenseResult =
  | {
      status: "condensed";
      originalQuery: string;
      searchedQuery: string;
      via: "model";
    }
  | {
      status: "skipped";
      originalQuery: string;
      /** Raw follow-up plus last authorized user turn when available (plan §8.1). */
      searchedQuery: string;
      reason: CondenseSkipReason;
    };

export type CondenseDeps = GatewayDeps;

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Synthetic fixture / equipment ids the model must not invent. */
const ENTITY_RE = /\bSYNTH-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;

/** ~4 chars per token upper bound for the oversized guard (conservative). */
function maxCharsForTokens(tokens: number): number {
  return Math.max(32, tokens * 4);
}

function lastUserTurn(history: readonly AuthorizedHistoryTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role === "user") return turn.text;
  }
  return null;
}

function fallbackSearchedQuery(
  followUp: string,
  history: readonly AuthorizedHistoryTurn[],
): string {
  const prior = lastUserTurn(history);
  return prior === null ? followUp : `${prior}\n${followUp}`;
}

function skipped(
  followUp: string,
  history: readonly AuthorizedHistoryTurn[],
  reason: CondenseSkipReason,
): CondenseResult {
  return {
    status: "skipped",
    originalQuery: followUp,
    searchedQuery: fallbackSearchedQuery(followUp, history),
    reason,
  };
}

function historyCorpus(history: readonly AuthorizedHistoryTurn[], followUp: string): string {
  return `${history.map((t) => t.text).join("\n")}\n${followUp}`;
}

function inventsEntity(condensed: string, allowedCorpus: string): boolean {
  const allowed = new Set(
    (allowedCorpus.match(ENTITY_RE) ?? []).map((token) => token.toUpperCase()),
  );
  for (const token of condensed.match(ENTITY_RE) ?? []) {
    if (!allowed.has(token.toUpperCase())) return true;
  }
  return false;
}

function widensProjectScope(
  condensed: string,
  allowedCorpus: string,
  permittedProjectIds: readonly string[],
): boolean {
  const permitted = new Set(permittedProjectIds.map((id) => id.toLowerCase()));
  const inCorpus = new Set(
    (allowedCorpus.match(UUID_RE) ?? []).map((id) => id.toLowerCase()),
  );
  for (const id of condensed.match(UUID_RE) ?? []) {
    const lower = id.toLowerCase();
    if (permitted.has(lower) || inCorpus.has(lower)) continue;
    return true;
  }
  return false;
}

/**
 * Rewrite `followUp` into a standalone search query using only authorized history.
 * Never feeds condensation into composition — callers keep `originalQuery` for that.
 */
export async function condenseQuery(
  input: CondenseInput,
  deps: CondenseDeps,
): Promise<CondenseResult> {
  const followUp = input.followUp.trim();
  const history = input.authorizedHistory;

  for (const turn of history) {
    if (turn.conversationUserId !== input.context.userId) {
      return skipped(followUp, history, "unauthorized_history");
    }
  }

  const gateway = await callModelGateway(
    {
      context: input.context,
      runId: input.runId,
      task: "condense",
      dataClass: input.dataClass,
      messages: [
        {
          role: "system",
          text: [
            "Rewrite the follow-up into one standalone search query.",
            "Use only the authorized history and the follow-up.",
            "Do not invent identifiers, project ids, collection ids, or fixture names.",
            "Reply with the query text only — no preamble.",
          ].join(" "),
        },
        {
          role: "user",
          text: [
            "Authorized history:",
            ...history.map((turn) => `${turn.role}: ${turn.text}`),
            "",
            `Follow-up: ${followUp}`,
          ].join("\n"),
        },
      ],
      maxOutputUnits: input.expert.limits.maxOutputTokens,
      callTimeoutMs: Math.min(10_000, input.expert.limits.stageDeadlineMs),
      stageDeadlineMs: input.expert.limits.stageDeadlineMs,
      chain: input.expert.modelChains.condense,
      tenantPolicy: input.tenantPolicy,
    },
    deps,
  );

  if (!gateway.ok) {
    return skipped(followUp, history, "unavailable");
  }

  const condensed = gateway.text.trim();
  if (condensed.length === 0) {
    return skipped(followUp, history, "empty");
  }
  if (condensed.length > maxCharsForTokens(input.expert.limits.maxOutputTokens)) {
    return skipped(followUp, history, "oversized");
  }

  const corpus = historyCorpus(history, followUp);
  if (inventsEntity(condensed, corpus)) {
    return skipped(followUp, history, "invented_entity");
  }
  if (widensProjectScope(condensed, corpus, input.context.permittedProjectIds)) {
    return skipped(followUp, history, "scope_widened");
  }

  return {
    status: "condensed",
    originalQuery: followUp,
    searchedQuery: condensed,
    via: "model",
  };
}
