import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { BrandFallbackBanner } from "@/components/admin/brand-fallback-banner";
import { brandSourceReader, type BrandSourceEnv } from "@/platform/branding/brand-source";
import { loadTenantBrand } from "@/platform/branding/load-tenant-brand";
import type { IdentityEnv } from "@/platform/identity/adapters";
import { pageRoutedHost } from "@/platform/tenancy/page-host";

import { developmentHostOption } from "./runtime";

export const dynamic = "force-dynamic";

const BARE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

function brandEnv(): Partial<BrandSourceEnv> {
  try {
    const env = getCloudflareContext().env as Partial<IdentityEnv>;
    return { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY };
  } catch {
    return {};
  }
}

function adminHost(headerList: Headers): string {
  const dev = developmentHostOption();
  if (dev !== undefined) return dev;
  const routed = pageRoutedHost(headerList);
  if (routed === null || !BARE_HOST.test(routed)) return "";
  return routed;
}

/**
 * Admin chrome (T-202): when `loadTenantBrand` fell back to platform branding, show the fixed
 * admin note on every `/admin` page (#62). Non-admin surfaces stay quiet.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const headerList = await headers();
  const resolved = await loadTenantBrand({
    host: adminHost(headerList),
    readSource: brandSourceReader(brandEnv()),
  });

  return (
    <>
      {resolved.fallback !== null ? <BrandFallbackBanner note={resolved.fallback.note} /> : null}
      {children}
    </>
  );
}
