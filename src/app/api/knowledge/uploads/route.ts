import { uploadDepsForRequest, uploadUnavailableResponse } from "@/platform/knowledge/upload-adapters";
import { handleCreateUpload } from "@/platform/knowledge/upload-session";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/uploads` issues a bounded upload
// session with a server-owned object key (plan §9.2.1). The handler and every test live in
// `src/platform/knowledge/upload-session.ts`; this file only wires it.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const deps = await uploadDepsForRequest(request);
  if (deps === null) return uploadUnavailableResponse();
  return handleCreateUpload(request, deps);
}
