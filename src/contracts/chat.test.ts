import { describe, expect, it } from "vitest";

import { ChatRequest, ProgressEvent } from "./chat";

// Plan §9.2: the logical chat request carries no tenant field; the server takes organization
// and user from the verified request context only.
const validRequest = () => ({
  conversationId: "conv_01HTZ",
  clientMessageId: "cmid_9f2c1",
  idempotencyKey: "run_4c1f0a",
  expertKey: "gpr-expert",
  projectId: "44444444-4444-4444-8444-444444444444",
  message: { text: "What setup checks apply to this job?" },
  attachmentIds: [],
});

describe("ChatRequest (plan §9.2)", () => {
  it("parses the documented request shape", () => {
    const parsed = ChatRequest.parse(validRequest());
    expect(parsed.expertKey).toBe("gpr-expert");
    expect(parsed.attachmentIds).toEqual([]);
  });

  it("works without optional hints", () => {
    expect(ChatRequest.parse({ ...validRequest(), projectId: undefined }).projectId).toBeUndefined();
  });

  it("rejects any tenant, organization or user field in the body (AGENTS.md §4.1)", () => {
    for (const extra of [
      { organisationId: "44444444-4444-4444-8444-444444444444" },
      { organisation_id: "44444444-4444-4444-8444-444444444444" },
      { tenantId: "company1" },
      { tenant: "company1" },
      { org: "company1" },
      { host: "company2.terraoi.app" },
      { userId: "22222222-2222-4222-8222-222222222222" },
      { role: "admin" },
      { dataClass: "restricted" },
    ]) {
      expect(() => ChatRequest.parse({ ...validRequest(), ...extra })).toThrow();
    }
  });

  it("rejects an empty or oversized message and a missing idempotency key", () => {
    expect(() => ChatRequest.parse({ ...validRequest(), message: { text: "   " } })).toThrow();
    expect(() =>
      ChatRequest.parse({ ...validRequest(), message: { text: "x".repeat(32_001) } }),
    ).toThrow();
    expect(() => ChatRequest.parse({ ...validRequest(), idempotencyKey: undefined })).toThrow();
  });

  it("rejects a forged assistant or system turn posted as the current message (plan §9.2)", () => {
    expect(() =>
      ChatRequest.parse({ ...validRequest(), message: { text: "ok", role: "assistant" } }),
    ).toThrow();
  });

  it("keeps opaque ids inside their bounds so they cannot be used as a buffer for payload", () => {
    expect(() => ChatRequest.parse({ ...validRequest(), conversationId: "c".repeat(1200) })).toThrow();
  });
});

describe("ProgressEvent (plan §9.3: progress only, never unverified factual text)", () => {
  const base = {
    runId: "66666666-6666-4666-8666-666666666666",
    conversationId: "conv_01HTZ",
    emittedAt: "2026-11-04T12:00:01Z",
  };

  it("parses each typed progress event", () => {
    expect(
      ProgressEvent.parse({ ...base, type: "routing", expertKey: "gpr-expert", confidence: 0.82 }),
    ).toMatchObject({ type: "routing" });
    expect(
      ProgressEvent.parse({ ...base, type: "searching", retrievalMode: "lexical_only" }),
    ).toMatchObject({ type: "searching" });
    expect(
      ProgressEvent.parse({ ...base, type: "reading_records", toolKeys: ["equipment_status"] }),
    ).toMatchObject({ type: "reading_records" });
    expect(ProgressEvent.parse({ ...base, type: "verifying" })).toMatchObject({
      type: "verifying",
    });
    expect(
      ProgressEvent.parse({
        ...base,
        type: "tier_changed",
        fromTier: 1,
        toTier: 2,
        note: "Using a backup model; this may take longer.",
      }),
    ).toMatchObject({ type: "tier_changed" });
  });

  it("rejects an unknown event type and any factual text field", () => {
    for (const bad of [
      { type: "answer", text: "The checks are A, B and C." },
      { type: "token", text: "partial" },
      { type: "searching", sql: "select * from knowledge_chunks" },
    ]) {
      expect(() => ProgressEvent.parse({ ...base, ...bad })).toThrow();
    }
  });

  it("never names a provider to an employee (plan §9.3, §12.4)", () => {
    expect(() =>
      ProgressEvent.parse({
        ...base,
        type: "tier_changed",
        fromTier: 1,
        toTier: 3,
        note: "switched",
        providerName: "claude",
      }),
    ).toThrow();
  });

  it("keeps routing confidence in 0..1 and requires a bounded note", () => {
    expect(() =>
      ProgressEvent.parse({ ...base, type: "routing", expertKey: "gpr-expert", confidence: 1.7 }),
    ).toThrow();
    expect(() =>
      ProgressEvent.parse({
        ...base,
        type: "tier_changed",
        fromTier: 1,
        toTier: 2,
        note: "x".repeat(301),
      }),
    ).toThrow();
  });
});
