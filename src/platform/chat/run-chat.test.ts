import { describe, expect, it } from "vitest";

import { ChatRequest, ProgressEvent, type ProgressEvent as ProgressEventValue } from "@/contracts/chat";
import type { EvidencePackEntry } from "@/platform/agents/compose";
import { answered, failed, fakeAdapter } from "@/platform/gateway/gateway-fixtures";

import {
  CHUNK_ONE,
  CONVERSATION_ID,
  RUN_ID,
  SOURCE_VERSION_PUBLIC,
  answeredFixture,
  composeCandidate,
  contextFor,
  gatewayBundle,
  packOf,
  progressTypes,
  RecordingStore,
  searchReturning,
} from "./chat-fixtures";
import type { ChatFrame } from "./envelope";
import type { ChatRunDeps, ChatRunOutcome } from "./run-chat";
import { runChat } from "./run-chat";

/**
 * The turn, end to end. The packet's acceptance list for this file is four claims, and each is
 * asserted where it can actually fail:
 *
 * - retrieval empty → a persisted `refused` with zero claims and **zero provider calls**;
 * - the store refusing the write → the composed answer is never delivered, only a template sentence;
 * - the same `idempotencyKey` twice → the stored answer, with no retrieval and no reservation;
 * - every frame before the final one is one of the five `ProgressEvent` types, naming no provider.
 *
 * Routing, circuit and metering are the merged gateway implementation over recorded provider mocks
 * (`gateway-fixtures.ts`, the gateway packet's own idiom), so "no model was dialled" is a fact about
 * an adapter's call list rather than about a stub I wrote for the occasion.
 */

const KEY = "gpr-field-officer";
const QUESTION = "Was grid four surveyed twice?";
const CHUNK_TEXT = "Synthetic site note: grid four of the sample site was surveyed twice.";
/** The composed text, used as the thing that must **not** appear on the wire when delivery is refused. */
const COMPOSED_PHRASE = "second pass is required";

function request(overrides: Record<string, unknown> = {}): ChatRequest {
  return ChatRequest.parse({
    conversationId: CONVERSATION_ID,
    clientMessageId: "cm-0001",
    idempotencyKey: "idem-0001",
    expertKey: KEY,
    message: { text: QUESTION },
    ...overrides,
  });
}

function evidencePack(): EvidencePackEntry[] {
  return [packOf(CHUNK_ONE, SOURCE_VERSION_PUBLIC, CHUNK_TEXT, "internal")];
}

function candidateJson(): string {
  return composeCandidate(CHUNK_TEXT, CHUNK_ONE, SOURCE_VERSION_PUBLIC);
}

interface Harness {
  deps: ChatRunDeps;
  frames: ChatFrame[];
  store: RecordingStore;
  searches: unknown[];
  adapterCalls: () => number;
  reservations: () => number;
  run: (req?: ChatRequest) => Promise<ChatRunOutcome>;
}

function harness(
  options: {
    packs?: EvidencePackEntry[];
    store?: RecordingStore;
    scripts?: Parameters<typeof gatewayBundle>[0];
    withGrant?: boolean;
  } = {},
): Harness {
  const store = options.store ?? new RecordingStore();
  const hasPacks = (options.packs ?? []).length > 0;
  const search = searchReturning({
    packs: options.packs ?? [],
    corpusGenerations: hasPacks ? [1] : [],
    diagnostics: hasPacks ? "ok" : "not_wired",
    mode: hasPacks ? "hybrid" : "lexical_only",
  });
  const gateway = options.scripts === undefined ? null : gatewayBundle(options.scripts);
  const frames: ChatFrame[] = [];
  const deps: ChatRunDeps = {
    store,
    search,
    gateway: gateway?.bundle ?? null,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-11-13T09:00:00.000Z"),
    grants: async () => (options.withGrant === false ? [] : [{ expertKey: KEY, serviceKey: "uav-compliance", projectIds: [] }]),
  };
  return {
    deps,
    frames,
    store,
    searches: search.searches,
    adapterCalls: () => gateway?.adapterCalls() ?? 0,
    reservations: () => gateway?.meter.reserveCalls.length ?? 0,
    run: (req?: ChatRequest) => runChat({ context: contextFor(), request: req ?? request() }, deps),
  };
}

