import type { TenantContext } from "@/contracts/tenant-context";

import {
  SAFE_TENANT_RPC_MESSAGE,
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

export type { FetchImpl };

export interface ExportApprovedEvalCasesDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

/**
 * One approved non-pilot row from `export_approved_eval_cases_v1` (#82 / #102).
 * Column fields are authoritative; `payload` holds the remaining EvalCase body keys.
 */
export interface ExportedEvalCase {
  id: string;
  caseKey: string;
  expertKey: string;
  origin: string;
  question: string;
  dataClass: string;
  approvedBy: string;
  approvedAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export type ExportApprovedEvalCasesOutcome =
  | { ok: true; cases: ReadonlyArray<ExportedEvalCase> }
  | { ok: false; reason: TenantRpcFailure["kind"]; employeeMessage: string };

/**
 * Scoped export via `export_approved_eval_cases_v1`. Tenant comes only from `TenantContext`
 * through `withTenantRpc`. SQL already omits `origin = 'pilot'`; the in-memory mapper still refuses
 * pilot if a row ever appears (#102).
 */
export async function exportApprovedEvalCases(
  context: TenantContext,
  accessToken: string,
  deps: ExportApprovedEvalCasesDeps,
): Promise<ExportApprovedEvalCasesOutcome> {
  const outcome = await withTenantRpc(
    context,
    "export_approved_eval_cases_v1",
    {},
    accessToken,
    { postgrestBaseUrl: deps.postgrestBaseUrl, fetchImpl: deps.fetchImpl },
  );

  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.kind,
      employeeMessage: SAFE_TENANT_RPC_MESSAGE[outcome.kind],
    };
  }

  const cases = parseExportedCases(outcome.data);
  if (cases === undefined) {
    return {
      ok: false,
      reason: "backend_failure",
      employeeMessage: SAFE_TENANT_RPC_MESSAGE.backend_failure,
    };
  }

  return { ok: true, cases };
}

/**
 * Pure in-memory map from an exported row to EvalCase-shaped JSON (no filesystem I/O).
 * Column fields overlay `payload`. Refuses `origin === "pilot"` even if SQL returned one (#102).
 */
export function exportedCaseToEvalCaseJson(
  row: ExportedEvalCase,
): Record<string, unknown> | undefined {
  if (row.origin === "pilot") return undefined;
  return {
    ...row.payload,
    caseId: row.caseKey,
    expertKey: row.expertKey,
    origin: row.origin,
    question: row.question,
    dataClass: row.dataClass,
    status: "approved",
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
  };
}

function parseExportedCases(data: unknown): ExportedEvalCase[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const cases: ExportedEvalCase[] = [];
  for (const item of data) {
    const row = parseExportedCase(item);
    if (row === undefined) return undefined;
    cases.push(row);
  }
  return cases;
}

function parseExportedCase(item: unknown): ExportedEvalCase | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const raw = item as Record<string, unknown>;
  const id = raw.id;
  const caseKey = raw.case_key;
  const expertKey = raw.expert_key;
  const origin = raw.origin;
  const question = raw.question;
  const dataClass = raw.data_class;
  const approvedBy = raw.approved_by;
  const approvedAt = raw.approved_at;
  const payload = raw.payload;

  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof caseKey !== "string" || caseKey.length === 0) return undefined;
  if (typeof expertKey !== "string" || expertKey.length === 0) return undefined;
  if (typeof origin !== "string" || origin.length === 0) return undefined;
  if (typeof question !== "string" || question.length === 0) return undefined;
  if (typeof dataClass !== "string" || dataClass.length === 0) return undefined;
  if (typeof approvedBy !== "string" || approvedBy.length === 0) return undefined;
  if (typeof approvedAt !== "string" || approvedAt.length === 0) return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;

  return {
    id,
    caseKey,
    expertKey,
    origin,
    question,
    dataClass,
    approvedBy,
    approvedAt,
    payload: payload as Record<string, unknown>,
  };
}
