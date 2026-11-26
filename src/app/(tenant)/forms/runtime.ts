import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { FormsEnv } from "@/platform/forms/adapters";
import { pageRoutedHost } from "@/platform/tenancy/page-host";

const BARE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

export function formsEnv(): FormsEnv {
  try {
    return getCloudflareContext().env as FormsEnv;
  } catch {
    return {};
  }
}

export function developmentHostOption(): string | undefined {
  if (process.env.NODE_ENV !== "development") return undefined;
  return process.env.TERRAOI_DEV_HOST || "company1.terraoi.app";
}

export function formsPageRequest(headerList: Headers, path: string): Request {
  const routedHost = pageRoutedHost(headerList);
  const url = routedHost === null || !BARE_HOST.test(routedHost) ? "invalid:" : `https://${routedHost}${path}`;
  const cookie = headerList.get("cookie");
  return new Request(url, cookie === null ? undefined : { headers: { cookie } });
}
