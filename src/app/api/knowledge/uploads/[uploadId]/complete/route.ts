import { uploadDeps, uploadUnavailableResponse } from "@/platform/knowledge/upload-adapters";
import { handleCompleteUpload } from "@/platform/knowledge/upload-session";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/uploads/:uploadId/complete` verifies the
// object the session issued and, in one transaction, writes the source version, the outbox event and
// the extract stage row (plan §7.2 steps 1–2, §9.2.1). Handler and tests:
// `src/platform/knowledge/upload-session.ts`; this file only wires it.

export const dynamic = "force-dynamic";

// The session id is part of the route (so the handler is addressable) and is read back from the
// routed URL inside `handleCompleteUpload`, never from the body.
export function POST(request: Request): Promise<Response> {
  const deps = uploadDeps();
  if (deps === null) return Promise.resolve(uploadUnavailableResponse());
  return handleCompleteUpload(request, deps);
}
