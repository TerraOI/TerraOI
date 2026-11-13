import { requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import {
  resolveTenantContext,
  type HostRecord,
  type MembershipRecord,
  type TenancyStore,
} from "@/platform/tenancy/resolve-tenant-context";

import { issueCsrfToken } from "./csrf";
import { safeOutcome, type SigninOutcome } from "./outcomes";
import { readSession, readSessionTokens } from "./session";
import type { SessionStore, TokenCipher } from "./session-store";
import { hasUsableSecret } from "./signed-token";

/**
 * Which surface a tenant origin shows for `/login` (plan §4.1 steps 1–4, §4.2, F02).
 *
 * The order is the plan's, through T-101's resolver, which this module does not duplicate: host
 * format → domain registry → reserved/unknown/suspended get a generic failure → only then session
 * and membership. A session contributes a **user id** and nothing else; the organization comes from
 * the routed URL, and access comes from the current `organisation_memberships` row. So a stranger,
 * a suspended member and an invited-but-not-yet-active member all land on the same no-access
 * surface, and none of the denied surfaces carries a tenant name, host or id.
 */

export interface LoginViewPorts {
  now(): number;
  /** The `IDENTITY_SESSION_KEY` binding; null means sign-in is unavailable on this deployment. */
  signingSecret(): string | null;
  /**
   * The server-side session store (#37 option b). Null on a deployment where the row is not
   * reachable yet, which is the honest state until #75 settles the carrier: nobody is signed in,
   * rather than a cookie being trusted on its own.
   */
  sessionStore(): SessionStore | null;
  /** Cipher for reading the sealed token pair so membership RLS can use the user's JWT. */
  tokenCipher(): TokenCipher | null;
  findHost(host: string): Promise<HostRecord | null>;
  findMembership(organisationId: string, accessToken: string): Promise<MembershipRecord | null>;
  policyRevision(organisationId: string, accessToken: string): Promise<number>;
}

export type LoginView =
  | { kind: "unknown_address" }
  | { kind: "tenant_not_live" }
  | { kind: "sign_in"; csrfToken: string | null; outcome: SigninOutcome | null }
  | { kind: "no_access"; reason: "not_a_member" | "membership_not_active" }
  | { kind: "signed_in" };

export interface BuildLoginViewInput {
  /** The routed request. Only its URL is read for tenancy; the cookie is read for the session. */
  request: Request;
  /** Development-only host for `next dev`, per the tenancy adapter's rule. */
  hostOptions?: HostAdapterOptions;
  /** Raw `?outcome=` value; only a whitelisted member is ever rendered. */
  outcome?: unknown;
  ports: LoginViewPorts;
}

export async function buildLoginView(input: BuildLoginViewInput): Promise<LoginView> {
  const { ports } = input;

  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const configured = ports.signingSecret();
  const secret = hasUsableSecret(configured) ? configured : null;

  // A session is only a user id, and only when the row behind it is live on this exact host
  // (#37: the cookie is an opaque id, so without a store to look it up there is no session to have).
  // `host === null`, `secret === null` or `store === null` means "not signed in", never
  // "signed in with an unknown tenant".
  let userId: string | null = null;
  let accessToken: string | null = null;
  const sessionStore = ports.sessionStore();
  const tokenCipher = ports.tokenCipher();
  if (host !== null && sessionStore !== null) {
    const cookieHeader = input.request.headers.get("cookie");
    const session = await readSession({
      cookieHeader,
      host,
      now: ports.now(),
      store: sessionStore,
    });
    if (session.ok) {
      userId = session.userId;
      if (tokenCipher !== null) {
        const tokens = await readSessionTokens({
          cookieHeader,
          host,
          now: ports.now(),
          store: sessionStore,
          cipher: tokenCipher,
        });
        if (tokens.ok) accessToken = tokens.tokens.accessToken;
      }
    }
  }

  const store: TenancyStore = {
    findHost: (h) => ports.findHost(h),
    // `TenancyStore` still names a user, and this implementation deliberately takes less: the read
    // has no user argument, because `current_membership_v1` keys on `auth.uid()` and the token decides
    // whose row it is. Narrowing that merged interface belongs to the page path (T-101c /
    // resolveTenantContext), not to this PR.
    findMembership: (organisationId) => {
      if (accessToken === null) throw new Error("membership lookup needs the session access token");
      return ports.findMembership(organisationId, accessToken);
    },
    policyRevision: (organisationId) => {
      if (accessToken === null) throw new Error("policy lookup needs the session access token");
      return ports.policyRevision(organisationId, accessToken);
    },
  };

  const resolution = await resolveTenantContext({
    request: { url: input.request.url },
    hostOptions: input.hostOptions,
    userId,
    store,
  });
  if (resolution.ok) return { kind: "signed_in" };

  switch (resolution.reason) {
    case "not_a_member":
      return { kind: "no_access", reason: "not_a_member" };
    case "membership_not_active":
      return { kind: "no_access", reason: "membership_not_active" };
    case "tenant_not_live":
      return { kind: "tenant_not_live" };
    case "no_session":
    case "backend_failure": {
      const csrfToken =
        host !== null && hasUsableSecret(secret)
          ? await issueCsrfToken({ host, secret: secret as string, now: ports.now() })
          : null;
      const outcome = resolution.reason === "backend_failure" ? "unavailable" : safeOutcome(input.outcome);
      return { kind: "sign_in", csrfToken, outcome };
    }
    default:
      // Unknown, malformed, reserved, preview alias, IP literal: one generic page, and it never
      // says which of them it was, so the surface cannot be used to probe which workspaces exist.
      return { kind: "unknown_address" };
  }
}
