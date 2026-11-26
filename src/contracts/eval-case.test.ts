import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AdversarialClass,
  CaseType,
  EvalCase,
  EvalChunkEvidence,
} from "./eval-case";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVALS_ROOT = join(REPO_ROOT, "evals");

const SOURCE_VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function draftedFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    caseId: "UAV-E999",
    expertKey: "uav-expert",
    status: "drafted",
    origin: "agent_drafted",
    caseType: "answerable",
    question: "What does the synthetic manual say about the compass check?",
    expectedAnswerPoints: ["Names the check and cites the section."],
    expectedClaimTypes: ["source_fact"],
    expectedAnswerStatus: "answered",
    citationRequired: true,
    dataClass: "internal",
    projectScope: "synth-tenant-wide",
    forbiddenClaims: [],
    isolationBait: false,
    adversarialClass: null,
    expectedSource: "SYNTH-UAV-MAN-A17 page:1 section:1",
    expectedFixtures: ["SYNTH-UAV-MAN-A17"],
    expectedEvidence: [],
    approvedBy: null,
    approvedAt: null,
    draftedBy: "agent (unit test)",
    draftedOn: "2026-11-20",
    ...overrides,
  };
}

function approvedFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return draftedFixture({
    status: "approved",
    approvedBy: "usr_01APPROVER",
    approvedAt: "2026-11-20T12:00:00Z",
    expectedEvidence: [
      {
        kind: "chunk",
        sourceVersionId: SOURCE_VERSION_ID,
        chunkId: "chk_01EVAL",
        span: { startChar: 0, endChar: 12 },
      },
    ],
    ...overrides,
  });
}

function listCaseJsonFiles(): string[] {
  const out: string[] = [];
  for (const expertDir of readdirSync(EVALS_ROOT)) {
    const expertPath = join(EVALS_ROOT, expertDir);
    if (!statSync(expertPath).isDirectory()) continue;
    if (expertDir === "retrieval" || expertDir === "verification") continue;

    for (const name of readdirSync(expertPath)) {
      const at = join(expertPath, name);
      if (name.endsWith(".json") && statSync(at).isFile()) out.push(at);
    }

    const drafts = join(expertPath, "drafts");
    try {
      if (statSync(drafts).isDirectory()) {
        for (const name of readdirSync(drafts)) {
          if (!name.endsWith(".json")) continue;
          out.push(join(drafts, name));
        }
      }
    } catch {
      // no drafts folder
    }
  }
  return out.sort();
}

describe("EvalCase enums (ADR-0010 / #84)", () => {
  it("exposes CaseType and AdversarialClass as closed enums", () => {
    expect(CaseType.options).toEqual([
      "answerable",
      "needs_clarification",
      "must_refuse",
      "out_of_scope",
    ]);
    expect(AdversarialClass.options).toHaveLength(6);
  });
});

describe("EvalCase expectedEvidence by status (ADR-0010 §1)", () => {
  it("accepts drafted with empty expectedEvidence even when citationRequired", () => {
    expect(EvalCase.parse(draftedFixture({ citationRequired: true, expectedEvidence: [] })).expectedEvidence).toEqual(
      [],
    );
  });

  it("rejects drafted with any expectedEvidence entry", () => {
    expect(() =>
      EvalCase.parse(
        draftedFixture({
          expectedEvidence: [
            {
              kind: "chunk",
              sourceVersionId: SOURCE_VERSION_ID,
              chunkId: "chk_01",
              span: { startChar: 0, endChar: 1 },
            },
          ],
        }),
      ),
    ).toThrow(/drafted cases carry expectedEvidence/);
  });

  it("requires ≥1 expectedEvidence when approved and citationRequired", () => {
    expect(() => EvalCase.parse(approvedFixture({ expectedEvidence: [], citationRequired: true }))).toThrow(
      /at least one expectedEvidence/,
    );
    expect(EvalCase.parse(approvedFixture({ citationRequired: true })).expectedEvidence).toHaveLength(1);
  });

  it("allows empty expectedEvidence when approved and citationRequired is false", () => {
    expect(
      EvalCase.parse(
        approvedFixture({
          citationRequired: false,
          expectedAnswerStatus: "refused",
          expectedRefusalKey: "no_evidence",
          expectedEvidence: [],
        }),
      ).expectedEvidence,
    ).toEqual([]);
  });
});

