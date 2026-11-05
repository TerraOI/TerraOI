import { z } from "zod";

import { ExpertKey, OpaqueId, ToolKey } from "./keys";

/**
 * Chat request and progress events (plan §9.2, §9.3).
 *
 * The request is the **logical** contract the route normalizes the pinned SDK envelope into.
 * It carries no organization, user or role field: the server takes those from the verified host
 * and session only (AGENTS.md §4.1). Progress events carry no factual answer text — a candidate
 * is delivered only after verification, re-authorization and audit (§9.3, TOI-ADR-07).
 */
export const ChatRequest = z.strictObject({
  conversationId: OpaqueId,
  clientMessageId: OpaqueId,
  // Same key across a retry or resume; a deliberate new question gets a new one (§9.2).
  idempotencyKey: OpaqueId,
  expertKey: ExpertKey,
  projectId: z.uuid().optional(),
  message: z.strictObject({
    text: z.string().trim().min(1).max(32_000),
  }),
  attachmentIds: z.array(OpaqueId).max(10).default([]),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

const ProgressBase = {
  runId: z.uuid(),
  conversationId: OpaqueId,
  emittedAt: z.iso.datetime(),
};

export const ProgressEvent = z.discriminatedUnion("type", [
  // F29: a suggestion only; the employee's explicit pick always wins (§10.1).
  z.strictObject({
    ...ProgressBase,
    type: z.literal("routing"),
    expertKey: ExpertKey,
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    ...ProgressBase,
    type: z.literal("searching"),
    // `lexical_only` labels the degraded lane so reduced search quality is visible (§8.1).
    retrievalMode: z.enum(["hybrid", "lexical_only"]).optional(),
  }),
  z.strictObject({
    ...ProgressBase,
    type: z.literal("reading_records"),
    // Tool keys, never record ids: a progress event must not disclose hidden records (§8.2).
    toolKeys: z.array(ToolKey).max(6),
  }),
  z.strictObject({ ...ProgressBase, type: z.literal("verifying") }),
  z.strictObject({
    ...ProgressBase,
    type: z.literal("tier_changed"),
    // Chain positions, not provider names: provider identity is tenant-admin-only detail (§9.3).
    fromTier: z.number().int().positive(),
    toTier: z.number().int().positive(),
    note: z.string().min(1).max(300),
  }),
]);
export type ProgressEvent = z.infer<typeof ProgressEvent>;
