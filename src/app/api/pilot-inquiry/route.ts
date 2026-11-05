import { getCloudflareContext } from "@opennextjs/cloudflare";
import { buildInquiryDeps, type InquiryEnv } from "@/platform/site/adapters";
import { handlePilotInquiry } from "@/platform/site/handle-pilot-inquiry";

export const dynamic = "force-dynamic";

/** Bindings are absent under plain `next dev` and on staging before the human steps (ADR-0002). */
function inquiryEnv(): Partial<InquiryEnv> {
  try {
    return getCloudflareContext().env as Partial<InquiryEnv>;
  } catch {
    return {};
  }
}

export function POST(req: Request) {
  return handlePilotInquiry(req, buildInquiryDeps(inquiryEnv()));
}
