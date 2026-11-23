import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { AdversarialClass, CaseType, EvalCase } from "@/contracts/eval-case";

/**
 * Shared validators for T-315 `evals/<expert>/cases.test.ts` (plan §14.1, AGENTS.md §4.7).
 * No client document text, object keys, or non-synthetic identifiers may pass.
 */

const SYNTH_FIXTURE = /^SYNTH-[A-Z0-9-]+$/;

/** Patterns that indicate client-identifying or secret material in a committed case file. */
const CLIENT_IDENTIFYING: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@(?!company[12]\.test\b|terraoi\.test\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i,
  /storage\/v1\//i,
  /\/object\/sign\//i,
  /\bs3:\/\//i,
  /\bsk-[a-zA-Z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./, // JWT-shaped
];

export function listExpertCaseFiles(expertDir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(expertDir)) {
    const full = join(expertDir, name);
    if (name.endsWith(".json") && statSync(full).isFile()) out.push(full);
  }
  const drafts = join(expertDir, "drafts");
  try {
    if (statSync(drafts).isDirectory()) {
      for (const name of readdirSync(drafts)) {
        if (!name.endsWith(".json")) continue;
        out.push(join(drafts, name));
      }
    }
  } catch {
    // no drafts/
  }
  return out.sort();
}

export function loadAndParseCase(path: string, expectedExpertKey: string): EvalCase {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = EvalCase.parse(raw);
  const stem = basename(path, ".json");
  if (parsed.caseId !== stem) {
    throw new Error(`${path}: caseId '${parsed.caseId}' does not match file stem '${stem}'`);
  }
  if (parsed.expertKey !== expectedExpertKey) {
    throw new Error(`${path}: expertKey '${parsed.expertKey}' does not match folder '${expectedExpertKey}'`);
  }
  return parsed;
}

export function assertSourceAndLocator(caseFile: EvalCase, path: string): void {
  if (caseFile.expectedSource.trim().length === 0) {
    throw new Error(`${path}: expectedSource must name a source/locator`);
  }
  for (const fixture of caseFile.expectedFixtures) {
    if (!SYNTH_FIXTURE.test(fixture)) {
      throw new Error(`${path}: fixture '${fixture}' must be SYNTH-… (AGENTS.md §4.7)`);
    }
  }
  if (!CaseType.options.includes(caseFile.caseType)) {
    throw new Error(`${path}: caseType '${caseFile.caseType}' is not a §14.1 case type`);
  }
}

export function findClientIdentifyingHits(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of CLIENT_IDENTIFYING) {
    const match = text.match(pattern);
    if (match) hits.push(match[0]!);
  }
  return hits;
}

export function adversarialClassesPresent(cases: readonly EvalCase[]): Set<string> {
  const found = new Set<string>();
  for (const item of cases) {
    if (item.adversarialClass !== null) found.add(item.adversarialClass);
  }
  return found;
}

export const REQUIRED_ADVERSARIAL = AdversarialClass.options;
