import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_ADVERSARIAL,
  adversarialClassesPresent,
  assertSourceAndLocator,
  findClientIdentifyingHits,
  listExpertCaseFiles,
  loadAndParseCase,
} from "../case-validation";

/**
 * T-315: every committed GPR case file parses, carries a §14.1 case type, names a SYNTH source
 * locator, and holds no client-identifying text. The six adversarial classes are present.
 */

const EXPERT = "gpr-expert";
const EXPERT_DIR = join(dirname(fileURLToPath(import.meta.url)));

describe(`evals/${EXPERT} cases (T-315)`, () => {
  const paths = listExpertCaseFiles(EXPERT_DIR);
  const cases = paths.map((path) => ({ path, caseFile: loadAndParseCase(path, EXPERT) }));

  it("loads at least one drafted case file", () => {
    expect(paths.length).toBeGreaterThan(40);
  });

  it("every case file parses and matches its folder / file stem", () => {
    expect(cases).toHaveLength(paths.length);
  });

  it("every case names a source/locator and a §14.1 case type with SYNTH fixtures only", () => {
    for (const { path, caseFile } of cases) {
      assertSourceAndLocator(caseFile, path);
    }
  });

  it("nothing client-identifying is committed (AGENTS.md §4.7)", () => {
    for (const { path, caseFile } of cases) {
      const hits = findClientIdentifyingHits(JSON.stringify(caseFile));
      expect(hits, path).toEqual([]);
    }
  });

  it("the six §14.1 step-2 adversarial classes are present before domain approval", () => {
    const found = adversarialClassesPresent(cases.map((c) => c.caseFile));
    for (const required of REQUIRED_ADVERSARIAL) {
      expect(found.has(required), `missing adversarialClass ${required}`).toBe(true);
    }
  });

  it("isolation / project bait cases are must_refuse with isolationBait", () => {
    const bait = cases.filter(
      (c) =>
        c.caseFile.adversarialClass === "cross_tenant_bait" ||
        c.caseFile.adversarialClass === "project_restricted",
    );
    expect(bait.length).toBeGreaterThanOrEqual(5);
    for (const { path, caseFile } of bait) {
      expect(caseFile.isolationBait, path).toBe(true);
      expect(caseFile.caseType, path).toBe("must_refuse");
      // Isolation bait must not answer: refuse or unavailable (never an answered leak).
      expect(["refused", "unavailable"]).toContain(caseFile.expectedAnswerStatus);
    }
  });
});
