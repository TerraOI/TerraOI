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

/**
 * Which state-changing sign-in endpoint is asking for a rate-limit key. Each method gets its own
 * material dimension so a flood on one cannot lock the others out for the whole tenant (B2 / N4 on
 * #181): Entra starts are keyed on the client IP, and address-bearing forms are keyed on
 * `method|<canonical-email-or-invalid-address>`. Used for limiting only — never for tenancy.
 */
export type SignInLimitMethod = "magic-link" | "password" | "password-reset" | "entra-start";

export interface SignInRequestPorts extends HostLookupPorts {
  signingSecret(): string | null;
  /**
   * The limiter identity: an adapter hashes `host|material`, and never stores the raw address or IP.
   * `material` is already method-scoped by `readGuardedFormRequest` (see `SignInLimitMethod`).
   */
  rateLimitKey(input: { host: string; material: string }): Promise<string>;
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
  /**
   * Method-scoped limiter dimension. Address-bearing methods compose `method|<email-or-invalid>`;
   * `entra-start` composes `entra-start|<CF-Connecting-IP>` so it never shares the
   * `invalid-address` bucket with malformed magic-link / password / reset posts. Limiting only —
   * the organization still comes only from the routed host (AGENTS.md §4.1).
   */
  limitMethod: SignInLimitMethod;
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

  // Canonical form first: the provider sees the canonical address, so `USER@Example.test` cannot buy
  // a second identity. The limiter dimension is method-scoped (see `limitMaterial`) so address-less
  // and per-method budgets do not collapse onto HMAC(host|"invalid-address").
  const email = canonicalEmail(form.get("email"));
  const material = limitMaterial(input.limitMethod, email, input.request);
  const key = await ports.rateLimitKey({ host: parsed.host, material });
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

/** Limiting material only — never fed into tenancy, membership or provider calls. */
export function limitMaterial(method: SignInLimitMethod, email: string | null, request: Request): string {
  if (method === "entra-start") {
    return `entra-start|${connectingIp(request)}`;
  }
  return `${method}|${email ?? "invalid-address"}`;
}

/**
 * Cloudflare stamps `CF-Connecting-IP` on every proxied request (see `host.ts`). Absent only off
 * the edge (local tests, direct Worker preview); the sentinel keeps those requests in their own
 * bucket without collapsing onto the address-bearing `invalid-address` key.
 */
function connectingIp(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip !== undefined && ip.length > 0 ? ip : "missing-ip";
}
