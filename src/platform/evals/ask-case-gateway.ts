import { z } from "zod";

import { RefusalKey } from "@/contracts/answer";
import { ExpectedAnswerStatus } from "@/contracts/eval-case";
import type { ProviderKey } from "@/contracts/keys";
import type { ClearanceMatrix } from "@/contracts/provider-route";
import type { TenantContext } from "@/contracts/tenant-context";

import {
  callModelGateway,
  type AttemptRecord,
  type GatewayCallResult,
  type GatewayDeps,
} from "@/platform/gateway/call";

import type { EvalCaseAskContext, EvalCaseAsker } from "./run";
import type { EvalCaseObservation } from "./score";

/** Structured eval compose output — scoring keys only, not a full Answer row. */
export const EvalGatewayAnswer = z.strictObject({
  status: ExpectedAnswerStatus,
  refusalKey: RefusalKey.optional(),
});
export type EvalGatewayAnswer = z.infer<typeof EvalGatewayAnswer>;

export interface EvalGatewayAskerConfig {
  context: TenantContext;
  /**
   * The eval run's id (a UUID: the budget ledger's `run_id` is `uuid`). Cases are told apart by the
   * gateway pass tag `case:<caseId>`, so their attempt ids and reservations never collide (§12.3).
   */
  runId: string;
  gatewayDeps: GatewayDeps;
  /** Compose chain from the run's `chain_config.compose` when present. */
  composeChain?: readonly ProviderKey[];
  /**
   * Kept for callers' shape; routing uses the per-case clearance `runExpertEval` already narrowed
   * from this policy, so it is not read here.
   */
  tenantPolicy?: Partial<ClearanceMatrix>;
  maxOutputUnits?: number;
  callTimeoutMs?: number;
  stageDeadlineMs?: number;
}

const DEFAULT_MAX_OUTPUT = 600;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_STAGE_DEADLINE_MS = 30_000;

function uniqueProviders(attempts: readonly AttemptRecord[]): ProviderKey[] {
  const seen = new Set<ProviderKey>();
  const ordered: ProviderKey[] = [];
  for (const attempt of attempts) {
    if (!seen.has(attempt.providerKey)) {
      seen.add(attempt.providerKey);
      ordered.push(attempt.providerKey);
    }
  }
  return ordered;
}

export function providerKeysFromAttempts(attempts: readonly AttemptRecord[]): readonly ProviderKey[] {
  return uniqueProviders(attempts);
}

export function gatewayResultToObservation(
  result: GatewayCallResult<EvalGatewayAnswer>,
): EvalCaseObservation {
  const providerKeysUsed = providerKeysFromAttempts(result.attempts);

  if (!result.ok) {
    return { kind: "infrastructure_failure", providerKeysUsed };
  }

  const parsed = result.parsed;
  if (parsed === undefined) {
    return { kind: "absent", providerKeysUsed };
  }

  return {
    kind: "answer",
    status: parsed.status,
    refusalKey: parsed.refusalKey,
    providerKeysUsed,
    evidence: [],
  };
}

/**
 * Default F35 case asker: one `callModelGateway` compose per case (plan §14.1 — real gateway, no bypass).
 * The gateway routes under the case's narrowed clearance; `runExpertEval` re-checks providers used.
 */
export function createEvalGatewayAsker(config: EvalGatewayAskerConfig): EvalCaseAsker {
  return async (ctx: EvalCaseAskContext) => {
    const result = await callModelGateway<EvalGatewayAnswer>(
      {
        context: config.context,
        runId: config.runId,
        // Supervisor round 1 on #274: `${runId}:${caseId}` is not a UUID and would fail the SQL
        // ledger's reserve; the per-case distinction belongs in the attempt id instead.
        passTag: `case:${ctx.evalCase.caseId}`,
        task: "compose",
        dataClass: ctx.evalCase.dataClass,
        messages: [
          {
            role: "system",
            text:
              "You are an expert assistant in an offline evaluation. Reply with JSON only: " +
              '{"status":"answered"|"partial"|"refused"|"unavailable","refusalKey"?:<closed enum>}. ' +
              "Honour the question and data class; do not invent citations.",
          },
          { role: "user", text: ctx.evalCase.question },
        ],
        maxOutputUnits: config.maxOutputUnits ?? DEFAULT_MAX_OUTPUT,
        callTimeoutMs: config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        stageDeadlineMs: config.stageDeadlineMs ?? DEFAULT_STAGE_DEADLINE_MS,
        // The case's already-narrowed clearance is the policy the gateway routes under, so a
        // stricter platform matrix is enforced before any provider is called, not checked after.
        tenantPolicy: ctx.clearance,
        chain: config.composeChain,
        outputSchema: EvalGatewayAnswer,
      },
      config.gatewayDeps,
    );

    return gatewayResultToObservation(result);
  };
}
