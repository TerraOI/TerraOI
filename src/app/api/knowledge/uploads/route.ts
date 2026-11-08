import { uploadDeps, uploadUnavailableResponse } from "@/platform/knowledge/upload-adapters";
import { handleCreateUpload } from "@/platform/knowledge/upload-session";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/uploads` issues a bounded upload
// session with a server-owned object key (plan §9.2.1). The handler and every test live in
// `src/platform/knowledge/upload-session.ts`; this file only wires it.

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  const deps = uploadDeps();
  if (deps === null) return Promise.resolve(uploadUnavailableResponse());
  return handleCreateUpload(request, deps);
}
