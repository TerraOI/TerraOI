/**
 * Per-case F35 failure classes (plan §14.1 / §6.1 eval_results).
 * Infrastructure failures are never scored as a quiet zero that would steer tuning the wrong way.
 */
export const EVAL_FAILURE_CLASSES = [
  "provider_outage",
  "wrong_answer_status",
  "wrong_refusal_key",
  "isolation_bait_not_refused",
  "missing_answer",
  "corpus_generation_drift",
] as const;

export type EvalFailureClass = (typeof EVAL_FAILURE_CLASSES)[number];

export function isEvalFailureClass(value: string): value is EvalFailureClass {
  return (EVAL_FAILURE_CLASSES as readonly string[]).includes(value);
}
