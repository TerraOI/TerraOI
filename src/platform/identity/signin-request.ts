import { parseHost, requestHost, type HostAdapterOptions } from "@/platform/tenancy/host";
import type { HostRecord } from "@/platform/tenancy/resolve-tenant-context";

import { isHttpsUrl } from "./cookie";
import { canonicalEmail } from "./email";
import { verifyCsrfToken } from "./csrf";
import { loginRedirect, readCappedBody, statusOnly } from "./http-response";
import { hasUsableSecret } from "./signed-token";

/**
 * The guard chain every state-changing sign-in endpoint runs, in one place (plan §4.2, T-102a/T-102c).
 *
 * T-201 adds three more of these endpoints — password, Entra start, password recovery — and a guard
 * that has to be remembered three times is a guard that gets forgotten once. The order is the design:
 * method → host (registry first, so an unregistered address gets nothing at all, per the T-101 rule) →
 * exact `Origin` → content type and size → CSRF → rate limit → only then the credential. A request
 * that fails any of the first six never reaches the provider or the database.
 *
 * The organization is decided at step 2, from the routed URL. Nothing downstream can be handed a
 * tenant: the returned `organisation` is the only one the caller sees, and every scoped read that
 * follows takes its `p_organisation_id` from it (AGENTS.md §4.1).
 */

/** A sign-in form carries an address and a token; anything larger is someone probing. */
export const MAX_BODY_BYTES = 4096;
/** Every provider hand-back lands here; the path is server-chosen, never requested (F05). */
export const CALLBACK_PATH = "/auth/callback";

/** Ports the guards need, and nothing else. */
export interface HostLookupPorts {
  now(): number;
  findHost(host: string): Promise<HostRecord | null>;
}

export interface SignInRequestPorts extends HostLookupPorts {
  signingSecret(): string | null;
  /** The limiter identity: an adapter hashes this, it never stores the address itself. */
  rateLimitKey(input: { host: string; email: string }): Promise<string>;
  allowRequest(key: string): Promise<boolean>;
}

export type GuardedFormRequest =
  | {
      ok: true;
      /** The normalized host the edge routed this request to. The only tenant fact in play. */
      host: string;
      organisation: HostRecord;
      form: URLSearchParams;
      /** The canonical form of the form's `email` field, or null when there was no usable address. */
      email: string | null;
      secureTransport: boolean;
      /**
       * The signing secret, already checked usable. Handed back so a caller cannot re-derive it from
       * the request or skip the check that made it usable.
       */
      secret: string;
    }
  | { ok: false; response: Response };

export async function readGuardedFormRequest(input: {
  request: Request;
  hostOptions?: HostAdapterOptions;
  ports: SignInRequestPorts;
}): Promise<GuardedFormRequest> {
  const { ports } = input;
  if (input.request.method !== "POST") return { ok: false, response: statusOnly(405) };

  const host = requestHost({ url: input.request.url }, input.hostOptions);
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") return { ok: false, response: statusOnly(404) };
  const organisation = await ports.findHost(parsed.host);
  if (organisation === null || organisation.organisationStatus !== "active") return { ok: false, response: statusOnly(404) };

  // Exact Origin: `https://<the host the edge delivered us to>` and nothing else. SameSite would not
  // stop a request from a sibling subdomain, and Origin alone would not stop a forged form.
  if (input.request.headers.get("origin") !== `https://${parsed.host}`) return { ok: false, response: statusOnly(403) };

  const contentType = (input.request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return { ok: false, response: statusOnly(415) };
  const body = await readCappedBody(input.request, MAX_BODY_BYTES);
  if (body === null) return { ok: false, response: statusOnly(413) };

  const secret = ports.signingSecret();
  if (!hasUsableSecret(secret)) return { ok: false, response: loginRedirect(parsed.host, "unavailable", []) };

  const form = new URLSearchParams(body);
  const csrf = await verifyCsrfToken({ token: form.get("csrf_token"), host: parsed.host, secret, now: ports.now() });
  if (!csrf.ok) return { ok: false, response: statusOnly(403) };

  // Canonical form first: the limiter key and the provider both see the canonical address, so
  // `USER@Example.test` cannot buy a second budget or a second identity.
  const email = canonicalEmail(form.get("email"));
  const key = await ports.rateLimitKey({ host: parsed.host, email: email ?? "invalid-address" });
  if (!(await ports.allowRequest(key))) return { ok: false, response: loginRedirect(parsed.host, "rate_limited", []) };

  return {
    ok: true,
    host: parsed.host,
    organisation,
    form,
    email,
    secureTransport: isHttpsUrl(input.request.url),
    secret,
  };
}
