import { z } from "zod";

import { SAFE_FAILURE_MESSAGE } from "@/platform/tenancy/resolve-tenant-context";
import { withTenantRpc, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import type { ChatSessionRead } from "./http";

/**
 * F24 open a citation (T-203; backlog Q-10 option c): `GET /api/evidence/<chunkId>`.
 *
 * Every click re-authorizes (`cite_source_object_v1`: readable source, published version, this tenant,
 * this caller) and then streams the object from Storage **with the reader's own token**, under the
 * reader RLS policy (`20261125140000_citation_open.sql`). No URL is minted — ADR-0011 keeps the one
 * signer in `workers/object-signing.ts` — and neither a URL nor an object key reaches the browser or
 * any stored answer (plan §4.4). A forged, foreign, revoked or removed-membership id all answer the
 * same 404; the answer text stays where it is, only the evidence stops opening.
 *
 * Uploaded documents are untrusted (AGENTS.md §4.8), so the response is sandboxed: a closed set of
 * inline types, everything else an attachment, `nosniff`, a CSP sandbox and no caching.
 */

export interface CitationDeps {
  session: (request: Request) => Promise<ChatSessionRead>;
  postgrestBaseUrl: string | undefined;
  /** The project root (`SUPABASE_URL`); Storage is under `/storage/v1`. */
  supabaseUrl: string | undefined;
  anonKey: string | undefined;
  fetchImpl?: FetchImpl;
}

export const CITATION_NOT_AVAILABLE = "This source is not available to you.";
const UNAVAILABLE = "The service is temporarily unavailable. Please try again.";

const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"]);
/** The `source_versions.object_ref` CHECK, restated: never sign or fetch a key SQL did not issue. */
const OBJECT_REF = /^knowledge\/[a-z0-9][a-z0-9/_.-]*$/;
const Row = z.object({ object_ref: z.string(), data_class: z.string() });

function json(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function objectRefOk(ref: string): boolean {
  return ref.length >= 12 && ref.length <= 512 && OBJECT_REF.test(ref) && !ref.includes("//") && !ref.includes("../");
}

export async function handleOpenCitation(request: Request, chunkId: string, deps: CitationDeps): Promise<Response> {
  if (request.method !== "GET") return json(405, "Method not allowed.");
  const session = await deps.session(request);
  if (!session.ok) {
    const status = session.reason === "no_session" ? 401 : session.reason === "backend_failure" ? 503 : 404;
    return json(status, SAFE_FAILURE_MESSAGE[session.reason]);
  }
  if (session.accessToken === null) return json(401, SAFE_FAILURE_MESSAGE.no_session);
  if (!z.uuid().safeParse(chunkId).success) return json(404, CITATION_NOT_AVAILABLE);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const authorized = await withTenantRpc(
    session.context,
    "cite_source_object_v1",
    { p_chunk_id: chunkId },
    session.accessToken,
    { postgrestBaseUrl: deps.postgrestBaseUrl, fetchImpl },
  );
  if (!authorized.ok) {
    if (authorized.kind === "tenancy") return json(404, CITATION_NOT_AVAILABLE);
    return json(503, UNAVAILABLE);
  }
  const rows = z.array(Row).safeParse(authorized.data);
  if (!rows.success) return json(503, UNAVAILABLE);
  const row = rows.data[0];
  if (row === undefined) return json(404, CITATION_NOT_AVAILABLE);
  if (!objectRefOk(row.object_ref)) return json(503, UNAVAILABLE);

  const root = typeof deps.supabaseUrl === "string" ? deps.supabaseUrl.trim().replace(/\/+$/, "") : "";
  if (root.length === 0 || typeof deps.anonKey !== "string" || deps.anonKey.length === 0) return json(503, UNAVAILABLE);
  const path = row.object_ref.split("/").map(encodeURIComponent).join("/");

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${root}/storage/v1/object/authenticated/${path}`, {
      method: "GET",
      headers: { apikey: deps.anonKey, authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return json(503, UNAVAILABLE);
  }
  // Storage answers a policy refusal as "not found": the same 404 as a revoked or forged id.
  if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403 || upstream.status === 404) {
    return json(404, CITATION_NOT_AVAILABLE);
  }
  if (!upstream.ok || upstream.body === null) return json(503, UNAVAILABLE);

  const declared = (upstream.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const inline = INLINE_TYPES.has(declared);
  const name = row.object_ref.slice(row.object_ref.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9._-]/g, "_");
  const headers = new Headers({
    "content-type": inline ? declared : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
  });
  const length = upstream.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length)) headers.set("content-length", length);
  return new Response(upstream.body, { status: 200, headers });
}
