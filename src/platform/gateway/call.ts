import type { ProgressEvent, TierChangeReason } from "@/contracts/chat";
import type { DataClass } from "@/contracts/data-class";
import type { CapabilityTier, ClearanceMatrix, TaskClass } from "@/contracts/provider-route";
import type { ProviderKey } from "@/contracts/keys";
import type { TenantContext } from "@/contracts/tenant-context";

import type { AdapterCallOutcome, ModelMessage, ProviderAdapter, ProviderFailureKind } from "./adapters";
import type { GatewayConfiguration } from "./config";
import type { HealthWriter } from "./circuit";
import {
  selectModelRoute,
  type HealthReader,
  type RouteDecision,
  type RouteRequest,
} from "./route";

/**
 * F20 = F31 + F38 (plan §11 table, §12.4 chain walking, §12.3 reservations). Given a task class and
 * a classified payload: ask the route for the eligible chain, call the first provider that answers,
 * advance on the listed failures, and meter **every** attempt — including the free tiers.
 *
 * What this function never does: relax a clearance rule to find a provider, reorder a chain, retry
 * the same provider, or let a provider's own error text escape. The `attempts` and `skipped` lists
 * it returns are run-audit content (F40): they name providers, so they must never be rendered to an
 * employee. Employee-visible output is `UNAVAILABLE_MESSAGE` and the closed-enum `ProgressEvent`
 * below (§9.3, issue #16 N5).
 */

/** Employee-visible. Names no provider, model, tenant or reason an employee could probe with (§9.3). */
export const UNAVAILABLE_MESSAGE =
  "The assistant could not answer this question right now. Please try again shortly.";

/** A conservative pre-call estimate in units, so free-tier exhaustion is predicted, not discovered (§12.3). */
function estimateInputUnits(messages: readonly ModelMessage[]): number {
  const chars = messages.reduce((total, message) => total + message.text.length, 0);
  return Math.ceil((chars / 4) * 1.1);
}

export interface MeterPort {
  /** F19 reservation before the call. Throwing means the authority is unavailable → fail closed. */
  reserve(input: {
    organisationId: string;
    runId: string;
    attemptId: string;
    task: TaskClass;
    providerKey: ProviderKey;
    maxInputUnits: number;
    maxOutputUnits: number;
  }): Promise<{ reservationId: string }>;
  /** After the call: settled, released (nothing was spent) or ambiguous (may already be spent). */
  reconcile(input: {
    attemptId: string;
    reservationId: string;
    outcome: "settled" | "released" | "ambiguous";
    usedInputUnits?: number;
    usedOutputUnits?: number;
  }): Promise<void>;
}

export interface OutputSchema<T> {
  parse(data: unknown): T;
}

interface GatewayCallInputBase<T> {
  /** AGENTS.md §4.1: the only source of the organisation. There is deliberately no `organisationId`. */
  context: TenantContext;
  runId: string;
  conversationId?: string;
  /** Highest class among the payload's dependencies, computed with `maxDataClass` by the caller. */
  dataClass: DataClass;
  messages: readonly ModelMessage[];
  maxOutputUnits: number;
  callTimeoutMs: number;
  stageDeadlineMs: number;
  /** The tenant's recorded narrowing, resolved server-side — never from a request (§12.4). */
  tenantPolicy?: Partial<ClearanceMatrix>;
  chain?: readonly ProviderKey[];
  minTier?: CapabilityTier;
  outputSchema?: OutputSchema<T>;
  nowMs?: number;
}

/** A model call that is not a verification has no composer to name (§12.4 rule (e)). */
export interface ModelCallInput<T> extends GatewayCallInputBase<T> {
  task: "route" | "condense" | "compose";
  composedWith?: never;
}

/**
 * A verification must say who composed the answer and at which tier it must be verified: making
 * those required here is what stops rule (d)/(e) from depending on a caller remembering an optional
 * argument. The route layer repeats the check for arguments that arrive unvalidated.
 */
export interface VerifierCallInput<T> extends GatewayCallInputBase<T> {
  task: "verify";
  composedWith: { providerKey: ProviderKey; model: string };
  minTier: CapabilityTier;
  /** Which verification this is — a claim index or pass id. Two verifies at one chain position must
   *  not share an attempt id, and a replay of one must keep it (§12.3). */
  passTag?: string;
}

export type GatewayCallInput<T> = ModelCallInput<T> | VerifierCallInput<T>;

export interface GatewayDeps {
  config: GatewayConfiguration;
  adapters: {
    get(providerKey: ProviderKey): ProviderAdapter | undefined;
    has(providerKey: ProviderKey): boolean;
  };
  health: HealthReader & HealthWriter;
  meter: MeterPort;
  onProgress?: (event: ProgressEvent) => void;
  /** Injectable clock, so the audit trail and the tests agree on when something happened. */
  clock?: () => number;
}

