import type { DataClass } from "@/contracts/data-class";
import type { EvalCase } from "@/contracts/eval-case";
import type { ExpertKey, ProviderKey } from "@/contracts/keys";
import {
  PLATFORM_DEFAULT_CLEARANCE,
  narrowClearance,
  type ClearanceMatrix,
} from "@/contracts/provider-route";

import { orderEvalCases } from "./order-cases";
import { scoreEvalCase, type EvalCaseObservation, type EvalCaseScore } from "./score";

export type EvalRunStatus = "completed" | "discarded" | "failed";

export interface EvalRunRow {
  expertKey: ExpertKey;
  expertVersion: string;
  chainConfig: Record<string, unknown>;
  corpusGeneration: string;
  /** Deterministic F35 case order for this execution. */
  caseOrder: string[];
  status: EvalRunStatus;
  /** Per-case scores bound to this run's corpus generation. Empty when discarded. */
  results: EvalCaseScore[];
}

export interface EvalCaseAskContext {
  evalCase: EvalCase;
  clearance: ClearanceMatrix;
  corpusGeneration: string;
  expertVersion: string;
}

/**
 * Injectable case asker (gateway in production, mock in tests).
 * Must honour `clearance` — never call a provider outside the cleared list for the case data class.
 */
export type EvalCaseAsker = (ctx: EvalCaseAskContext) => EvalCaseObservation & {
  /** If set and differs from the run's corpusGeneration, the whole run is discarded. */
  observedCorpusGeneration?: string;
};

export interface RunExpertEvalInput {
  expertKey: ExpertKey;
  expertVersion: string;
  chainConfig: Record<string, unknown>;
  corpusGeneration: string;
  cases: readonly EvalCase[];
  /** Optional asker; when omitted, the run only binds order/metadata (PR-3 behaviour). */
  askCase?: EvalCaseAsker;
  tenantPolicy?: Partial<ClearanceMatrix>;
  platformClearance?: ClearanceMatrix;
}

/**
 * F35 `runExpertEval` — binds the run row, deterministic order, optional per-case scoring.
 * Results are bound to `corpusGeneration`; drift mid-run discards the run.
 */
export function runExpertEval(input: RunExpertEvalInput): EvalRunRow {
  if (input.expertVersion.trim().length === 0) {
    throw new Error("runExpertEval: expertVersion is required");
  }
  if (input.corpusGeneration.trim().length === 0) {
    throw new Error("runExpertEval: corpusGeneration is required");
  }

  const ordered = orderEvalCases(input.cases);
  for (const item of ordered) {
    if (item.expertKey !== input.expertKey) {
      throw new Error(`runExpertEval: case ${item.caseId} expertKey does not match run expert`);
    }
    if (item.status !== "approved" || item.approvedBy === null) {
      throw new Error(`runExpertEval: case ${item.caseId} is not approved (F35 ignores unapproved)`);
    }
  }

  const caseOrder = ordered.map((c) => c.caseId);
  const base = {
    expertKey: input.expertKey,
    expertVersion: input.expertVersion,
    chainConfig: input.chainConfig,
    corpusGeneration: input.corpusGeneration,
    caseOrder,
  };

  if (!input.askCase) {
    return { ...base, status: "completed", results: [] };
  }

  const results: EvalCaseScore[] = [];
  for (const evalCase of ordered) {
    const clearance = clearanceForEvalCase({
      dataClass: evalCase.dataClass,
      tenantPolicy: input.tenantPolicy,
      platform: input.platformClearance,
    });
    const observation = input.askCase({
      evalCase,
      clearance,
      corpusGeneration: input.corpusGeneration,
      expertVersion: input.expertVersion,
    });

    if (
      observation.observedCorpusGeneration !== undefined &&
      observation.observedCorpusGeneration !== input.corpusGeneration
    ) {
      return { ...base, status: "discarded", results: [] };
    }

    assertProvidersWithinClearance(evalCase.dataClass, clearance, observation.providerKeysUsed);

    results.push(scoreEvalCase(evalCase, observation));
  }

  return { ...base, status: "completed", results };
}

/**
 * Clearance for one eval case: tenant policy may only narrow the platform matrix.
 * An eval run never widens clearance to make a `client_confidential` case call DeepSeek/OpenRouter (§16).
 * A `platform` override is itself narrowed against `PLATFORM_DEFAULT_CLEARANCE`, so a caller can
 * test a stricter matrix but never a wider one (supervisor round 1 on #241).
 */
export function clearanceForEvalCase(args: {
  dataClass: DataClass;
  tenantPolicy?: Partial<ClearanceMatrix>;
  platform?: ClearanceMatrix;
}): ClearanceMatrix {
  void args.dataClass;
  const platform =
    args.platform === undefined ? PLATFORM_DEFAULT_CLEARANCE : narrowClearance(args.platform, PLATFORM_DEFAULT_CLEARANCE);
  return narrowClearance(args.tenantPolicy, platform);
}

function assertProvidersWithinClearance(
  dataClass: DataClass,
  clearance: ClearanceMatrix,
  used: readonly ProviderKey[],
): void {
  const allowed = new Set(clearance[dataClass]);
  for (const key of used) {
    if (!allowed.has(key)) {
      throw new Error(
        `runExpertEval: provider '${key}' is not cleared for data class '${dataClass}' (never widen clearance)`,
      );
    }
  }
}
