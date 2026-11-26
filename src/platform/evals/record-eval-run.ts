import type { TenantContext } from "@/contracts/tenant-context";

import {
  SAFE_TENANT_RPC_MESSAGE,
  withTenantRpc,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

import type { EvalRunRow } from "./run";
import type { EvalCaseScore } from "./score";

const CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { FetchImpl };

export interface RecordEvalRunDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export type RecordEvalRunNotReadyReason =
  | "case_uuid_unmapped"
  | "case_uuid_invalid"
  | TenantRpcFailure["kind"];

export type RecordEvalRunOutcome =
  | { ok: true; runId: string }
  | { ok: false; reason: RecordEvalRunNotReadyReason; employeeMessage: string };

/** Employee-visible copy when persistence fails; names no SQLSTATE, tenant or case id. */
export const SAFE_RECORD_EVAL_RUN_MESSAGE: Record<RecordEvalRunNotReadyReason, string> = {
  case_uuid_unmapped: SAFE_TENANT_RPC_MESSAGE.backend_failure,
  case_uuid_invalid: SAFE_TENANT_RPC_MESSAGE.backend_failure,
  tenancy: SAFE_TENANT_RPC_MESSAGE.tenancy,
  backend_failure: SAFE_TENANT_RPC_MESSAGE.backend_failure,
  not_configured: SAFE_TENANT_RPC_MESSAGE.not_configured,
};

export function buildRecordEvalRunBodies(
  run: EvalRunRow,
  caseIdToUuid: Readonly<Record<string, string>>,
):
  | { ok: true; p_run: Record<string, unknown>; p_results: Record<string, unknown>[] }
  | { ok: false; reason: "case_uuid_unmapped" | "case_uuid_invalid"; caseId: string } {
  const p_run = {
    expert_key: run.expertKey,
    expert_version: run.expertVersion,
    chain_config: run.chainConfig,
    corpus_generation: run.corpusGeneration,
    status: run.status,
  };

  const p_results: Record<string, unknown>[] = [];
  for (const row of run.results) {
    const mapped = caseIdToUuid[row.caseId];
    if (mapped === undefined) {
      return { ok: false, reason: "case_uuid_unmapped", caseId: row.caseId };
    }
    if (!CASE_UUID.test(mapped)) {
      return { ok: false, reason: "case_uuid_invalid", caseId: row.caseId };
    }
    p_results.push(scoreRowToRpc(row, mapped));
  }

  return { ok: true, p_run, p_results };
}

function scoreRowToRpc(row: EvalCaseScore, caseUuid: string): Record<string, unknown> {
  return {
    case_id: caseUuid,
    score: row.score,
    failure_class: row.failureClass,
    evidence: row.evidence,
  };
}

/**
 * Append-only F35 persistence via `record_eval_run_v1` (T-312 PR-5). Maps fixture `caseId` strings to
 * database ids supplied by the caller — never invented here.
 */
export async function recordEvalRun(
  context: TenantContext,
  accessToken: string,
  run: EvalRunRow,
  caseIdToUuid: Readonly<Record<string, string>>,
  deps: RecordEvalRunDeps,
): Promise<RecordEvalRunOutcome> {
  const bodies = buildRecordEvalRunBodies(run, caseIdToUuid);
  if (!bodies.ok) {
    const reason = bodies.reason;
    return { ok: false, reason, employeeMessage: SAFE_RECORD_EVAL_RUN_MESSAGE[reason] };
  }

  const outcome = await withTenantRpc(
    context,
    "record_eval_run_v1",
    { p_run: bodies.p_run, p_results: bodies.p_results },
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

  const runId = parseRunId(outcome.data);
  if (runId === undefined) {
    return {
      ok: false,
      reason: "backend_failure",
      employeeMessage: SAFE_TENANT_RPC_MESSAGE.backend_failure,
    };
  }

  return { ok: true, runId };
}

function parseRunId(data: unknown): string | undefined {
  if (typeof data === "string" && CASE_UUID.test(data)) return data;
  return undefined;
}