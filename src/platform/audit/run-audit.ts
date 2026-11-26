import type { CapabilityTier } from "@/contracts/provider-route";
import type { ProviderKey } from "@/contracts/keys";
import type { DataClass } from "@/contracts/data-class";

/**
 * T-313 PR-5: F22 / F40 run-audit writer (plan §9.3, §12.3, §17.1).
 *
 * Append-only attempt ledger + final commit. Delivery is the caller's job: this module only records.
 * Persisting into `agent_runs` (T-104 / #178) is a later adapter; today the port is opaque on
 * `runId` the same way `budget_reservations.run_id` is.
 *
 * Employee-visible surfaces must never receive these records (§9.3): they name providers and models.
 */

export type AttemptOutcome =
  | "answered"
  | "connection"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "invalid_output"
  | "context_overflow"
  | "provider_unavailable"
  | "skipped_quota"
  | "skipped_circuit"
  | "skipped_clearance";

export interface RunAttemptAudit {
  attemptId: string;
  providerKey: ProviderKey;
  chainPosition: number;
  capabilityTier: CapabilityTier;
  outcome: AttemptOutcome;
  model: string | null;
  matrixRevision: string;
  reservedUnits: { maxInputUnits: number; maxOutputUnits: number };
  reconciled: "settled" | "released" | "ambiguous" | null;
  recordedAt: string;
}

export interface CommitRunResultInput {
  organisationId: string;
  runId: string;
  conversationId: string | null;
  expertKey: string;
  expertVersions: readonly string[];
  corpusGenerations: readonly number[];
  policyRevision: number;
  policyRevisionDelivered: number;
  dataClass: DataClass;
  answerStatus: "answered" | "partial" | "refused" | "unavailable";
  /** Opaque answer payload already validated by the chat contract — never logged here. */
  answerFingerprint: string;
  matrixRevision: string;
  attempts: readonly RunAttemptAudit[];
}

export type CommitRunResult =
  | { ok: true; auditId: string; committedAt: string }
  | { ok: false; reason: "already_committed" | "missing_attempts" | "persist_failed" };

export interface RunAuditStore {
  appendAttempt(
    organisationId: string,
    runId: string,
    attempt: RunAttemptAudit,
  ): Promise<void>;
  listAttempts(organisationId: string, runId: string): Promise<readonly RunAttemptAudit[]>;
  commit(input: CommitRunResultInput): Promise<CommitRunResult>;
  isCommitted(organisationId: string, runId: string): Promise<boolean>;
}

/**
 * F22: persist the audit (and the caller's final answer fingerprint) **before** any delivery.
 * Returns the commit result; the caller must not stream factual content unless `ok: true`.
 */
export async function commitRunResult(
  store: RunAuditStore,
  input: CommitRunResultInput,
): Promise<CommitRunResult> {
  if (input.attempts.length === 0) {
    return { ok: false, reason: "missing_attempts" };
  }
  if (await store.isCommitted(input.organisationId, input.runId)) {
    return { ok: false, reason: "already_committed" };
  }
  for (const attempt of input.attempts) {
    await store.appendAttempt(input.organisationId, input.runId, attempt);
  }
  return store.commit(input);
}

/**
 * In-memory append-only audit store for unit tests and Worker-isolate admission proofs.
 * Production Hyperdrive/SQL adapter lands with T-104 `agent_runs` (#178).
 */
export function createInMemoryRunAuditStore(options: {
  failCommit?: boolean;
} = {}): RunAuditStore & {
  commits: () => ReadonlyArray<CommitRunResultInput & { auditId: string; committedAt: string }>;
} {
  const attempts = new Map<string, RunAttemptAudit[]>();
  const commits: Array<CommitRunResultInput & { auditId: string; committedAt: string }> = [];
  let nextId = 1;

  const keyOf = (organisationId: string, runId: string) => `${organisationId}:${runId}`;

  return {
    commits: () => commits,
    async appendAttempt(organisationId, runId, attempt) {
      const key = keyOf(organisationId, runId);
      const list = attempts.get(key) ?? [];
      if (list.some((row) => row.attemptId === attempt.attemptId)) {
        return; // idempotent on attemptId
      }
      list.push(attempt);
      attempts.set(key, list);
    },
    async listAttempts(organisationId, runId) {
      return attempts.get(keyOf(organisationId, runId)) ?? [];
    },
    async isCommitted(organisationId, runId) {
      return commits.some((row) => row.organisationId === organisationId && row.runId === runId);
    },
    async commit(input) {
      if (options.failCommit) {
        return { ok: false, reason: "persist_failed" };
      }
      if (commits.some((row) => row.organisationId === input.organisationId && row.runId === input.runId)) {
        return { ok: false, reason: "already_committed" };
      }
      const auditId = `audit-${nextId++}`;
      const committedAt = new Date().toISOString();
      commits.push({ ...input, auditId, committedAt });
      return { ok: true, auditId, committedAt };
    },
  };
}
