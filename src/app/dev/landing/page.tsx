import { notFound } from "next/navigation";
import { LandingPage } from "@/components/site/landing-page";

// Preview of the terraoi.app landing page until host gating (T-130 Task 11, after T-101) puts it
// on "/". Development only: every other environment gets a 404.
export default function DevLandingPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  // Cloudflare's published always-pass test site key, so the widget renders under next dev.
  return <LandingPage turnstileSiteKey={process.env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA"} />;
}
