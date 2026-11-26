import type { ExpertKey, ProviderKey } from "@/contracts/keys";
import type { ClearanceMatrix } from "@/contracts/provider-route";
import type { TenantContext } from "@/contracts/tenant-context";
import type { EvalCase } from "@/contracts/eval-case";

import type { GatewayDeps } from "@/platform/gateway/call";

import { createEvalGatewayAsker, type EvalGatewayAskerConfig } from "./ask-case-gateway";
import { recordEvalRun, type RecordEvalRunDeps, type RecordEvalRunOutcome } from "./record-eval-run";
import { runExpertEval, type EvalRunRow, type RunExpertEvalInput } from "./run";

function composeChainFromConfig(chainConfig: Record<string, unknown>): readonly ProviderKey[] | undefined {
  const raw = chainConfig.compose;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const keys: ProviderKey[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    keys.push(item);
  }
  return keys;
}

export interface RunExpertEvalAndPersistInput {
  context: TenantContext;
  accessToken: string;
  expertKey: ExpertKey;
  expertVersion: string;
  chainConfig: Record<string, unknown>;
  corpusGeneration: string;
  cases: readonly EvalCase[];
  /** Fixture caseId (case_key) → `eval_cases.id` uuid for this tenant. */
  caseIdToUuid: Readonly<Record<string, string>>;
  gatewayDeps: GatewayDeps;
  recordDeps: RecordEvalRunDeps;
  /** Stable eval run id prefix for gateway metering. */
  evalRunId: string;
  tenantPolicy?: Partial<ClearanceMatrix>;
  platformClearance?: ClearanceMatrix;
  gatewayTiming?: Pick<EvalGatewayAskerConfig, "maxOutputUnits" | "callTimeoutMs" | "stageDeadlineMs">;
}

export interface RunExpertEvalAndPersistResult {
  run: EvalRunRow;
  persist: RecordEvalRunOutcome;
}

/**
 * F35 end-to-end: approved cases → gateway asker → scored run row → `record_eval_run_v1`.
 */
export async function runExpertEvalAndPersist(
  input: RunExpertEvalAndPersistInput,
): Promise<RunExpertEvalAndPersistResult> {
  const gatewayWire: EvalGatewayAskerConfig = {
    context: input.context,
    runId: input.evalRunId,
    gatewayDeps: input.gatewayDeps,
    composeChain: composeChainFromConfig(input.chainConfig),
    tenantPolicy: input.tenantPolicy,
    ...input.gatewayTiming,
  };

  const runInput: RunExpertEvalInput = {
    expertKey: input.expertKey,
    expertVersion: input.expertVersion,
    chainConfig: input.chainConfig,
    corpusGeneration: input.corpusGeneration,
    cases: input.cases,
    askCase: createEvalGatewayAsker(gatewayWire),
    tenantPolicy: input.tenantPolicy,
    platformClearance: input.platformClearance,
  };

  const run = await runExpertEval(runInput);
  const persist = await recordEvalRun(
    input.context,
    input.accessToken,
    run,
    input.caseIdToUuid,
    input.recordDeps,
  );

  return { run, persist };
}