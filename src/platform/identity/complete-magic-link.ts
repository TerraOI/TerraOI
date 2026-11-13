import { z } from "zod";

import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import type { HostRecord, MembershipRecord } from "@/platform/tenancy/resolve-tenant-context";

import { isDevelopmentRuntime, isHttpsUrl, type CookieSpec } from "./cookie";
import { consumeLoginState, verifyLoginState } from "./login-state";
import { canonicalEmail } from "./email";
import { statusOnly, redirectSameHost, LOGIN_PATH } from "./http-response";
import { issueSession } from "./session";
import { isUsableTokenPair, type SessionStore, type TokenCipher } from "./session-store";
import { hasUsableSecret } from "./signed-token";

/**
 * `GET /auth/callback` — the provider hands the browser a URL, and a URL is not a credential.
 *
 * The order is the whole design: the host is resolved from the routed URL, the single-use login
 * state (cookie + `state` parameter, host-bound, 10 minutes) is verified **before the provider is
 * contacted**, and only a verified identity may reach the membership question. So a forwarded link,
 * an expired link, an already-used code and a tenant-A link opened on tenant B's host all stop at a
 * step that touches no tenant data and sets no session.
 *
 * A verified identity always gets a host-only session, because that is what it is: proof of a
 * sign-in on this host. It is the current `organisation_memberships` row that decides access, so a
 * stranger, a suspended member and an unclaimed invite all land on the no-access surface.
 */

export type IdentityExchange =
  /**
   * The provider's PKCE exchange result. #37 option (b) needs the **token pair**, not just the
   * identity: the Worker is the only holder of the user's Supabase tokens, and it stores them (sealed)
   * in the session row. An adapter that drops them cannot mint a session, which is why they are part
   * of the type rather than an optional extra.
   */
  | { ok: true; userId: string; email: string; emailVerified: boolean; accessToken: string; refreshToken: string; tokenExpiresAt: number }
  | { ok: false; reason: "invalid_or_expired" };

export interface MagicLinkCallbackPorts {
  now(): number;
  signingSecret(): string | null;
  /**
   * The server-side session row (#37 option b). Null where the row is not reachable yet — the state of
   * every deployment until #75 settles the carrier — and the honest answer then is "sign-in is
   * unavailable", never a self-contained cookie issued in its place.
   */
  sessionStore(): SessionStore | null;
  /** The `SESSION_TOKEN_KEY` cipher. Null means the token pair cannot be sealed, so no session. */
  tokenCipher(): TokenCipher | null;
  findHost(host: string): Promise<HostRecord | null>;
  /**
   * The provider half (Supabase PKCE code exchange in the real adapter). `invalid_or_expired` covers
   * an expired link and a code that has already been used; the reason detail stays here.
   */
  exchangeLoginCode(input: {
    code: string;
    state: string;
    host: string;
    /**
     * The PKCE verifier, read out of the verified login-state cookie (never from the request). The
     * provider will not exchange a code without it, and it is what makes a captured callback URL
     * useless on its own.
     */
    codeVerifier: string;
  }): Promise<IdentityExchange>;
  findMembership(organisationId: string, userId: string, accessToken: string): Promise<MembershipRecord | null>;
  /**
   * The invite half of F05: claim the invited membership that exists for **this** organization.
   * `organisationId` is always the host-resolved one, and `email` is always canonical — a raw
   * address reaching this port is the bypass the packet's acceptance item is about.
   */
  redeemInvitation(input: { organisationId: string; userId: string; email: string }): Promise<"redeemed" | "not_found" | "email_mismatch">;
}

export interface MagicLinkCallbackInput {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: MagicLinkCallbackPorts;
}

