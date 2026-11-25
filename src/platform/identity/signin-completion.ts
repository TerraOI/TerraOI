import { z } from "zod";

import type { MembershipRecord } from "@/platform/tenancy/resolve-tenant-context";

import { canonicalEmail } from "./email";
import { loginRedirect, redirectSameHost } from "./http-response";
import type { CookieSpec } from "./cookie";
import { issueSession } from "./session";
import { issueSetPasswordGrant } from "./set-password-grant";
import { SET_PASSWORD_PATH } from "./set-password";
import { hasUsableSecret } from "./signed-token";
import { isUsableTokenPair, type SessionStore, type TokenCipher } from "./session-store";

/**
 * The half every sign-in method shares, once a provider has said *who* this is (plan §4.1 step 6,
 * §4.2, F02, ADR-0003 §7).
 *
 * T-102 held this inline in the magic-link callback. T-201 adds two more ways to arrive here — a
 * password credential and a Microsoft Entra identity, plus a recovery link returning through the same
 * callback — and "whoever signed in, on this host, gets a session; the membership row decides access"
 * is exactly the rule that must not be restated three times. The magic-link suite is unmodified and
 * still runs against this code, which is what makes the extraction reviewable.
 *
 * The order is the contract:
 *   1. a provider-verified address, canonical, or nothing downstream runs;
 *   2. a usable token pair, or no row can be written;
 *   3. for a recovery, the user's other sessions on this host go first — a reset that did not revoke
 *      is not reported as one;
 *   4. the caller's own membership, read as `current_membership_v1` with their token (no user argument
 *      to get wrong, ADR-0003 §3b); an `invited` row may be claimed, and the claim is not taken on
 *      trust — access follows the row as it is now;
 *   5. one host-only session, then — for a recovery — the set-password surface (plan §4.2: a reset
 *      that never sets a new password is only a second magic link); otherwise the workspace or the
 *      no-access surface.
 *
 * A verified identity with no active membership still gets its session: it proves a sign-in happened,
 * which is what a session means here, and the no-access page is what the membership answer produces.
 */

/**
 * The provider half. `ok: true` carries the **token pair**, not just the identity: the Worker is the
 * only holder of a user's Supabase tokens (#37 option b), and an adapter that drops them cannot mint
 * a session.
 *
 * `provider` and `issuerTenantId` are what T-201's Entra gate needs to tell an Entra identity from a
 * mail one and to check it against the tenant's allow-list. Both are absent for a magic-link identity,
 * which is correct: the email provider has no issuer tenant, and the gate does not run for it.
 */
export type IdentityExchange =
  | {
      ok: true;
      userId: string;
      email: string;
      emailVerified: boolean;
      accessToken: string;
      refreshToken: string;
      tokenExpiresAt: number;
      provider?: string;
      issuerTenantId?: string | null;
    }
  | { ok: false; reason: "invalid_or_expired" };

export interface SignInCompletionPorts {
  now(): number;
  /**
   * Signing secret for the recovery-only set-password grant cookie. Null refuses a recovery
   * completion rather than redirecting to set-password with an ordinary session alone (#181 Round-2).
   */
  signingSecret(): string | null;
  /** Null where the session row is not reachable: the honest answer is "unavailable", never a self-contained cookie. */
  sessionStore(): SessionStore | null;
  /** Null means the token pair cannot be sealed, so there is no session to issue. */
  tokenCipher(): TokenCipher | null;
  findMembership(organisationId: string, accessToken: string): Promise<MembershipRecord | null>;
  /**
   * The invite claim (#179, `redeem_invitation_v1`): the caller's provider-verified address claims a
   * pending invitation of the tenant **this host** routes to. Sent with the identity's own token; no
   * user id, email or organisation id travels — SQL reads them from `auth.uid()`, `auth.users` and the
   * host. "redeemed" is never taken on trust: the membership is re-read.
   */
  redeemInvitation(input: { host: string; accessToken: string }): Promise<"redeemed" | "not_found" | "email_mismatch">;
  /**
   * The revocation a completed password reset owes: every session this user holds on **every host of
   * the organisation this host routes to** (#182) — the host selects the organisation; a company1 reset
   * cannot reach the same user's company2 sessions. Absent means the carrier (`SESSION_DB`) is not
   * bound, which refuses a reset rather than completing one without it (`revoke_user_sessions_v1`).
   *
   * `true` means **the revocation ran**, not "it revoked at least one row": a user with no other live
   * session has nothing to revoke and their reset must still complete. PR-2's RPC and its pgTAP
   * assertion keep that meaning (#183), because a completion that read "zero rows" as a failure would
   * lock the first-ever reset out.
   */
  revokeUserSessions?(input: { userId: string; host: string; now: number }): Promise<boolean>;
}

/**
 * Checked by every handler **before** it contacts a provider: an unwired deployment must neither burn
 * a single-use code nor leave a browser half-signed-in, and the alternative — issuing the
 * self-contained cookie #37 rejected — is not available here.
 */
export function signInCarrierReady(ports: SignInCompletionPorts): boolean {
  return ports.sessionStore() !== null && ports.tokenCipher() !== null;
}

