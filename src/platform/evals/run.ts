import type { DataClass } from "@/contracts/data-class";
import type { EvalCase } from "@/contracts/eval-case";
import type { ExpertKey } from "@/contracts/keys";
import {
  PLATFORM_DEFAULT_CLEARANCE,
  narrowClearance,
  type ClearanceMatrix,
} from "@/contracts/provider-route";

import { orderEvalCases } from "./order-cases";

export type EvalRunStatus = "completed" | "discarded" | "failed";

export interface EvalRunRow {
  expertKey: ExpertKey;
  expertVersion: string;
  chainConfig: Record<string, unknown>;
  corpusGeneration: string;
  /** Deterministic F35 case order for this execution. */
  caseOrder: string[];
  status: EvalRunStatus;
}

export interface RunExpertEvalInput {
  expertKey: ExpertKey;
  expertVersion: string;
  chainConfig: Record<string, unknown>;
  corpusGeneration: string;
  cases: readonly EvalCase[];
}

/**
 * F35 `runExpertEval` — this slice binds the run row (expert version, chain, corpus generation)
 * and the deterministic case order. Scoring, gateway calls and persistence land in later slices.
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

  return {
    expertKey: input.expertKey,
    expertVersion: input.expertVersion,
    chainConfig: input.chainConfig,
    corpusGeneration: input.corpusGeneration,
    caseOrder: ordered.map((c) => c.caseId),
    status: "completed",
  };
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