export async function completeMagicLink(input: MagicLinkCallbackInput): Promise<Response> {
  const { ports } = input;

  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") return statusOnly(404);
  const organisation = await ports.findHost(parsed.host);
  if (organisation === null || organisation.organisationStatus !== "active") return statusOnly(404);

  const secureTransport = isHttpsUrl(input.request.url);
  // Clearing the state cookie follows the same environment rule as issuing it (PR #18 N1): outside
  // `next dev` an insecure cookie form does not exist, and an `http://` request URL never reaches a
  // Worker anyway — the 404/redirect paths above already handle a host that cannot be honored.
  const consumedState: CookieSpec[] = secureTransport || isDevelopmentRuntime() ? [consumeLoginState(secureTransport)] : [];
  const secret = ports.signingSecret();
  const url = new URL(input.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!hasUsableSecret(secret)) return loginRedirect(parsed.host, "unavailable", consumedState);

  const sessionStore = ports.sessionStore();
  const tokenCipher = ports.tokenCipher();
  if (sessionStore === null || tokenCipher === null) {
    // No row, no session. This is checked **before** the provider is contacted so an unwired
    // deployment neither burns a single-use code nor leaves a browser half-signed-in: the alternative
    // would be the self-contained cookie #37 rejected. Issue #75 decides how the row is reached; until
    // then the adapter returns null here and sign-in says "unavailable".
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }

  const stateCheck = await verifyLoginState({
    cookieHeader: input.request.headers.get("cookie"),
    presentedState: state,
    host: parsed.host,
    secret,
    now: ports.now(),
  });
  if (!stateCheck.ok || code === null || code.length === 0 || state === null) {
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }

  let identity: Awaited<ReturnType<MagicLinkCallbackPorts["exchangeLoginCode"]>>;
  try {
    identity = await ports.exchangeLoginCode({
      code,
      state,
      host: parsed.host,
      codeVerifier: stateCheck.codeVerifier,
    });
  } catch {
    console.error("magic-link callback failed", { host: parsed.host, step: "exchangeLoginCode" });
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }
  if (!identity.ok) return loginRedirect(parsed.host, "unavailable", consumedState);

  // An invite binds to a provider-verified address (plan §4.2 "do not auto-link unverified emails"),
  // and only its canonical form goes anywhere: nothing downstream may compare or store a raw address.
  if (!identity.emailVerified) return loginRedirect(parsed.host, "unavailable", consumedState);
  const email = canonicalEmail(identity.email);
  if (email === null || !z.uuid().safeParse(identity.userId).success) {
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }

  // An exchange that returns an identity but no usable pair cannot produce a session: the row would
  // hold a credential the server cannot use, and every later call would fail obscurely instead of
  // here. Checked before any tenant lookup, so a broken exchange never reads membership.
  const tokens = {
    accessToken: identity.accessToken,
    refreshToken: identity.refreshToken,
    expiresAt: identity.tokenExpiresAt,
  };
  if (!isUsableTokenPair(tokens, ports.now())) {
    console.error("magic-link callback failed", { host: parsed.host, step: "token_pair" });
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }

  try {
    let membership = await ports.findMembership(organisation.organisationId, identity.userId, identity.accessToken);
    if (membership !== null && membership.status === "invited") {
      const claim = await ports.redeemInvitation({
        organisationId: organisation.organisationId,
        userId: identity.userId,
        email,
      });
      // "redeemed" is not taken on trust: access follows the row as it is now.
      if (claim === "redeemed") {
        membership = await ports.findMembership(organisation.organisationId, identity.userId, identity.accessToken);
      }
    }

    let session: Awaited<ReturnType<typeof issueSession>>;
    try {
      session = await issueSession({
        userId: identity.userId,
        host: parsed.host,
        tokens,
        store: sessionStore,
        cipher: tokenCipher,
        now: ports.now(),
        secureTransport,
      });
    } catch {
      // The row could not be written, or the pair could not be sealed: no cookie is set, and the
      // visitor gets the same generic outcome as any other backend failure. A half-written session is
      // worse than none, so nothing is emitted on this path.
      console.error("magic-link callback failed", { host: parsed.host, step: "session_store" });
      return loginRedirect(parsed.host, "unavailable", consumedState);
    }
    const cookies: CookieSpec[] = [session.cookie, ...consumedState];

    if (membership !== null && membership.status === "active") {
      return redirectSameHost(parsed.host, "/", cookies);
    }
    return loginRedirect(parsed.host, "not_a_member", cookies);
  } catch {
    console.error("magic-link callback failed", { host: parsed.host, step: "membership" });
    return loginRedirect(parsed.host, "unavailable", consumedState);
  }
}

function loginRedirect(host: string, outcome: "unavailable" | "not_a_member", cookies: readonly CookieSpec[]): Response {
  return redirectSameHost(host, `${LOGIN_PATH}?outcome=${outcome}`, cookies);
}
