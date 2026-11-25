import type { EvalCase } from "@/contracts/eval-case";

/**
 * F35 deterministic case order (plan §14.1 step 4): stable by `caseId`, then original index.
 * The runner scores in this order so CI and nightly compare the same sequence.
 */
export function orderEvalCases(cases: readonly EvalCase[]): EvalCase[] {
  return [...cases]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byId = a.item.caseId.localeCompare(b.item.caseId);
      return byId !== 0 ? byId : a.index - b.index;
    })
    .map(({ item }) => item);
}
