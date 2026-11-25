import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import {
  SAFE_EVAL_REVIEW_MESSAGE,
  decideEvalCase,
  getEvalReviewCase,
  listEvalReviewQueue,
  locatorsFromPayload,
} from "./review-queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN = "header.payload.signature";
const CASE_ID = "e3030000-0000-4000-8000-000000000001";
const SV = "71000000-0000-4000-8000-000000000001";
const DEPS_BASE = "http://127.0.0.1:1";

const CTX = createTenantContext({
  organisationId: ORG,
  host: "company1.terraoi.test",
  userId: "00000000-0000-4000-8000-0000000000a2",
  membershipId: "55555555-5555-4555-8555-555555555555",
  membershipStatus: "active",
  roles: ["member"],
  permittedServiceKeys: [],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-25T00:00:00.000Z",
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    case_key: "UAV-D001",
    expert_key: "uav-expert",
    status: "drafted",
    origin: "agent_drafted",
    case_type: "answerable",
    question: "Synthetic question?",
    data_class: "public",
    payload: {
      expectedAnswerPoints: ["Point one.", "", 7],
      expectedSource: `SYNTH-UAV-0001 p.3 sourceVersionId:${SV}`,
    },
    approved_by: null,
    approved_at: null,
    updated_at: "2026-11-25T10:00:00.123456+00:00",
    author_is_caller: false,
    sources_valid: true,
    last_decision: null,
    last_decided_at: null,
    ...overrides,
  };
}

function transport(answer: () => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    sent.push({ url: input, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") });
    return answer();
  };
  return { sent, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("listEvalReviewQueue (T-303)", () => {
  it("shapes rows: answer points, locator from expectedSource, version token", async () => {
    const { sent, fetchImpl } = transport(() => json([row()]));
    const outcome = await listEvalReviewQueue(CTX, TOKEN, "drafted", { postgrestBaseUrl: DEPS_BASE, fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cases[0]?.expectedAnswerPoints).toEqual(["Point one."]);
    expect(outcome.cases[0]?.locators).toEqual([{ sourceVersionId: SV, chunkId: null }]);
    expect(outcome.cases[0]?.updatedAt).toBe("2026-11-25T10:00:00.123456+00:00");
    expect(sent[0]?.url).toMatch(/\/rpc\/list_eval_review_queue_v1$/);
    expect(sent[0]?.body).toEqual({ p_status: "drafted", p_organisation_id: ORG });
  });

  it("fails closed on a malformed row rather than showing a partial case", async () => {
    const { fetchImpl } = transport(() => json([row({ status: "published" })]));
    const outcome = await listEvalReviewQueue(CTX, TOKEN, null, { postgrestBaseUrl: DEPS_BASE, fetchImpl });
    expect(outcome).toEqual({ ok: false, kind: "backend_failure", message: SAFE_EVAL_REVIEW_MESSAGE.backend_failure });
  });

  it("maps a scope refusal (suspended member) to no_access", async () => {
    const { fetchImpl } = transport(() => json({ code: "28000", message: "not an active member" }, 403));
    const outcome = await listEvalReviewQueue(CTX, TOKEN, null, { postgrestBaseUrl: DEPS_BASE, fetchImpl });
    expect(outcome).toEqual({ ok: false, kind: "no_access", message: SAFE_EVAL_REVIEW_MESSAGE.no_access });
  });
});

describe("getEvalReviewCase (T-303)", () => {
  it("returns null for no row: hidden, foreign and absent cases look the same", async () => {
    const { fetchImpl } = transport(() => json([]));
    expect(await getEvalReviewCase(CTX, TOKEN, CASE_ID, { postgrestBaseUrl: DEPS_BASE, fetchImpl })).toEqual({
      ok: true,
      case: null,
    });
  });

  it("does not dial the database for a non-uuid id", async () => {
    const { sent, fetchImpl } = transport(() => json([row()]));
    expect(await getEvalReviewCase(CTX, TOKEN, "../x", { postgrestBaseUrl: DEPS_BASE, fetchImpl })).toEqual({
      ok: true,
      case: null,
    });
    expect(sent).toHaveLength(0);
  });
});

describe("decideEvalCase (T-303)", () => {
  it("sends decision, edits and the version token; never an organisation or reviewer from the caller", async () => {
    const { sent, fetchImpl } = transport(() => json("2026-11-25T10:05:00+00:00"));
    const outcome = await decideEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "edit", edits: { question: "Q?" }, expectedUpdatedAt: "2026-11-25T10:00:00+00:00" },
      { postgrestBaseUrl: DEPS_BASE, fetchImpl },
    );
    expect(outcome).toEqual({ ok: true, updatedAt: "2026-11-25T10:05:00+00:00" });
    expect(sent[0]?.url).toMatch(/\/rpc\/decide_eval_case_v1$/);
    expect(sent[0]?.body).toEqual({
      p_case_id: CASE_ID,
      p_decision: "edit",
      p_edits: { question: "Q?" },
      p_expected_updated_at: "2026-11-25T10:00:00+00:00",
      p_organisation_id: ORG,
    });
  });

  it.each([
    ["22023", 400, "validation"],
    ["40001", 500, "conflict"],
    ["55000", 500, "source_invalid"],
    ["42501", 403, "no_access"],
    ["XX000", 500, "backend_failure"],
  ] as const)("maps SQLSTATE %s to %s", async (code, status, kind) => {
    const { fetchImpl } = transport(() => json({ code, message: "raw database text" }, status));
    const outcome = await decideEvalCase(
      CTX,
      TOKEN,
      { caseId: CASE_ID, decision: "approve", edits: {}, expectedUpdatedAt: "2026-11-25T10:00:00+00:00" },
      { postgrestBaseUrl: DEPS_BASE, fetchImpl },
    );
    expect(outcome).toEqual({ ok: false, kind, message: SAFE_EVAL_REVIEW_MESSAGE[kind] });
    expect(JSON.stringify(outcome)).not.toContain("raw database text");
  });
});

describe("locatorsFromPayload", () => {
  it("reads chunk evidence and inline references, deduplicated, ignoring junk", () => {
    expect(
      locatorsFromPayload({
        expectedEvidence: [
          { kind: "chunk", sourceVersionId: SV, chunkId: "c-1" },
          { kind: "chunk", sourceVersionId: "not-a-uuid" },
          null,
        ],
        expectedSource: `see sourceVersionId:${SV} and sourceVersionId:71000000-0000-4000-8000-000000000002`,
      }),
    ).toEqual([
      { sourceVersionId: SV, chunkId: "c-1" },
      { sourceVersionId: "71000000-0000-4000-8000-000000000002", chunkId: null },
    ]);
  });
});
