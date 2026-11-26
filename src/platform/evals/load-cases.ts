import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { EvalCase } from "@/contracts/eval-case";
import type { ExpertKey } from "@/contracts/keys";

import { orderEvalCases } from "./order-cases";

/**
 * F35 fixture load: approved JSON under `evals/<expertKey>/` only.
 * Plan §14.1 step 3 / eval-case-format.md: never reads `drafts/`.
 */
export function loadApprovedEvalCases(evalsRoot: string, expertKey: ExpertKey): EvalCase[] {
  const expertDir = join(evalsRoot, expertKey);
  let entries: string[];
  try {
    entries = readdirSync(expertDir);
  } catch {
    return [];
  }

  const loaded: EvalCase[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = join(expertDir, name);
    if (!statSync(full).isFile()) continue;

    const raw: unknown = JSON.parse(readFileSync(full, "utf8"));
    const parsed = EvalCase.parse(raw);
    if (parsed.expertKey !== expertKey) {
      throw new Error(`eval case ${name}: expertKey '${parsed.expertKey}' does not match folder '${expertKey}'`);
    }
    if (parsed.caseId !== name.slice(0, -".json".length)) {
      throw new Error(`eval case ${name}: caseId '${parsed.caseId}' does not match file stem`);
    }
    if (parsed.status !== "approved" || parsed.approvedBy === null || parsed.approvedAt === null) {
      // Placement under the expert folder is the approval state; a drafted file here is invalid input.
      throw new Error(`eval case ${name}: F35 only loads status=approved with approvedBy/approvedAt set`);
    }
    loaded.push(parsed);
  }

  return orderEvalCases(loaded);
}
