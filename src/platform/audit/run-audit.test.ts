import { describe, expect, it } from "vitest";

import {
  commitRunResult,
  createInMemoryRunAuditStore,
  type CommitRunResultInput,
  type RunAttemptAudit,
} from "./run-audit";

const ORG = "11111111-1111-4111-8111-111111111111";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const ATTEMPT: RunAttemptAudit = {
  attemptId: `${RUN}:0:compose`,
  providerKey: "local_box",
  chainPosition: 0,
  capabilityTier: "small",
  outcome: "answered",
  model: "open-weights-alpha",
  matrixRevision: "matrix-1",
  reservedUnits: { maxInputUnits: 40, maxOutputUnits: 60 },
  reconciled: "settled",
  recordedAt: "2026-11-23T16:00:00.000Z",
};

function commitInput(
  overrides: Partial<CommitRunResultInput> = {},
): CommitRunResultInput {
  return {
    organisationId: ORG,
    runId: RUN,
    conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    expertKey: "uav-expert",
    expertVersions: ["uav-expert@1"],
    corpusGenerations: [2],
    policyRevision: 4,
    policyRevisionDelivered: 4,
    dataClass: "internal",
    answerStatus: "answered",
    answerFingerprint: "sha256:synth",
    matrixRevision: "matrix-1",
    attempts: [ATTEMPT],
    ...overrides,
  };
}

describe("commitRunResult (F22 / F40)", () => {
  it("persists audit before the caller may deliver content", async () => {
    const store = createInMemoryRunAuditStore();
    let delivered = false;

    const result = await commitRunResult(store, commitInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected commit");

    // Delivery is gated on a successful commit — the test is the order, not a framework hook.
    if (result.ok) delivered = true;

    expect(delivered).toBe(true);
    expect(store.commits()).toHaveLength(1);
    expect(store.commits()[0]?.auditId).toBe(result.auditId);
    expect(await store.listAttempts(ORG, RUN)).toHaveLength(1);
  });

  it("refuses to deliver when the audit write fails after a provider attempt", async () => {
    const store = createInMemoryRunAuditStore({ failCommit: true });
    const result = await commitRunResult(store, commitInput());

    expect(result).toEqual({ ok: false, reason: "persist_failed" });
    expect(store.commits()).toHaveLength(0);
    // Attempts were appended (provider already ran); reservation recovery is T-313 budgets' job.
    expect(await store.listAttempts(ORG, RUN)).toHaveLength(1);
  });

  it("is append-only: a second commit for the same run is refused", async () => {
    const store = createInMemoryRunAuditStore();
    expect((await commitRunResult(store, commitInput())).ok).toBe(true);
    expect(await commitRunResult(store, commitInput())).toEqual({
      ok: false,
      reason: "already_committed",
    });
    expect(store.commits()).toHaveLength(1);
  });

  it("refuses a commit with no attempts (nothing was metered or routed)", async () => {
    const store = createInMemoryRunAuditStore();
    expect(await commitRunResult(store, commitInput({ attempts: [] }))).toEqual({
      ok: false,
      reason: "missing_attempts",
    });
  });

  it("appendAttempt is idempotent on attemptId (duplicate outbox)", async () => {
    const store = createInMemoryRunAuditStore();
    await store.appendAttempt(ORG, RUN, ATTEMPT);
    await store.appendAttempt(ORG, RUN, ATTEMPT);
    expect(await store.listAttempts(ORG, RUN)).toHaveLength(1);
  });

  it("keeps provider/model identity in the audit record and never invents employee-visible copy", async () => {
    const store = createInMemoryRunAuditStore();
    const result = await commitRunResult(store, commitInput());
    expect(result.ok).toBe(true);
    const committed = store.commits()[0];
    expect(committed?.attempts[0]?.providerKey).toBe("local_box");
    expect(committed?.attempts[0]?.model).toBe("open-weights-alpha");
    expect(committed?.matrixRevision).toBe("matrix-1");
    // No employee-facing string fields on the commit result.
    expect(result).not.toHaveProperty("message");
  });
});
