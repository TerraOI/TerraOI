import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildIdentityPorts, type IdentityEnv } from "@/platform/identity/adapters";
import { LOGIN_PATH } from "@/platform/identity/http-response";
import { buildSetPasswordView, SET_PASSWORD_PATH } from "@/platform/identity/set-password";
import { ROUTED_HOST_HEADER } from "@/platform/tenancy/page-host";

export const dynamic = "force-dynamic";

/**
 * Set-password surface after a recovery completion (plan §4.2; packet Owns
 * `src/app/(tenant)/account/`). Logic lives in `src/platform/identity/set-password.ts`; this page
 * only renders the form or follows the view's redirect. Brand chrome is T-103/T-131 — a plain form
 * is enough for the credential change.
 */

function identityEnv(): Partial<IdentityEnv> {
  try {
    return getCloudflareContext().env as Partial<IdentityEnv>;
  } catch {
    return {};
  }
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string }>;
}) {
  const headerList = await headers();
  const routedHost = headerList.get(ROUTED_HOST_HEADER);
  const cookie = headerList.get("cookie") ?? "";
  const params = await searchParams;

  // Rebuild a Request the platform module can read: host from the proxy stamp (ADR-0006), cookie for
  // the recovery session. Route handlers keep using request.url; pages never invent a tenant.
  const url = routedHost !== null ? `https://${routedHost}${SET_PASSWORD_PATH}` : "invalid:";
  const view = await buildSetPasswordView({
    request: new Request(url, { headers: { cookie } }),
    ports: buildIdentityPorts(identityEnv()),
    outcome: params.outcome,
  });

  if (view.kind === "redirect") {
    const location = view.response.headers.get("location");
    if (location !== null) redirect(location);
    redirect(LOGIN_PATH);
  }

  const message =
    view.outcome === "rejected"
      ? "Choose a password of at least 10 characters and confirm it matches."
      : view.outcome === "unavailable"
        ? "The service is temporarily unavailable. Try again later."
        : null;

  return (
    <main>
      <h1>Choose a new password</h1>
      <p>Your other sessions on this workspace were signed out. Set a new password to continue.</p>
      {message !== null ? <p role="status">{message}</p> : null}
      <form method="post" action="/auth/set-password">
        <input type="hidden" name="csrf_token" value={view.csrfToken} />
        <label>
          New password
          <input name="password" type="password" autoComplete="new-password" minLength={10} required />
        </label>
        <label>
          Confirm password
          <input name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        </label>
        <button type="submit">Save password</button>
      </form>
    </main>
  );
}
