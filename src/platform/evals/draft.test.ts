import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvalCase } from "@/contracts/eval-case";

import {
  draftEvalCases,
  type PublishedSourceVersion,
} from "./draft";
import { loadApprovedEvalCases } from "./load-cases";
import { runExpertEval } from "./run";

/**
 * T-312 F34: draftEvalCases from published collection versions (plan §14.1 step 1).
 * Drafts are agent_drafted, unusable until approved; F35 never scores them.
 */

const COLLECTION_A = "11111111-1111-4111-8111-111111111111";
const COLLECTION_B = "22222222-2222-4222-8222-222222222222";
const VERSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function published(overrides: Partial<PublishedSourceVersion> = {}): PublishedSourceVersion {
  return {
    sourceVersionId: VERSION_A,
    collectionId: COLLECTION_A,
    dataClass: "internal",
    fixtureId: "SYNTH-UAV-MAN-A17",
    locatorHint: "page:12 section:3.2.1",
    projectScope: "synth-tenant-wide",
    question: "What do we check on UAV-A17 before a training flight?",
    answerPoints: [
      "Names the three pre-flight checks the manual lists and cites the section that carries them.",
    ],
    claimTypes: ["source_fact"],
    caseType: "answerable",
    ...overrides,
  };
}

describe("draftEvalCases (F34)", () => {
  it("drafts agent_drafted cases with expected source version/locator from readable collections only", () => {
    const drafts = draftEvalCases({
      expertKey: "uav-expert",
      readableCollectionIds: new Set([COLLECTION_A]),
      publishedVersions: [
        published(),
        published({
          sourceVersionId: VERSION_B,
          collectionId: COLLECTION_B,
          fixtureId: "SYNTH-OTHER-MAN",
          locatorHint: "page:1 section:1",
          question: "Secret from another collection?",
          answerPoints: ["Must never appear."],
        }),
      ],
      draftedBy: "agent (T-312 F34)",
      draftedOn: "2026-11-23",
      caseIdPrefix: "UAV-D",
    });

    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.status).toBe("drafted");
    expect(draft.origin).toBe("agent_drafted");
    expect(draft.approvedBy).toBeNull();
    expect(draft.approvedAt).toBeNull();
    expect(draft.expectedEvidence).toEqual([]);
    expect(draft.expectedFixtures).toEqual(["SYNTH-UAV-MAN-A17"]);
    expect(draft.expectedSource).toContain("SYNTH-UAV-MAN-A17");
    expect(draft.expectedSource).toContain("page:12 section:3.2.1");
    expect(draft.expectedSource).toContain(VERSION_A);
    expect(draft.caseId).toBe("UAV-D001");
    expect(draft.expertKey).toBe("uav-expert");
    expect(draft.dataClass).toBe("internal");
    // Contract-valid drafted case.
    expect(() => EvalCase.parse(draft)).not.toThrow();
  });

  it("produces zero drafts when the expert cannot read any published collection", () => {
    const drafts = draftEvalCases({
      expertKey: "gpr-expert",
      readableCollectionIds: new Set(),
      publishedVersions: [published()],
      draftedBy: "agent (T-312 F34)",
      draftedOn: "2026-11-23",
    });
    expect(drafts).toEqual([]);
  });

  it("never invents a case for a collection outside the readable set (cross-tenant / ACL)", () => {
    const drafts = draftEvalCases({
      expertKey: "uav-expert",
      readableCollectionIds: new Set([COLLECTION_A]),
      publishedVersions: [
        published({ collectionId: COLLECTION_B, fixtureId: "SYNTH-COMPANY2-DOC" }),
      ],
      draftedBy: "agent (T-312 F34)",
      draftedOn: "2026-11-23",
    });
    expect(drafts).toEqual([]);
  });

  it("F35 ignores F34 drafts until an eligible reviewer approves them", () => {
    const drafts = draftEvalCases({
      expertKey: "uav-expert",
      readableCollectionIds: new Set([COLLECTION_A]),
      publishedVersions: [published()],
      draftedBy: "agent (T-312 F34)",
      draftedOn: "2026-11-23",
      caseIdPrefix: "UAV-D",
    });

    expect(() =>
      runExpertEval({
        expertKey: "uav-expert",
        expertVersion: "ev-0001",
        chainConfig: { compose: ["local_box"] },
        corpusGeneration: "cg-0001",
        cases: drafts,
      }),
    ).toThrow(/not approved/);

    const root = mkdtempSync(join(tmpdir(), "toi-f34-"));
    try {
      const expertDir = join(root, "uav-expert");
      const draftsDir = join(expertDir, "drafts");
      mkdirSync(draftsDir, { recursive: true });
      for (const draft of drafts) {
        writeFileSync(join(draftsDir, `${draft.caseId}.json`), `${JSON.stringify(draft, null, 2)}\n`);
      }
      expect(loadApprovedEvalCases(root, "uav-expert")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a published version whose fixture id is not SYNTH-shaped (AGENTS.md §4.7)", () => {
    expect(() =>
      draftEvalCases({
        expertKey: "uav-expert",
        readableCollectionIds: new Set([COLLECTION_A]),
        publishedVersions: [published({ fixtureId: "REAL-CLIENT-DOC" })],
        draftedBy: "agent (T-312 F34)",
        draftedOn: "2026-11-23",
      }),
    ).toThrow(/SYNTH-/);
  });
});