describe("EvalCase expectedRefusalKey (ADR-0010 §4)", () => {
  it("requires expectedRefusalKey when refused or unavailable", () => {
    expect(() =>
      EvalCase.parse(
        draftedFixture({
          expectedAnswerStatus: "refused",
          citationRequired: false,
          caseType: "must_refuse",
        }),
      ),
    ).toThrow(/expectedRefusalKey is required/);
    expect(() =>
      EvalCase.parse(
        draftedFixture({
          expectedAnswerStatus: "unavailable",
          citationRequired: false,
          caseType: "must_refuse",
          adversarialClass: "provider_outage_mid_run",
        }),
      ),
    ).toThrow(/expectedRefusalKey is required/);
  });

  it("rejects expectedRefusalKey on answered or partial", () => {
    expect(() =>
      EvalCase.parse(draftedFixture({ expectedAnswerStatus: "answered", expectedRefusalKey: "no_evidence" })),
    ).toThrow(/only when expectedAnswerStatus is refused or unavailable/);
  });

  it("pairs unavailable key with unavailable status only", () => {
    expect(() =>
      EvalCase.parse(
        draftedFixture({
          expectedAnswerStatus: "refused",
          citationRequired: false,
          caseType: "must_refuse",
          expectedRefusalKey: "unavailable",
        }),
      ),
    ).toThrow(/does not match/);
    expect(
      EvalCase.parse(
        draftedFixture({
          expectedAnswerStatus: "unavailable",
          citationRequired: false,
          caseType: "must_refuse",
          adversarialClass: "provider_outage_mid_run",
          expectedRefusalKey: "unavailable",
        }),
      ).expectedRefusalKey,
    ).toBe("unavailable");
  });

  it("accepts the three refused keys with status refused", () => {
    for (const key of ["no_evidence", "insufficient_support", "out_of_scope"] as const) {
      expect(
        EvalCase.parse(
          draftedFixture({
            expectedAnswerStatus: "refused",
            citationRequired: false,
            caseType: "must_refuse",
            expectedRefusalKey: key,
          }),
        ).expectedRefusalKey,
      ).toBe(key);
    }
  });
});

describe("EvalCase M1 chunk-only evidence (ADR-0010 §2)", () => {
  it("parses a chunk locator without quotedText", () => {
    const entry = EvalChunkEvidence.parse({
      kind: "chunk",
      sourceVersionId: SOURCE_VERSION_ID,
      chunkId: "chk_01",
      span: { startChar: 0, endChar: 4 },
    });
    expect(entry.kind).toBe("chunk");
    expect("quotedText" in entry).toBe(false);
  });

  it("rejects unknown keys on an evidence entry (strict)", () => {
    expect(() =>
      EvalChunkEvidence.parse({
        kind: "chunk",
        sourceVersionId: SOURCE_VERSION_ID,
        chunkId: "chk_01",
        span: { startChar: 0, endChar: 4 },
        quotedText: "must not be stored in case files",
      }),
    ).toThrow();
  });
});

describe("committed eval case files under evals/<expert>/ and drafts/", () => {
  const files = listCaseJsonFiles();

  it("finds the drafted batch", () => {
    expect(files.length).toBeGreaterThanOrEqual(100);
  });

  it("parses every case JSON", () => {
    const failures: string[] = [];
    for (const path of files) {
      const rel = relative(REPO_ROOT, path).replaceAll("\\", "/");
      const stem = rel.split("/").at(-1)?.replace(/\.json$/, "") ?? "";
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        failures.push(`${rel}: invalid JSON (${String(error)})`);
        continue;
      }
      const parsed = EvalCase.safeParse(raw);
      if (!parsed.success) {
        failures.push(`${rel}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
        continue;
      }
      if (parsed.data.caseId !== stem) {
        failures.push(`${rel}: caseId ${parsed.data.caseId} !== file stem ${stem}`);
      }
      const expertFolder = rel.split("/")[1];
      if (parsed.data.expertKey !== expertFolder) {
        failures.push(`${rel}: expertKey ${parsed.data.expertKey} !== folder ${expertFolder}`);
      }
      if (rel.includes("/drafts/") && parsed.data.status !== "drafted") {
        failures.push(`${rel}: drafts/ file must have status drafted`);
      }
      if (!rel.includes("/drafts/") && parsed.data.status !== "approved") {
        failures.push(`${rel}: approved tree file must have status approved`);
      }
    }
    expect(failures).toEqual([]);
  });
});
