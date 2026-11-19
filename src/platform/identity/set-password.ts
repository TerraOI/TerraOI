import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import type { HostRecord, MembershipRecord } from "@/platform/tenancy/resolve-tenant-context";

import { isHttpsUrl } from "./cookie";
import { issueCsrfToken, verifyCsrfToken } from "./csrf";
import { loginRedirect, redirectSameHost, readCappedBody, statusOnly } from "./http-response";
import { MAX_PASSWORD_CHARS } from "./password-signin";
import { MAX_BODY_BYTES } from "./request-magic-link";
import { readSessionTokens } from "./session";
import {
  clearSetPasswordGrant,
  verifySetPasswordGrant,
} from "./set-password-grant";
import type { SessionStore, TokenCipher } from "./session-store";
import { hasUsableSecret } from "./signed-token";

/**
 * The missing half of password recovery (plan §4.2): after a recovery link completes and the user's
 * other sessions on this host are revoked, the browser lands here to set a **new** password through
 * GoTrue's `PUT /auth/v1/user`. Without this step a completed recovery is only a second magic link —
 * the forgotten password is still the credential (#181 B1).
 *
 * The recovery completion already issued a host-only session whose sealed access token is what
 * authorizes the update, **and** a short-lived set-password grant cookie bound to that user on this
 * host. An ordinary signed-in session without the grant is refused (Round-2 on #181). This surface
 * never accepts a password-reset token in the URL or a user id from the form. The organization still
 * comes only from the routed host.
 */

/** Where a completed recovery redirects; owned by this packet (`src/app/(tenant)/account/…`). */
export const SET_PASSWORD_PATH = "/account/set-password";

/** Plan §4.2 / archived M1 surface: minimum length before the provider is dialed. */
export const MIN_PASSWORD_LENGTH = 10;

export type SetPasswordOutcome = "unavailable" | "rejected";

export interface SetPasswordPorts {
  now(): number;
  signingSecret(): string | null;
  sessionStore(): SessionStore | null;
  tokenCipher(): TokenCipher | null;
  findHost(host: string): Promise<HostRecord | null>;
  findMembership(organisationId: string, accessToken: string): Promise<MembershipRecord | null>;
  /**
   * GoTrue `PUT /auth/v1/user` with the session's access token. The password never appears in a log
   * line this module writes.
   */
  updatePassword(input: { accessToken: string; password: string }): Promise<"updated" | "rejected">;
  /** Limiter identity: adapter hashes `host|material` (same shape as `SignInRequestPorts`). */
  rateLimitKey(input: { host: string; material: string }): Promise<string>;
  allowRequest(key: string): Promise<boolean>;
}

export type SetPasswordView =
  | { kind: "form"; host: string; csrfToken: string; outcome: SetPasswordOutcome | null }
  | { kind: "redirect"; response: Response };

/**
 * GET half: a live recovery grant + session on this host is required. No grant → login, even if a
 * normal session cookie is present — never a form that would accept a password for an ordinary visit.
 */
export async function buildSetPasswordView(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: SetPasswordPorts;
  outcome?: unknown;
}): Promise<SetPasswordView> {
  const { ports } = input;
  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") {
    return { kind: "redirect", response: statusOnly(404) };
  }
  const organisation = await ports.findHost(parsed.host);
  if (organisation === null || organisation.organisationStatus !== "active") {
    return { kind: "redirect", response: statusOnly(404) };
  }

  const secret = ports.signingSecret();
  if (!hasUsableSecret(secret)) {
    return { kind: "redirect", response: loginRedirect(parsed.host, "unavailable", []) };
  }

  const sessionStore = ports.sessionStore();
  const tokenCipher = ports.tokenCipher();
  if (sessionStore === null || tokenCipher === null) {
    return { kind: "redirect", response: loginRedirect(parsed.host, "unavailable", []) };
  }

  const tokens = await readSessionTokens({
    cookieHeader: input.request.headers.get("cookie"),
    host: parsed.host,
    now: ports.now(),
    store: sessionStore,
    cipher: tokenCipher,
  });
  if (!tokens.ok) {
    return { kind: "redirect", response: loginRedirect(parsed.host, "unavailable", []) };
  }

  const grant = await verifySetPasswordGrant({
    cookieHeader: input.request.headers.get("cookie"),
    host: parsed.host,
    userId: tokens.userId,
    secret,
    now: ports.now(),
  });
  if (!grant.ok) {
    return { kind: "redirect", response: loginRedirect(parsed.host, "unavailable", []) };
  }

  const csrfToken = await issueCsrfToken({ host: parsed.host, secret, now: ports.now() });
  return {
    kind: "form",
    host: parsed.host,
    csrfToken,
    outcome: safeSetPasswordOutcome(input.outcome),
  };
}

