import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";

import { CheckEmailPage } from "@/components/auth/check-email-page";
import { NoAccessPage } from "@/components/auth/no-access-page";
import { SignInPage } from "@/components/auth/sign-in-page";
import { UnknownAddressPage } from "@/components/auth/unknown-address-page";
import type { SignInStatus } from "@/components/auth/types";
import { loadTenantBrand } from "@/platform/branding/load-tenant-brand";
import { toSignInBrand } from "@/platform/branding/sign-in-brand";
import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { buildLoginView, type LoginView } from "@/platform/identity/login-view";
import type { SigninOutcome } from "@/platform/identity/outcomes";
import { pageRoutedHost } from "@/platform/tenancy/page-host";

export const dynamic = "force-dynamic";

const MAGIC_LINK_PATH = "/auth/magic-link";

/** Bindings are absent under plain `next dev` and on staging before the T-004 human steps. */
function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

function developmentHostOption(): string | undefined {
  if (process.env.NODE_ENV !== "development") return undefined;
  return process.env.TERRAOI_DEV_HOST || "company1.terraoi.app";
}

/**
 * Rebuild a Request the login gate can trust: host from the proxy-stamped header (ADR-0006),
 * cookie from the page's own headers. Scheme and path are inert for tenancy; `requestHost` reads
 * only the host.
 */
export function loginPageRequest(headerList: Headers, pathWithQuery = "/login"): Request {
  const routedHost = pageRoutedHost(headerList);
  const url = routedHost === null ? "invalid:" : `https://${routedHost}${pathWithQuery}`;
  const cookie = headerList.get("cookie");
  return new Request(url, cookie === null ? undefined : { headers: { cookie } });
}

function statusFromOutcome(outcome: SigninOutcome | null, csrfToken: string | null): SignInStatus {
  if (csrfToken === null) return "unavailable";
  if (outcome === null || outcome === "not_a_member" || outcome === "link_sent") return "idle";
  return outcome;
}

async function brandForHost(host: string | null) {
  const resolved = await loadTenantBrand({ host: host ?? "" });
  return toSignInBrand(resolved.brand);
}

/** Host used for branding: the proxy stamp, or the development override under `next dev`. */
export function loginBrandHost(headerList: Headers): string | null {
  return developmentHostOption() ?? pageRoutedHost(headerList);
}

export async function renderLoginSurface(input: {
  view: LoginView;
  host: string | null;
}): Promise<ReactElement> {
  const { view, host } = input;

  switch (view.kind) {
    case "unknown_address":
    case "tenant_not_live":
      return <UnknownAddressPage />;
    case "no_access": {
      const brand = await brandForHost(host);
      return <NoAccessPage brand={brand} />;
    }
    case "signed_in":
      return redirect("/");
    case "sign_in": {
      const brand = await brandForHost(host);
      if (view.outcome === "not_a_member") return <NoAccessPage brand={brand} />;
      if (view.outcome === "link_sent") return <CheckEmailPage brand={brand} />;
      const status = statusFromOutcome(view.outcome, view.csrfToken);
      const canPost = view.csrfToken !== null;
      return (
        <SignInPage
          brand={brand}
          enabledMethods={["magic_link"]}
          status={status}
          magicLinkAction={canPost ? MAGIC_LINK_PATH : undefined}
          csrfToken={canPost ? view.csrfToken ?? undefined : undefined}
        />
      );
    }
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string | string[] }>;
}) {
  const headerList = await headers();
  const params = await searchParams;
  const rawOutcome = params.outcome;
  const outcome = Array.isArray(rawOutcome) ? rawOutcome[0] : rawOutcome;

  const request = loginPageRequest(
    headerList,
    outcome === undefined ? "/login" : `/login?outcome=${encodeURIComponent(outcome)}`,
  );
  const hostOptions = developmentHostOption();
  const view = await buildLoginView({
    request,
    outcome,
    ports: buildIdentityPorts(identityEnv()),
    hostOptions: hostOptions === undefined ? undefined : { developmentHost: hostOptions },
  });

  return renderLoginSurface({ view, host: loginBrandHost(headerList) });
}
