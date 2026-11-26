import type { EvalCase, ExpectedAnswerStatus } from "@/contracts/eval-case";
import type { RefusalKey } from "@/contracts/answer";
import type { ProviderKey } from "@/contracts/keys";

import type { EvalFailureClass } from "./failure-classes";

/** What the case asker observed — not a full `Answer` row (scoring keys only). */
export type EvalCaseObservation =
  | {
      kind: "answer";
      status: ExpectedAnswerStatus;
      refusalKey?: RefusalKey;
      /** Providers the gateway (or mock) actually invoked for this case. */
      providerKeysUsed: readonly ProviderKey[];
      evidence?: unknown[];
    }
  | {
      kind: "infrastructure_failure";
      providerKeysUsed: readonly ProviderKey[];
    }
  | {
      kind: "absent";
      providerKeysUsed: readonly ProviderKey[];
    };

export interface EvalCaseScore {
  caseId: string;
  score: number | null;
  failureClass: EvalFailureClass | null;
  evidence: unknown[];
  providerKeysUsed: readonly ProviderKey[];
}

/**
 * Score one approved case against an observation (F35).
 * Isolation/bait cases must refuse — an absent or answered result is a failure, not a pass.
 */
export function scoreEvalCase(evalCase: EvalCase, observation: EvalCaseObservation): EvalCaseScore {
  const base = {
    caseId: evalCase.caseId,
    providerKeysUsed: observation.providerKeysUsed,
  };

  if (observation.kind === "infrastructure_failure") {
    return {
      ...base,
      score: null,
      failureClass: "provider_outage",
      evidence: [],
    };
  }

  if (observation.kind === "absent") {
    return {
      ...base,
      score: 0,
      failureClass: evalCase.isolationBait ? "isolation_bait_not_refused" : "missing_answer",
      evidence: [],
    };
  }

  const evidence = observation.evidence ?? [];

  if (evalCase.isolationBait) {
    const refused =
      observation.status === "refused" || observation.status === "unavailable";
    if (!refused) {
      return {
        ...base,
        score: 0,
        failureClass: "isolation_bait_not_refused",
        evidence,
      };
    }
  }

  if (observation.status !== evalCase.expectedAnswerStatus) {
    return {
      ...base,
      score: 0,
      failureClass: "wrong_answer_status",
      evidence,
    };
  }

  if (evalCase.expectedRefusalKey !== undefined) {
    if (observation.refusalKey !== evalCase.expectedRefusalKey) {
      return {
        ...base,
        score: 0,
        failureClass: "wrong_refusal_key",
        evidence,
      };
    }
  }

  return {
    ...base,
    score: 1,
    failureClass: null,
    evidence,
  };
}
