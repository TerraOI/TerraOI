import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { AdminEnv } from "@/platform/tenancy/admin-adapters";
import { pageRoutedHost } from "@/platform/tenancy/page-host";

const BARE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

export function adminEnv(): AdminEnv {
  try {
    return getCloudflareContext().env as AdminEnv;
  } catch {
    return {};
  }
}

export function developmentHostOption(): string | undefined {
  if (process.env.NODE_ENV !== "development") return undefined;
  return process.env.TERRAOI_DEV_HOST || "company1.terraoi.app";
}

export function adminPageRequest(headerList: Headers, path: string): Request {
  const routedHost = pageRoutedHost(headerList);
  const url = routedHost === null || !BARE_HOST.test(routedHost) ? "invalid:" : `https://${routedHost}${path}`;
  const cookie = headerList.get("cookie");
  return new Request(url, cookie === null ? undefined : { headers: { cookie } });
}