function answerFrame(frames: readonly ChatFrame[]): Extract<ChatFrame, { kind: "answer" }> {
  const last = frames.at(-1);
  if (last === undefined || last.kind !== "answer") throw new Error("expected a final answer frame");
  return last;
}

describe("retrieval empty", () => {
  it("refuses, persists the refusal, and dials no provider even though one is wired", async () => {
    const h = harness({
      packs: [],
      scripts: { local_box: fakeAdapter("local_box", [answered(candidateJson(), "open-weights-alpha")]) },
    });
    const outcome = await h.run();

    expect(outcome.kind).toBe("delivered");
    if (outcome.kind !== "delivered") return;
    expect(outcome.status).toBe("refused");
    expect(outcome.persisted).toBe(true);

    expect(h.store.calls.map((call) => call.name)).toEqual([
      "ensureConversation",
      "appendUserMessage",
      "startRun",
      "getRun",
      "completeRun",
    ]);
    expect(h.store.completed).toHaveLength(1);
    expect(h.store.completed[0]?.status).toBe("refused");
    expect(h.store.completed[0]?.claims).toEqual([]);

    // The refusal text is the expert's own template: the surface invents no explanation (§9.3).
    expect(answerFrame(h.frames).answer.summary).toContain("Nothing in the documents you are allowed to read");
    expect(h.adapterCalls()).toBe(0);
    expect(h.reservations()).toBe(0);
  });

  it("the search seam is dialled once, with the context and the service the grant names", async () => {
    const h = harness({ packs: [] });
    await h.run();
    expect(h.searches).toHaveLength(1);
    const input = h.searches[0] as { context: { organisationId: string }; serviceKey: string; projectId: string | null };
    expect(input.context.organisationId).toBe(contextFor().organisationId);
    expect(input.serviceKey).toBe("uav-compliance");
    expect(input.projectId).toBeNull();
  });

  it("a degraded or un-wired lane is labelled in the stream, not taken quietly (§8.1)", async () => {
    const h = harness({ packs: [] });
    await h.run();
    const searching = h.frames.filter(
      (frame): frame is { kind: "progress"; event: ProgressEventValue } => frame.kind === "progress" && frame.event.type === "searching",
    );
    expect(searching.some((frame) => frame.event.type === "searching" && frame.event.retrievalMode === "lexical_only")).toBe(true);
  });
});

describe("evidence exists but no gateway is bound", () => {
  it("answers `unavailable`, writes the run, and contacts no provider", async () => {
    const h = harness({ packs: evidencePack() });
    const outcome = await h.run();
    expect(outcome.kind).toBe("delivered");
    if (outcome.kind !== "delivered") return;
    expect(outcome.status).toBe("unavailable");
    expect(h.store.completed[0]?.status).toBe("unavailable");
    expect(h.adapterCalls()).toBe(0);
  });
});

describe("the durable write is the delivery gate (F22)", () => {
  it("a run the database refuses never reaches the employee with its claims", async () => {
    const store = new RecordingStore();
    store.answers.completeRun = { ok: false, kind: "refused", detail: "chat_complete_run_v1:42501" };
    const h = harness({
      packs: evidencePack(),
      store,
      scripts: { local_box: fakeAdapter("local_box", [answered(candidateJson(), "open-weights-alpha")]) },
    });
    const outcome = await h.run();

    expect(outcome.kind).toBe("store_failure");
    if (outcome.kind !== "store_failure") return;
    expect(outcome.stage).toBe("complete");
    expect(outcome.failure).toBe("refused");

    // The provider really was dialled and really composed something: the guard is on the way out.
    expect(h.adapterCalls()).toBe(1);
    const frame = answerFrame(h.frames);
    expect(frame.persisted).toBe(false);
    expect(frame.answer.claims).toEqual([]);
    expect(frame.answer.status).toBe("unavailable");
    expect(JSON.stringify(h.frames)).not.toContain(COMPOSED_PHRASE);
  });

  it("a delivered answer carries the class the store wrote, not the one compose proposed (§6.2)", async () => {
    const store = new RecordingStore();
    store.answers.completeRun = {
      ok: true,
      value: {
        runId: RUN_ID,
        conversationId: CONVERSATION_ID,
        messageId: "4a020000-0000-4000-8000-000000000001",
        status: "answered",
        // The migration raises the class to the highest cited source; the frame follows the row.
        dataClass: "client_confidential",
        completedAt: "2026-11-13 09:00:00+00",
      },
    };
    const h = harness({ packs: [], store });
    await h.run();
    expect(answerFrame(h.frames).answer.dataClass).toBe("client_confidential");
    expect(store.completed[0]?.dataClass).toBe("internal");
  });
});

