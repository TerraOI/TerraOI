import { z } from "zod";

import { DataClass } from "@/contracts/data-class";
import { SAFE_FAILURE_MESSAGE } from "@/platform/tenancy/resolve-tenant-context";
import { withTenantRpc, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import type { ChatSessionRead } from "./http";

/**
 * T-302 audience picker: `GET /chat/collections` lists the collections the caller may read
 * (`list_submission_collections_v1`), with each one's data class, so "Save as knowledge" only offers
 * an audience the submission RPC could accept. The submit itself re-checks everything.
 */

const Row = z.object({
  id: z.uuid(),
  key: z.string().min(1),
  name: z.string().min(1),
  data_class: DataClass,
  project_id: z.uuid().nullable(),
});

export interface SubmissionCollection {
  id: string;
  name: string;
  dataClass: DataClass;
  projectScoped: boolean;
}

export interface CollectionsDeps {
  session: (request: Request) => Promise<ChatSessionRead>;
  postgrestBaseUrl: string | undefined;
  fetchImpl?: FetchImpl;
}

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function handleListSubmissionCollections(request: Request, deps: CollectionsDeps): Promise<Response> {
  if (request.method !== "GET") return reply(405, { ok: false, message: "Method not allowed." });
  const session = await deps.session(request);
  if (!session.ok) {
    const status = session.reason === "no_session" ? 401 : session.reason === "backend_failure" ? 503 : 403;
    return reply(status, { ok: false, message: SAFE_FAILURE_MESSAGE[session.reason] });
  }
  const outcome = await withTenantRpc(session.context, "list_submission_collections_v1", {}, session.accessToken, {
    postgrestBaseUrl: deps.postgrestBaseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  const parsed = outcome.ok ? z.array(Row).safeParse(outcome.data) : null;
  if (parsed === null || !parsed.success) {
    return reply(outcome.ok || outcome.kind !== "tenancy" ? 503 : 403, {
      ok: false,
      message: "The service is temporarily unavailable. Please try again.",
    });
  }
  const collections: SubmissionCollection[] = parsed.data.map((row) => ({
    id: row.id,
    name: row.name,
    dataClass: row.data_class,
    projectScoped: row.project_id !== null,
  }));
  return reply(200, { ok: true, collections });
}
