import { HealthResponse } from "@/contracts/health";

export const dynamic = "force-dynamic";

export function GET() {
  const body: HealthResponse = HealthResponse.parse({ status: "ok", service: "terraoi-web" });
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
