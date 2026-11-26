import { uploadDepsForRequest, uploadUnavailableResponse } from "@/platform/knowledge/upload-adapters";
import { handleCompleteUpload } from "@/platform/knowledge/upload-session";

// Lane 2 HTTP surface (FAQ-0005, #11): `POST /api/knowledge/uploads/:id/complete` verifies the
// stored object and captures a source version. Handler + tests: `upload-session.ts`.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const deps = await uploadDepsForRequest(request);
  if (deps === null) return uploadUnavailableResponse();
  return handleCompleteUpload(request, deps);
}