export interface AttemptRecord {
  attemptId: string;
  providerKey: ProviderKey;
  chainPosition: number;
  capabilityTier: CapabilityTier;
  outcome: "answered" | ProviderFailureKind;
  reservedUnits: { maxInputUnits: number; maxOutputUnits: number };
  reconciled: "settled" | "released" | "ambiguous" | null;
  model: string | null;
  statusCode?: number;
}

export type GatewayUnavailableReason =
  | "no_eligible_provider"
  | "all_attempts_failed"
  | "deadline"
  | "budget_authority_unavailable";

export type GatewayCallResult<T> =
  | {
      ok: true;
      providerKey: ProviderKey;
      model: string;
      chainPosition: number;
      capabilityTier: CapabilityTier;
      text: string;
      parsed: T | undefined;
      usage: { inputUnits: number; outputUnits: number } | null;
      attempts: AttemptRecord[];
      skipped: RouteDecision["skipped"];
      matrixRevision: number;
    }
  | {
      ok: false;
      status: "unavailable";
      reason: GatewayUnavailableReason;
      attempts: AttemptRecord[];
      skipped: RouteDecision["skipped"];
      matrixRevision: number;
    };

/** Closed mapping: provider failure → the employee-visible reason code (§9.3, issue #16 N5). */
const FAILURE_TO_PROGRESS_REASON: Record<ProviderFailureKind, TierChangeReason> = {
  connection: "provider_unavailable",
  timeout: "provider_unavailable",
  server_error: "provider_unavailable",
  provider_denied: "provider_unavailable",
  rate_limited: "quota_exhausted",
  context_overflow: "output_rejected",
  invalid_output: "output_rejected",
};

/** JSON the model was asked to produce, tolerating a code fence around it. */
function extractStructured(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return undefined;
  }
}

function attemptIdOf(runId: string, chainPosition: number, task: string, passTag: string | undefined): string {
  // A (run, chain position) pair is not a call. One position can hold a compose **and** a per-claim
  // verify, and their reservations must not satisfy or double-book each other (§12.3), so the id names
  // the call. A replay of the same call still deduplicates, which is the property the pair alone
  // appeared to provide.
  const role = task === "verify" ? `verify:${passTag ?? "single"}` : task;
  return `${runId}:${chainPosition}:${role}`;
}

function parseWith<T>(schema: OutputSchema<T> | undefined, text: string): T | undefined {
  if (schema === undefined) return undefined;
  try {
    return schema.parse(extractStructured(text));
  } catch {
    return undefined;
  }
}

