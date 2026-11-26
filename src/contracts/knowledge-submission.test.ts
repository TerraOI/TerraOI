import { describe, expect, it } from "vitest";

import {
  CreateKnowledgeSubmissionRequest,
  ReviewKnowledgeSubmissionRequest,
} from "./knowledge-submission";

const COLLECTION = "51000000-0000-4000-8000-000000000001";
const VERSION = "71000000-0000-4000-8000-000000000001";

describe("CreateKnowledgeSubmissionRequest", () => {
  it("accepts a bounded create body and defaults cited ids", () => {
    const parsed = CreateKnowledgeSubmissionRequest.parse({
      collectionId: COLLECTION,
      kind: "answer",
      proposedText: "Synthetic note body.",
      contextDataClass: "public",
    });
    expect(parsed.citedSourceVersionIds).toEqual([]);
    expect(parsed.kind).toBe("answer");
  });

  it("refuses organisationId, final dataClass, and restricted context", () => {
    expect(
      CreateKnowledgeSubmissionRequest.safeParse({
        organisationId: "11111111-1111-4111-8111-111111111111",
        collectionId: COLLECTION,
        kind: "note",
        proposedText: "x",
        contextDataClass: "public",
      }).success,
    ).toBe(false);
    expect(
      CreateKnowledgeSubmissionRequest.safeParse({
        collectionId: COLLECTION,
        kind: "note",
        proposedText: "x",
        contextDataClass: "public",
        dataClass: "internal",
      }).success,
    ).toBe(false);
    expect(
      CreateKnowledgeSubmissionRequest.safeParse({
        collectionId: COLLECTION,
        kind: "note",
        proposedText: "x",
        contextDataClass: "restricted",
      }).success,
    ).toBe(false);
  });

  it("accepts citations and an opaque run id", () => {
    const parsed = CreateKnowledgeSubmissionRequest.parse({
      collectionId: COLLECTION,
      kind: "correction",
      proposedText: "Corrected procedure text.",
      contextDataClass: "internal",
      citedSourceVersionIds: [VERSION],
      agentRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    });
    expect(parsed.citedSourceVersionIds).toEqual([VERSION]);
    expect(parsed.agentRunId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
  });
});

describe("ReviewKnowledgeSubmissionRequest", () => {
  it("accepts approve/reject and refuses org id", () => {
    expect(ReviewKnowledgeSubmissionRequest.parse({ decision: "approve" }).decision).toBe("approve");
    expect(
      ReviewKnowledgeSubmissionRequest.safeParse({
        decision: "reject",
        reason: "not policy",
        organisationId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });
});
