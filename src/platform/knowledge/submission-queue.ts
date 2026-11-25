import { z } from "zod";

import { DataClass } from "@/contracts/data-class";
import { KnowledgeSubmissionKind, KnowledgeSubmissionState } from "@/contracts/knowledge-submission";
import type { TenantContext } from "@/contracts/tenant-context";
import { withTenantRpc, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

/**
 * T-302 reviewer queue read (`list_knowledge_submissions_v1`). Reviewers (knowledge.write|admin) see
 * submissions in collections they can read; everyone else sees their own. The author flag comes
 * from SQL (`author_user_id = auth.uid()`), so the page never decides independence itself — and the
 * decision RPC refuses an author anyway (pgTAP 087).
 */

const Row = z.object({
  id: z.uuid(),
  collection_id: z.uuid(),
  collection_name: z.string().min(1),
  kind: KnowledgeSubmissionKind,
  proposed_text: z.string().min(1),
  data_class: DataClass,
  state: KnowledgeSubmissionState,
  cited_source_version_ids: z.array(z.uuid()),
  author_is_caller: z.boolean(),
  created_at: z.string().min(1),
  reviewed_at: z.string().nullable(),
});

export interface QueuedSubmission {
  id: string;
  collectionName: string;
  kind: z.infer<typeof KnowledgeSubmissionKind>;
  proposedText: string;
  dataClass: z.infer<typeof DataClass>;
  state: z.infer<typeof KnowledgeSubmissionState>;
  citedCount: number;
  authorIsCaller: boolean;
  createdAt: string;
}

export type SubmissionQueueOutcome =
  | { ok: true; submissions: QueuedSubmission[] }
  | { ok: false; message: string };

export const SUBMISSION_QUEUE_UNAVAILABLE = "The service is temporarily unavailable. Please try again.";
export const SUBMISSION_QUEUE_NO_ACCESS = "You do not have access to this workspace.";

export async function listSubmissionQueue(
  context: TenantContext,
  accessToken: string | null,
  state: z.infer<typeof KnowledgeSubmissionState> | null,
  deps: { postgrestBaseUrl: string | undefined; fetchImpl?: FetchImpl },
): Promise<SubmissionQueueOutcome> {
  const outcome = await withTenantRpc(context, "list_knowledge_submissions_v1", { p_state: state }, accessToken, {
    postgrestBaseUrl: deps.postgrestBaseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  if (!outcome.ok) {
    return { ok: false, message: outcome.kind === "tenancy" ? SUBMISSION_QUEUE_NO_ACCESS : SUBMISSION_QUEUE_UNAVAILABLE };
  }
  const parsed = z.array(Row).safeParse(outcome.data);
  if (!parsed.success) return { ok: false, message: SUBMISSION_QUEUE_UNAVAILABLE };
  return {
    ok: true,
    submissions: parsed.data.map((row) => ({
      id: row.id,
      collectionName: row.collection_name,
      kind: row.kind,
      proposedText: row.proposed_text,
      dataClass: row.data_class,
      state: row.state,
      citedCount: row.cited_source_version_ids.length,
      authorIsCaller: row.author_is_caller,
      createdAt: row.created_at,
    })),
  };
}