export async function callModelGateway<T>(
  input: GatewayCallInput<T>,
  deps: GatewayDeps,
): Promise<GatewayCallResult<T>> {
  const clock = deps.clock ?? Date.now;
  const startedAtMs = clock();
  const deadlineAtMs = startedAtMs + input.stageDeadlineMs;

  const common = {
    dataClass: input.dataClass,
    tenantPolicy: input.tenantPolicy,
    chain: input.chain,
    minTier: input.minTier,
    nowMs: input.nowMs ?? startedAtMs,
  };
  const routeRequest: RouteRequest =
    input.task === "verify"
      ? { ...common, task: "verify", composedWith: input.composedWith, minTier: input.minTier }
      : { ...common, task: input.task };

  const decision = selectModelRoute(routeRequest, {
    config: deps.config,
    health: deps.health,
    adapters: deps.adapters,
  });

  const attempts: AttemptRecord[] = [];
  const fail = (reason: GatewayUnavailableReason): GatewayCallResult<T> => ({
    ok: false,
    status: "unavailable",
    reason,
    attempts,
    skipped: decision.skipped,
    matrixRevision: decision.matrixRevision,
  });

  if (decision.eligible.length === 0) return fail("no_eligible_provider");

  const maxInputUnits = estimateInputUnits(input.messages);
  let previousPosition: number | undefined;
  let advanceReason: TierChangeReason | undefined;

  const emitAdvance = (toPosition: number, reason: TierChangeReason): void => {
    // Chain positions only: a progress stream is employee-visible (§9.3).
    if (deps.onProgress === undefined || input.conversationId === undefined) return;
    if (previousPosition === undefined || previousPosition === toPosition) return;
    deps.onProgress({
      type: "tier_changed",
      runId: input.runId,
      conversationId: input.conversationId,
      emittedAt: new Date(clock()).toISOString(),
      fromTier: previousPosition,
      toTier: toPosition,
      reason,
    });
  };

  for (const entry of decision.eligible) {
    // Plan §8.3: a stage deadline bounds the whole walk, not just one call.
    if (clock() >= deadlineAtMs) {
      if (advanceReason !== undefined) emitAdvance(entry.chainPosition, "deadline");
      return fail("deadline");
    }
    if (advanceReason !== undefined) emitAdvance(entry.chainPosition, advanceReason);

    const adapter = deps.adapters.get(entry.providerKey);
    if (adapter === undefined) {
      // No adapter, so nothing was sent and nothing was reserved: skip without an attempt record.
      previousPosition = entry.chainPosition;
      advanceReason = "provider_unavailable";
      continue;
    }

    const attemptId = attemptIdOf(
      input.runId,
      entry.chainPosition,
      input.task,
      input.task === "verify" ? input.passTag : undefined,
    );
    let reservationId: string;
    try {
      // §12.3: reserve before the call, per chain attempt.
      const reservation = await deps.meter.reserve({
        organisationId: input.context.organisationId,
        runId: input.runId,
        attemptId,
        task: input.task,
        providerKey: entry.providerKey,
        maxInputUnits,
        maxOutputUnits: input.maxOutputUnits,
      });
      reservationId = reservation.reservationId;
    } catch {
      // §12.3: "Fail closed if reservation authority is unavailable." Nothing is called.
      return fail("budget_authority_unavailable");
    }

    const remainingMs = Math.max(1, deadlineAtMs - clock());
    const outcome = await adapter.complete({
      attemptId,
      // Rule (e) is only real if the selected model is the one the provider is asked for: the route
      // layer resolved it (the evaluated verifier model for a `verify` task), and the adapter is
      // forbidden from substituting its endpoint default.
      model: entry.model,
      task: input.task,
      dataClass: input.dataClass,
      messages: input.messages,
      maxOutputUnits: input.maxOutputUnits,
      timeoutMs: Math.min(input.callTimeoutMs, remainingMs),
    });

    const attempt: AttemptRecord = {
      attemptId,
      providerKey: entry.providerKey,
      chainPosition: entry.chainPosition,
      capabilityTier: entry.capabilityTier,
      outcome: "answered",
      reservedUnits: { maxInputUnits, maxOutputUnits: input.maxOutputUnits },
      reconciled: null,
      model: outcome.ok ? outcome.model : null,
      ...(outcome.ok ? {} : { statusCode: outcome.statusCode }),
    };
    attempts.push(attempt);

    if (outcome.ok) {
      const truncated = outcome.finishReason === "length";
      const parsed = truncated ? undefined : parseWith(input.outputSchema, outcome.text);
      if (truncated || (parsed === undefined && input.outputSchema !== undefined)) {
        // The model ran and the answer is unusable: that work is billed, and it is the schema's
        // job to fail rather than deliver prose (plan §12.1, F38 "invalid structured output").
        attempt.outcome = truncated ? "context_overflow" : "invalid_output";
        await reconcile(deps, attempt, reservationId, outcome, "ambiguous");
        deps.health.recordFailure(entry.providerKey, clock());
        previousPosition = entry.chainPosition;
        advanceReason = FAILURE_TO_PROGRESS_REASON[attempt.outcome];
        continue;
      }
      await reconcile(deps, attempt, reservationId, outcome, "settled");
      deps.health.recordSuccess(entry.providerKey, clock());
      return {
        ok: true,
        providerKey: entry.providerKey,
        model: outcome.model,
        chainPosition: entry.chainPosition,
        capabilityTier: entry.capabilityTier,
        text: outcome.text,
        parsed,
        usage: outcome.usage ?? null,
        attempts,
        skipped: decision.skipped,
        matrixRevision: decision.matrixRevision,
      };
    }

    attempt.outcome = outcome.kind;
    // §12.3: an ambiguous attempt keeps its liability; a clean failure releases the reservation.
    await reconcile(deps, attempt, reservationId, outcome, outcome.possiblyBilled ? "ambiguous" : "released");
    deps.health.recordFailure(entry.providerKey, clock());
    if (outcome.kind === "rate_limited") deps.health.noteQuotaExhausted(entry.providerKey, true);
    previousPosition = entry.chainPosition;
    advanceReason = FAILURE_TO_PROGRESS_REASON[outcome.kind];
  }

  return fail("all_attempts_failed");
}

async function reconcile(
  deps: GatewayDeps,
  attempt: AttemptRecord,
  reservationId: string,
  outcome: AdapterCallOutcome,
  whenUnknown: "settled" | "released" | "ambiguous",
): Promise<void> {
  const usage = outcome.ok ? outcome.usage : undefined;
  const outcomeKind = usage === undefined ? whenUnknown : "settled";
  await deps.meter.reconcile({
    attemptId: attempt.attemptId,
    reservationId,
    outcome: outcomeKind,
    ...(usage === undefined
      ? {}
      : { usedInputUnits: usage.inputUnits, usedOutputUnits: usage.outputUnits }),
  });
  attempt.reconciled = outcomeKind;
}
