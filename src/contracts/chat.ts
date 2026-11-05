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

/**
 * Why the chain moved to another position (§12.4 chain walking). A closed set, because free text
 * here is how a provider name, a model id or an internal error would leak into an employee-visible
 * progress stream (issue #16 N5, §9.3, §8.2). The UI renders one of these; nothing composes it.
 */
export const TierChangeReason = z.enum([
  "provider_unavailable", // connection failure, 5xx, health check, open circuit
  "quota_exhausted", // window allowance spent (F38)
  "clearance", // not cleared for the payload's data class (§12.4)
  "capability_tier", // below the task's minimum tier (§12.1)
  "composing_model", // chain-walking rule (e): the verifier is not the composer
  "output_rejected", // overflow or invalid structured output
  "deadline", // stage deadline reached (F34)
]);
export type TierChangeReason = z.infer<typeof TierChangeReason>;

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
    // Chain positions, never provider names or model ids: provider identity is tenant-admin-only
    // detail (§9.3). `reason` is a closed enum for the same reason.
    fromTier: z.number().int().positive(),
    toTier: z.number().int().positive(),
    reason: TierChangeReason,
  }),
]);
export type ProgressEvent = z.infer<typeof ProgressEvent>;
