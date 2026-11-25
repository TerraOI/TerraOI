import {
  CaseType,
  EvalCase,
  type AdversarialClass,
  type ExpectedAnswerStatus,
} from "@/contracts/eval-case";
import type { ClaimType } from "@/contracts/answer";
import type { DataClass } from "@/contracts/data-class";
import type { ExpertKey } from "@/contracts/keys";

/**
 * F34 `draftEvalCases` — plan §14.1 step 1 / F34.
 *
 * When a collection version is published, draft candidate cases: question, expected answer points,
 * expected source version/locator, and case type. Drafts only from collections the reviewing expert
 * is authorized to see. Every draft is `origin: agent_drafted`, `status: drafted`, with
 * `expectedEvidence: []` until an eligible reviewer approves (F35 ignores unapproved cases).
 *
 * This slice is the pure drafter. Persisting rows (`create_eval_case_draft_v1`) and writing files
 * under `evals/<expert>/drafts/` are callers' jobs; T-315 owns the first committed corpus drafts.
 */

const SYNTH_FIXTURE = /^SYNTH-[A-Z0-9-]+$/;

export interface PublishedSourceVersion {
  /** Published source_versions.id — carried in expectedSource for the reviewer. */
  sourceVersionId: string;
  collectionId: string;
  dataClass: DataClass;
  /** Synthetic fixture id only (AGENTS.md §4.7). */
  fixtureId: string;
  /** Human review aid: page/section/sheet text (not a quotation of client prose). */
  locatorHint: string;
  projectScope: string | null;
  question: string;
  answerPoints: readonly string[];
  claimTypes: readonly ClaimType[];
  caseType: CaseType;
  /** Optional adversarial tag; F34 from publish is usually null (builders add bait in step 2). */
  adversarialClass?: AdversarialClass | null;
  isolationBait?: boolean;
  expectedAnswerStatus?: ExpectedAnswerStatus;
  citationRequired?: boolean;
  forbiddenClaims?: readonly string[];
  expectedRefusalKey?: EvalCase["expectedRefusalKey"];
}

export interface DraftEvalCasesInput {
  expertKey: ExpertKey;
  /** Collections this reviewing expert may read — anything else produces zero drafts. */
  readableCollectionIds: ReadonlySet<string>;
  publishedVersions: readonly PublishedSourceVersion[];
  draftedBy: string;
  draftedOn: string;
  /** Case id stem before a zero-padded sequence (default `<expertKey>` upper prefix + `-D`). */
  caseIdPrefix?: string;
}

function caseIdPrefixFor(expertKey: ExpertKey, explicit: string | undefined): string {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();
  if (expertKey === "uav-expert") return "UAV-D";
  if (expertKey === "gpr-expert") return "GPR-D";
  return `${expertKey}-D`;
}

/**
 * Draft candidate eval cases from published versions the expert can read.
 * Unauthorized collections are skipped entirely — they do not exist in this expert's draft set.
 */
export function draftEvalCases(input: DraftEvalCasesInput): EvalCase[] {
  if (input.draftedBy.trim().length === 0) {
    throw new Error("draftEvalCases: draftedBy is required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.draftedOn)) {
    throw new Error("draftEvalCases: draftedOn must be YYYY-MM-DD");
  }

  const prefix = caseIdPrefixFor(input.expertKey, input.caseIdPrefix);
  const drafts: EvalCase[] = [];
  let seq = 0;

  for (const version of input.publishedVersions) {
    if (!input.readableCollectionIds.has(version.collectionId)) {
      continue;
    }
    if (!SYNTH_FIXTURE.test(version.fixtureId)) {
      throw new Error(
        `draftEvalCases: fixtureId '${version.fixtureId}' must be SYNTH-… (AGENTS.md §4.7)`,
      );
    }
    if (version.question.trim().length === 0) {
      throw new Error("draftEvalCases: question is required");
    }
    if (version.answerPoints.length === 0 || version.answerPoints.some((p) => p.trim().length === 0)) {
      throw new Error("draftEvalCases: answerPoints must be non-empty");
    }
    if (version.claimTypes.length === 0) {
      throw new Error("draftEvalCases: claimTypes must be non-empty");
    }
    CaseType.parse(version.caseType);

    seq += 1;
    const caseId = `${prefix}${String(seq).padStart(3, "0")}`;
    const expectedAnswerStatus = version.expectedAnswerStatus ?? "answered";
    const refused =
      expectedAnswerStatus === "refused" || expectedAnswerStatus === "unavailable";
    const citationRequired = version.citationRequired ?? !refused;

    const raw = {
      schemaVersion: 1 as const,
      caseId,
      expertKey: input.expertKey,
      status: "drafted" as const,
      origin: "agent_drafted" as const,
      caseType: version.caseType,
      question: version.question,
      expectedAnswerPoints: [...version.answerPoints],
      expectedClaimTypes: [...version.claimTypes],
      expectedAnswerStatus,
      citationRequired,
      dataClass: version.dataClass,
      projectScope: version.projectScope,
      forbiddenClaims: [...(version.forbiddenClaims ?? [])],
      isolationBait: version.isolationBait ?? false,
      adversarialClass: version.adversarialClass ?? null,
      expectedSource: `${version.fixtureId} ${version.locatorHint} sourceVersionId:${version.sourceVersionId}`,
      expectedFixtures: [version.fixtureId],
      expectedEvidence: [] as const,
      approvedBy: null,
      approvedAt: null,
      draftedBy: input.draftedBy,
      draftedOn: input.draftedOn,
      ...(version.expectedRefusalKey !== undefined
        ? { expectedRefusalKey: version.expectedRefusalKey }
        : {}),
    };

    drafts.push(EvalCase.parse(raw));
  }

  return drafts;
}