export async function completeSignIn(input: {
  host: string;
  organisationId: string;
  identity: IdentityExchange;
  ports: SignInCompletionPorts;
  secureTransport: boolean;
  /** Cookies to attach to the answer (for the callback: the consumed login state). */
  attach: readonly CookieSpec[];
  /** True when the verified login state marked this completion a password recovery. */
  recovery: boolean;
  /** Fixed log marker naming which endpoint we are on, so a failure line says where it happened. */
  logContext: string;
}): Promise<Response> {
  const { ports, host, logContext } = input;
  const { identity } = input;
  if (!identity.ok) return loginRedirect(host, "unavailable", input.attach);

  // An invite binds to a provider-verified address (plan §4.2: "do not auto-link unverified emails"),
  // and only its canonical form goes anywhere: nothing downstream may compare or store a raw address.
  if (!identity.emailVerified) return loginRedirect(host, "unavailable", input.attach);
  const email = canonicalEmail(identity.email);
  if (email === null || !z.uuid().safeParse(identity.userId).success) {
    return loginRedirect(host, "unavailable", input.attach);
  }

  // An exchange that returns an identity but no usable pair cannot produce a session: the row would
  // hold a credential the server cannot use, and every later call would fail obscurely instead of here.
  const tokens = { accessToken: identity.accessToken, refreshToken: identity.refreshToken, expiresAt: identity.tokenExpiresAt };
  if (!isUsableTokenPair(tokens, ports.now())) {
    console.error(`${logContext} failed`, { host, step: "token_pair" });
    return loginRedirect(host, "unavailable", input.attach);
  }

  const sessionStore = ports.sessionStore();
  const tokenCipher = ports.tokenCipher();
  if (sessionStore === null || tokenCipher === null) return loginRedirect(host, "unavailable", input.attach);

  // A reset has to take the user's other sessions down on this host *before* the new one exists, so
  // there is no window in which a changed password leaves an old cookie live. No port means no
  // revocation, and a reset that cannot revoke is not completed.
  if (input.recovery) {
    if (typeof ports.revokeUserSessions !== "function") {
      console.error(`${logContext} refused`, { host, step: "session_revocation", reason: "unwired" });
      return loginRedirect(host, "unavailable", input.attach);
    }
    let revoked: boolean;
    try {
      revoked = await ports.revokeUserSessions({ userId: identity.userId, host, now: ports.now() });
    } catch {
      console.error(`${logContext} failed`, { host, step: "session_revocation" });
      return loginRedirect(host, "unavailable", input.attach);
    }
    if (!revoked) {
      // Never report a reset that did not take the old sessions with it: the browser is told the same
      // generic outcome either way, and this is the line that says the server half did not happen.
      console.error(`${logContext} refused`, { host, step: "session_revocation" });
      return loginRedirect(host, "unavailable", input.attach);
    }
  }

  try {
    let membership = await ports.findMembership(input.organisationId, identity.accessToken);
    // #179: an invitee has no membership row until they claim; an existing row of any status is never
    // re-activated by signing in (SQL answers not_found), so only "no row" asks the question.
    if (membership === null) {
      const claim = await ports.redeemInvitation({ host, accessToken: identity.accessToken });
      // "redeemed" is not taken on trust: access follows the row as it is now.
      if (claim === "redeemed") {
        membership = await ports.findMembership(input.organisationId, identity.accessToken);
      }
    }

    let session: Awaited<ReturnType<typeof issueSession>>;
    try {
      session = await issueSession({
        userId: identity.userId,
        host,
        tokens,
        store: sessionStore,
        cipher: tokenCipher,
        now: ports.now(),
        secureTransport: input.secureTransport,
      });
    } catch {
      // The row could not be written, or the pair could not be sealed: no cookie is set, and the
      // visitor gets the same generic outcome as any other backend failure. A half-written session is
      // worse than none, so nothing is emitted on this path.
      console.error(`${logContext} failed`, { host, step: "session_store" });
      return loginRedirect(host, "unavailable", input.attach);
    }
    const cookies: CookieSpec[] = [session.cookie, ...input.attach];

    // A recovery that stops at "/" never changes the password: the forgotten credential still works
    // and "reset" was only a second magic link. The set-password surface runs GoTrue's user update
    // with this session's access token (`set-password.ts`); membership decides access *after* that.
    // The grant cookie is what keeps an ordinary signed-in session out of that surface (#181 Round-2).
    if (input.recovery) {
      const secret = ports.signingSecret();
      if (!hasUsableSecret(secret)) {
        console.error(`${logContext} refused`, { host, step: "set_password_grant", reason: "unwired" });
        return loginRedirect(host, "unavailable", cookies);
      }
      try {
        cookies.push(
          await issueSetPasswordGrant({
            host,
            userId: identity.userId,
            secret,
            now: ports.now(),
            secureTransport: input.secureTransport,
          }),
        );
      } catch {
        console.error(`${logContext} failed`, { host, step: "set_password_grant" });
        return loginRedirect(host, "unavailable", cookies);
      }
      return redirectSameHost(host, SET_PASSWORD_PATH, cookies);
    }

    if (membership !== null && membership.status === "active") {
      return redirectSameHost(host, "/", cookies);
    }
    return loginRedirect(host, "not_a_member", cookies);
  } catch {
    console.error(`${logContext} failed`, { host, step: "membership" });
    return loginRedirect(host, "unavailable", input.attach);
  }
}
