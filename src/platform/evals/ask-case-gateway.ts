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
  /** Base id; each case appends `:${caseId}` so reservations do not collide (§12.3). */
  runId: string;
  gatewayDeps: GatewayDeps;
  /** Compose chain from the run's `chain_config.compose` when present. */
  composeChain?: readonly ProviderKey[];
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
 * Clearance enforcement for providers used stays in `runExpertEval`; the route honours `tenantPolicy`.
 */
export function createEvalGatewayAsker(config: EvalGatewayAskerConfig): EvalCaseAsker {
  return async (ctx: EvalCaseAskContext) => {
    const result = await callModelGateway<EvalGatewayAnswer>(
      {
        context: config.context,
        runId: `${config.runId}:${ctx.evalCase.caseId}`,
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
        tenantPolicy: config.tenantPolicy,
        chain: config.composeChain,
        outputSchema: EvalGatewayAnswer,
      },
      config.gatewayDeps,
    );

    return gatewayResultToObservation(result);
  };
}