import { z } from "zod";

import type { TenantContext } from "@/contracts/tenant-context";
import {
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

/**
 * Typed client for the T-303 review queue (`20261125100000_eval_review_queue.sql`): list, read and
 * decide eval cases. Tenant comes only from `TenantContext` through `withTenantRpc`; the reviewer is
 * `auth.uid()` server-side, so nothing here (or in a page body) can name one (AGENTS.md §4.1).
 * Visibility and every decision rule are enforced in SQL; this client only shapes rows and maps
 * refusals onto employee-safe messages.
 */

export interface EvalReviewDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export type EvalCaseStatusFilter = "drafted" | "approved" | null;
export type EvalReviewDecision = "approve" | "edit" | "reject";

export interface EvalCaseLocator {
  sourceVersionId: string;
  chunkId: string | null;
}

export interface EvalReviewCase {
  id: string;
  caseKey: string;
  expertKey: string;
  status: "drafted" | "approved";
  origin: "agent_drafted" | "expert_written" | "pilot";
  caseType: "answerable" | "needs_clarification" | "must_refuse" | "out_of_scope";
  question: string;
  dataClass: string;
  expectedAnswerPoints: string[];
  expectedSource: string | null;
  locators: EvalCaseLocator[];
  approvedBy: string | null;
  approvedAt: string | null;
  updatedAt: string;
  authorIsCaller: boolean;
  sourcesValid: boolean;
  lastDecision: EvalReviewDecision | null;
  lastDecidedAt: string | null;
}

export type EvalReviewFailureKind =
  | "validation"
  | "conflict"
  | "source_invalid"
  | "no_access"
  | "backend_failure";

export interface EvalReviewFailure {
  ok: false;
  kind: EvalReviewFailureKind;
  message: string;
}

/** Fixed employee-safe copy: no SQLSTATE, table, tenant or other user's name. */
export const SAFE_EVAL_REVIEW_MESSAGE: Record<EvalReviewFailureKind, string> = {
  validation: "Check the fields and try again.",
  conflict: "This case changed since you opened it. Reload it and decide again.",
  source_invalid: "An expected source for this case was revoked or is no longer available, so it cannot be approved.",
  no_access: "You cannot review this case.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
};

const UUID = z.uuid();
const SOURCE_VERSION_IN_TEXT = /sourceVersionId:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

const Row = z.object({
  id: UUID,
  case_key: z.string().min(1),
  expert_key: z.string().min(1),
  status: z.enum(["drafted", "approved"]),
  origin: z.enum(["agent_drafted", "expert_written", "pilot"]),
  case_type: z.enum(["answerable", "needs_clarification", "must_refuse", "out_of_scope"]),
  question: z.string().min(1),
  data_class: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  approved_by: UUID.nullable(),
  approved_at: z.string().nullable(),
  updated_at: z.string().min(1),
  author_is_caller: z.boolean(),
  sources_valid: z.boolean(),
  last_decision: z.enum(["approve", "edit", "reject"]).nullable(),
  last_decided_at: z.string().nullable(),
});

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Locators from `expectedEvidence` and from `sourceVersionId:<uuid>` in `expectedSource` (as SQL reads them). */
export function locatorsFromPayload(payload: Readonly<Record<string, unknown>>): EvalCaseLocator[] {
  const seen = new Set<string>();
  const out: EvalCaseLocator[] = [];
  const evidence = Array.isArray(payload.expectedEvidence) ? payload.expectedEvidence : [];
  for (const entry of evidence) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.sourceVersionId === "string" ? raw.sourceVersionId.toLowerCase() : "";
    if (!UUID.safeParse(id).success) continue;
    const chunkId = typeof raw.chunkId === "string" && raw.chunkId.length > 0 ? raw.chunkId : null;
    const key = id + "|" + (chunkId ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceVersionId: id, chunkId });
  }
  const text = typeof payload.expectedSource === "string" ? payload.expectedSource : "";
  for (const match of text.matchAll(SOURCE_VERSION_IN_TEXT)) {
    const id = (match[1] ?? "").toLowerCase();
    if (out.some((l) => l.sourceVersionId === id)) continue;
    out.push({ sourceVersionId: id, chunkId: null });
  }
  return out;
}

function toCase(row: z.infer<typeof Row>): EvalReviewCase {
  const payload = row.payload;
  return {
    id: row.id,
    caseKey: row.case_key,
    expertKey: row.expert_key,
    status: row.status,
    origin: row.origin,
    caseType: row.case_type,
    question: row.question,
    dataClass: row.data_class,
    expectedAnswerPoints: stringList(payload.expectedAnswerPoints),
    expectedSource: typeof payload.expectedSource === "string" ? payload.expectedSource : null,
    locators: locatorsFromPayload(payload),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    updatedAt: row.updated_at,
    authorIsCaller: row.author_is_caller,
    sourcesValid: row.sources_valid,
    lastDecision: row.last_decision,
    lastDecidedAt: row.last_decided_at,
  };
}

