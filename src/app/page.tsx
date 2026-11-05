import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { UnknownAddressPage } from "@/components/auth/unknown-address-page";
import { LandingPage } from "@/components/site/landing-page";
import { platformHostFromHeaders } from "@/platform/site/platform-host";

// Cloudflare's published always-pass test key, used only under next dev when no key is set.
const DEV_TEST_SITE_KEY = "1x00000000000000000000AA";

/** The public Turnstile site key (a wrangler var, not a secret). Empty means the widget fails closed. */
function turnstileSiteKey(): string {
  let key = "";
  try {
    key = (getCloudflareContext().env as { TURNSTILE_SITE_KEY?: string }).TURNSTILE_SITE_KEY ?? "";
  } catch {
    // No Cloudflare context under plain next dev or in tests.
  }
  key ||= process.env.TURNSTILE_SITE_KEY ?? "";
  return key || (process.env.NODE_ENV === "development" ? DEV_TEST_SITE_KEY : "");
}

// T-130 Task 11: terraoi.app shows the landing page. Every other host (tenants, admin, unknown,
// preview aliases) gets the generic unknown-address page until its own surface exists (plan §4.1
// step 3: never a fallback tenant, never TerraOI's site on a tenant address).
export default async function Home() {
  if (!platformHostFromHeaders(await headers())) return <UnknownAddressPage />;
  return <LandingPage turnstileSiteKey={turnstileSiteKey()} />;
}