/**
 * `POST /auth/set-password` — CSRF + session-bound GoTrue password update, then the same post-sign-in
 * choice between the workspace and the no-access surface.
 */
export async function handleSetPassword(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: SetPasswordPorts;
}): Promise<Response> {
  const { ports } = input;
  if (input.request.method !== "POST") return statusOnly(405);

  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") return statusOnly(404);
  const organisation = await ports.findHost(parsed.host);
  if (organisation === null || organisation.organisationStatus !== "active") return statusOnly(404);

  if (input.request.headers.get("origin") !== `https://${parsed.host}`) return statusOnly(403);

  const contentType = (input.request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return statusOnly(415);

  const secret = ports.signingSecret();
  if (!hasUsableSecret(secret)) return loginRedirect(parsed.host, "unavailable", []);

  const body = await readCappedBody(input.request, MAX_BODY_BYTES);
  if (body === null) return statusOnly(413);
  const form = new URLSearchParams(body);

  const csrf = await verifyCsrfToken({
    token: form.get("csrf_token"),
    host: parsed.host,
    secret,
    now: ports.now(),
  });
  if (!csrf.ok) return statusOnly(403);

  const sessionStore = ports.sessionStore();
  const tokenCipher = ports.tokenCipher();
  if (sessionStore === null || tokenCipher === null) {
    return loginRedirect(parsed.host, "unavailable", []);
  }

  const cookieHeader = input.request.headers.get("cookie");
  const tokens = await readSessionTokens({
    cookieHeader,
    host: parsed.host,
    now: ports.now(),
    store: sessionStore,
    cipher: tokenCipher,
  });
  if (!tokens.ok) return loginRedirect(parsed.host, "unavailable", []);

  const grant = await verifySetPasswordGrant({
    cookieHeader,
    host: parsed.host,
    userId: tokens.userId,
    secret,
    now: ports.now(),
  });
  if (!grant.ok) return loginRedirect(parsed.host, "unavailable", []);

  // Per-user budget on this host: not shared with Entra start or malformed-address posts (B2/N4).
  const limitKey = await ports.rateLimitKey({
    host: parsed.host,
    material: `set-password|${tokens.userId}`,
  });
  if (!(await ports.allowRequest(limitKey))) {
    return redirectSameHost(parsed.host, `${SET_PASSWORD_PATH}?outcome=unavailable`, []);
  }

  const password = form.get("password");
  const confirm = form.get("confirm");
  if (
    password === null ||
    confirm === null ||
    password !== confirm ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_CHARS
  ) {
    return redirectSameHost(parsed.host, `${SET_PASSWORD_PATH}?outcome=rejected`, []);
  }

  let result: "updated" | "rejected";
  try {
    result = await ports.updatePassword({ accessToken: tokens.tokens.accessToken, password });
  } catch {
    console.error("set-password failed", { host: parsed.host, step: "updatePassword" });
    return redirectSameHost(parsed.host, `${SET_PASSWORD_PATH}?outcome=unavailable`, []);
  }
  if (result !== "updated") {
    return redirectSameHost(parsed.host, `${SET_PASSWORD_PATH}?outcome=rejected`, []);
  }

  const secureTransport = isHttpsUrl(input.request.url);
  const clearGrant = [clearSetPasswordGrant(secureTransport)];

  // Membership decides where they land after the credential exists again — same rule as completion.
  try {
    const membership = await ports.findMembership(organisation.organisationId, tokens.tokens.accessToken);
    if (membership !== null && membership.status === "active") {
      return redirectSameHost(parsed.host, "/", clearGrant);
    }
    return loginRedirect(parsed.host, "not_a_member", clearGrant);
  } catch {
    console.error("set-password failed", { host: parsed.host, step: "membership" });
    return redirectSameHost(parsed.host, `${SET_PASSWORD_PATH}?outcome=unavailable`, []);
  }
}

function safeSetPasswordOutcome(raw: unknown): SetPasswordOutcome | null {
  if (raw === "unavailable" || raw === "rejected") return raw;
  return null;
}
