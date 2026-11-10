import { readBrandAsset } from "@/platform/branding/brand-source";
import { serveBrandAsset } from "@/platform/branding/serve-brand-asset";

/**
 * `GET /brand-assets/{configVersion}/{name}` (FAQ-0008, T-103). Thin by rule: `src/app/` holds
 * routes, and every decision — host, version segment, name segment, type agreement, refusal shape —
 * lives in `src/platform/branding/serve-brand-asset.ts` where it is testable without a framework.
 *
 * Two path parameters, both untrusted strings, both validated by the handler rather than here: a
 * route file that "cleans up" a path segment is where a `..` gets a second chance to travel.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ configVersion: string; name: string }> },
): Promise<Response> {
  const params = await context.params;
  return serveBrandAsset(
    request,
    { configVersion: params.configVersion, name: params.name },
    {
      readAsset: (input) => readBrandAsset(
        { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY },
        input,
      ),
    },
  );
}
