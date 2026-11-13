import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { TenantFrame } from "@/components/tenant-shell/tenant-frame";
import { loadTenantBrand } from "@/platform/branding/load-tenant-brand";
import { toSignInBrand } from "@/platform/branding/sign-in-brand";
import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { issueCsrfToken } from "@/platform/identity/csrf";
import { hasUsableSecret } from "@/platform/identity/signed-token";
import { pageRoutedHost } from "@/platform/tenancy/page-host";

export const dynamic = "force-dynamic";

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

/** Proxy-stamped host, or the dev override under `next dev` only. */
function shellHost(headerList: Headers): string | null {
  if (process.env.NODE_ENV === "development") {
    return process.env.TERRAOI_DEV_HOST || "company1.terraoi.app";
  }
  return pageRoutedHost(headerList);
}

async function signOutToken(host: string | null): Promise<string | undefined> {
  if (host === null || host.length === 0) return undefined;
  const secret = buildIdentityPorts(identityEnv()).signingSecret();
  if (!hasUsableSecret(secret)) return undefined;
  try {
    return await issueCsrfToken({ host, secret, now: Math.floor(Date.now() / 1000) });
  } catch {
    return undefined;
  }
}

export default async function TenantLayout({ children }: { children: ReactNode }) {
  const headerList = await headers();
  const host = shellHost(headerList);
  const resolved = await loadTenantBrand({ host: host ?? "" });
  const csrfToken = await signOutToken(host);
  return (
    <TenantFrame brand={toSignInBrand(resolved.brand)} csrfToken={csrfToken}>
      {children}
    </TenantFrame>
  );
}