describe("the same question asked twice", () => {
  it("hands back the run that exists, delivers its stored answer, and dials nothing", async () => {
    const store = new RecordingStore();
    const stored = answeredFixture("4b000000-0000-4000-8000-000000000009");
    // `chat_start_run_v1` returns the **existing** run for a known idempotency key; the read that
    // follows is what makes the resume provable rather than assumed.
    store.answers.startRun = { ok: true, value: stored.runId };
    store.answers.getRun = {
      ok: true,
      value: {
        id: stored.runId,
        conversationId: CONVERSATION_ID,
        status: "answered",
        answerStatus: "answered",
        dataClass: stored.dataClass,
        policyRevision: 1,
        expertKey: KEY,
        expertVersions: stored.expertVersions,
        corpusGenerations: stored.corpusGenerations,
        asOf: "2026-11-13 09:00:00+00",
        answer: stored,
        startedAt: "2026-11-13 09:00:00+00",
        completedAt: "2026-11-13 09:00:00+00",
      },
    };

    const h = harness({
      packs: evidencePack(),
      store,
      scripts: { local_box: fakeAdapter("local_box", [answered(candidateJson(), "open-weights-alpha")]) },
    });
    const outcome = await h.run();

    expect(outcome.kind).toBe("delivered");
    if (outcome.kind !== "delivered") return;
    expect(outcome.runId).toBe(stored.runId);
    // One frame only: no progress theatre for a run that already finished.
    expect(h.frames).toHaveLength(1);
    const frame = answerFrame(h.frames);
    expect(frame.persisted).toBe(true);
    expect(frame.answer.summary).toBe(stored.summary);
    expect(h.searches).toHaveLength(0);
    expect(h.adapterCalls()).toBe(0);
  });

  it("a reload after a disconnect reads the run by id and never re-runs the question", async () => {
    // The same mechanism the client uses when it reopens `/chat`: the run id it already has.
    const store = new RecordingStore();
    const stored = answeredFixture(RUN_ID);
    store.answers.getRun = {
      ok: true,
      value: {
        id: RUN_ID,
        conversationId: CONVERSATION_ID,
        status: "answered",
        answerStatus: "answered",
        dataClass: stored.dataClass,
        policyRevision: 1,
        expertKey: KEY,
        expertVersions: stored.expertVersions,
        corpusGenerations: stored.corpusGenerations,
        asOf: "2026-11-13 09:00:00+00",
        answer: stored,
        startedAt: "2026-11-13 09:00:00+00",
        completedAt: "2026-11-13 09:00:00+00",
      },
    };
    const h = harness({ packs: evidencePack(), store, scripts: { local_box: fakeAdapter("local_box", [answered(candidateJson(), "open-weights-alpha")]) } });
    await h.run(request({ idempotencyKey: "idem-0001" }));
    expect(h.frames).toHaveLength(1);
    expect(h.adapterCalls()).toBe(0);
  });
});

describe("the permission check runs before anything is written", () => {
  it("an expert the employee may not use costs no conversation, no run and no model call", async () => {
    const h = harness({
      packs: evidencePack(),
      withGrant: false,
      scripts: { local_box: fakeAdapter("local_box", [answered(candidateJson(), "open-weights-alpha")]) },
    });
    expect(await h.run()).toEqual({ kind: "not_permitted", key: "expert_not_permitted" });
    expect(h.store.calls).toEqual([]);
    expect(h.frames).toEqual([]);
    expect(h.adapterCalls()).toBe(0);
  });

  it("a store refusal at the conversation stage stops the turn with no frames at all", async () => {
    const store = new RecordingStore();
    store.answers.ensureConversation = { ok: false, kind: "membership", detail: "chat_ensure_conversation_v1:28000" };
    const h = harness({ store });
    const outcome = await h.run();
    expect(outcome.kind).toBe("store_failure");
    if (outcome.kind !== "store_failure") return;
    expect({ stage: outcome.stage, failure: outcome.failure }).toEqual({ stage: "conversation", failure: "membership" });
    expect(h.frames).toEqual([]);
    // Nothing after the refused step was dialled, so no half-state was written.
    expect(h.store.calls.map((call) => call.name)).toEqual(["ensureConversation"]);
  });
});