function mapFailure(failure: TenantRpcFailure): EvalReviewFailure {
  if (failure.kind === "tenancy") {
    return { ok: false, kind: "no_access", message: SAFE_EVAL_REVIEW_MESSAGE.no_access };
  }
  // PostgREST answers 22xxx with 400 but 40001/55000 with 500, so the SQLSTATE decides, not the status.
  if (failure.kind === "backend_failure" && failure.sqlstate !== undefined) {
    const kind: EvalReviewFailureKind =
      failure.sqlstate === "22023" || failure.sqlstate === "22P02" || failure.sqlstate === "23514"
        ? "validation"
        : failure.sqlstate === "40001"
          ? "conflict"
          : failure.sqlstate === "55000"
            ? "source_invalid"
            : "backend_failure";
    return { ok: false, kind, message: SAFE_EVAL_REVIEW_MESSAGE[kind] };
  }
  return { ok: false, kind: "backend_failure", message: SAFE_EVAL_REVIEW_MESSAGE.backend_failure };
}

function rpcConfig(deps: EvalReviewDeps) {
  return { postgrestBaseUrl: deps.postgrestBaseUrl, fetchImpl: deps.fetchImpl };
}

function parseRows(data: unknown): EvalReviewCase[] | undefined {
  const parsed = z.array(Row).safeParse(data);
  return parsed.success ? parsed.data.map(toCase) : undefined;
}

export type ListEvalReviewOutcome = { ok: true; cases: EvalReviewCase[] } | EvalReviewFailure;
export type GetEvalReviewOutcome = { ok: true; case: EvalReviewCase | null } | EvalReviewFailure;
export type DecideEvalCaseOutcome = { ok: true; updatedAt: string } | EvalReviewFailure;

export async function listEvalReviewQueue(
  context: TenantContext,
  accessToken: string,
  status: EvalCaseStatusFilter,
  deps: EvalReviewDeps,
): Promise<ListEvalReviewOutcome> {
  const outcome = await withTenantRpc(context, "list_eval_review_queue_v1", { p_status: status }, accessToken, rpcConfig(deps));
  if (!outcome.ok) return mapFailure(outcome);
  const cases = parseRows(outcome.data);
  if (cases === undefined) {
    return { ok: false, kind: "backend_failure", message: SAFE_EVAL_REVIEW_MESSAGE.backend_failure };
  }
  return { ok: true, cases };
}

/** A hidden, foreign or absent case all read as `case: null` — no existence signal. */
export async function getEvalReviewCase(
  context: TenantContext,
  accessToken: string,
  caseId: string,
  deps: EvalReviewDeps,
): Promise<GetEvalReviewOutcome> {
  if (!UUID.safeParse(caseId).success) return { ok: true, case: null };
  const outcome = await withTenantRpc(context, "get_eval_review_case_v1", { p_case_id: caseId }, accessToken, rpcConfig(deps));
  if (!outcome.ok) return mapFailure(outcome);
  const cases = parseRows(outcome.data);
  if (cases === undefined || cases.length > 1) {
    return { ok: false, kind: "backend_failure", message: SAFE_EVAL_REVIEW_MESSAGE.backend_failure };
  }
  return { ok: true, case: cases[0] ?? null };
}

export interface DecideEvalCaseInput {
  caseId: string;
  decision: EvalReviewDecision;
  edits: Readonly<Record<string, unknown>>;
  /** `updatedAt` as read; a stale value is a conflict (40001), never an overwrite. */
  expectedUpdatedAt: string;
}

export async function decideEvalCase(
  context: TenantContext,
  accessToken: string,
  input: DecideEvalCaseInput,
  deps: EvalReviewDeps,
): Promise<DecideEvalCaseOutcome> {
  const outcome = await withTenantRpc(
    context,
    "decide_eval_case_v1",
    {
      p_case_id: input.caseId,
      p_decision: input.decision,
      p_edits: input.edits,
      p_expected_updated_at: input.expectedUpdatedAt,
    },
    accessToken,
    rpcConfig(deps),
  );
  if (!outcome.ok) return mapFailure(outcome);
  if (typeof outcome.data !== "string" || Number.isNaN(Date.parse(outcome.data))) {
    return { ok: false, kind: "backend_failure", message: SAFE_EVAL_REVIEW_MESSAGE.backend_failure };
  }
  return { ok: true, updatedAt: outcome.data };
}