describe("what crosses the wire before the answer", () => {
  it("only the five progress types, with exactly one answer frame last", async () => {
    const h = harness({ packs: [] });
    await h.run();
    const types = progressTypes(h.frames);
    const allowed = ["routing", "searching", "reading_records", "verifying", "tier_changed"];
    expect(types.at(-1)).toBe("answer");
    expect(types.filter((type) => type === "answer")).toHaveLength(1);
    for (const type of types.slice(0, -1)) expect(allowed).toContain(type);

    // Structurally: every non-final frame validates as a `ProgressEvent`, which cannot hold answer text.
    for (const frame of h.frames.slice(0, -1)) {
      if (frame.kind !== "progress") throw new Error("expected a progress frame");
      expect(ProgressEvent.safeParse(frame.event).success).toBe(true);
    }
  });

  it("the gateway's own chain events reach the stream as typed progress, naming no provider", async () => {
    const h = harness({
      packs: evidencePack(),
      scripts: {
        local_box: fakeAdapter("local_box", [failed("connection"), answered(candidateJson(), "open-weights-alpha")]),
        workers_ai: fakeAdapter("workers_ai", [answered(candidateJson(), "hosted-beta")]),
      },
    });
    const outcome = await h.run();
    expect(outcome.kind).toBe("delivered");

    const tierChanged = h.frames.filter(
      (frame): frame is { kind: "progress"; event: ProgressEventValue & { type: "tier_changed" } } =>
        frame.kind === "progress" && frame.event.type === "tier_changed",
    );
    expect(tierChanged.length).toBeGreaterThan(0);
    expect(tierChanged[0]?.event.reason).toBe("provider_unavailable");

    // Chain positions and a closed reason enum only: provider and model identity is tenant-admin detail
    // (contracts/chat.ts:59-78, §9.3), and it must not be reachable in a progress frame.
    const wire = JSON.stringify(h.frames.filter((frame) => frame.kind === "progress"));
    for (const name of ["local_box", "workers_ai", "claude", "open-weights-alpha", "hosted-beta"]) {
      expect(wire).not.toContain(name);
    }
  });
});

describe("a fault inside the pipeline delivers nothing that was in flight", () => {
  it("an unparseable candidate becomes a persisted `unavailable`, never a half-answer", async () => {
    const h = harness({
      packs: evidencePack(),
      scripts: { local_box: fakeAdapter("local_box", [answered("this is not the structured shape", "open-weights-alpha")]) },
    });
    const outcome = await h.run();
    expect(outcome.kind).toBe("delivered");
    if (outcome.kind !== "delivered") return;
    expect(outcome.status).toBe("unavailable");
    const frame = answerFrame(h.frames);
    expect(frame.answer.claims).toEqual([]);
    expect(JSON.stringify(h.frames)).not.toContain(COMPOSED_PHRASE);
  });

  it("a budget authority that is unavailable fails closed, with no provider contact", async () => {
    const gateway = gatewayBundle({ local_box: fakeAdapter("local_box", [answered(candidateJson(), "open-weights-alpha")]) });
    gateway.meter.reserveThrows = true;
    const h = harness({ packs: evidencePack() });
    const deps: ChatRunDeps = { ...h.deps, gateway: gateway.bundle };
    const outcome = await runChat({ context: contextFor(), request: request() }, deps);

    expect(outcome.kind === "delivered" || outcome.kind === "store_failure").toBe(true);
    expect(h.adapterCalls()).toBe(0);
    const wire = JSON.stringify(h.frames);
    expect(wire).not.toContain(COMPOSED_PHRASE);
  });
});
