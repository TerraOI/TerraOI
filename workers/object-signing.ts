import type { FetchImpl } from "@/platform/gateway/adapters";

/**
 * The **one** place in this repository that mints a URL for a private object
 * ([ADR-0011](../docs/decisions/0011-object-bytes-for-the-extraction-workers.md), #146).
 *
 * The ruling is narrow on purpose, and this file is the whole of it:
 *
 * 1. A Supabase service-role key lives as a `wrangler secret` on the extraction deployment only, and
 *    it is used for exactly one call — signing the object of the job the caller currently holds a
 *    lease on. `workers/import-boundary.test.ts` fails the moment a second file mentions a signed
 *    URL or a service-role marker, and `localbox/`, `src/app/`, `src/platform/` and `src/contracts/`
 *    may never name the key at all (#135: the box is a different executor with different clearance).
 * 2. The object key is not an input this code may invent. It is the value
 *    `job_api.object_ref_for_lease_v1` returned for the lease the caller holds, under the same
 *    compare as every mutating call (tenant, executor, lease token, fence, expiry, credential). The
 *    shape check below restates the merged column CHECK
 *    (`20261105070000_knowledge_core.sql:176-180`) so a value that arrived from a request, a path
 *    fragment or a hand-edited string fails **here** instead of at Storage.
 * 3. The TTL is #146's 60 seconds, a named constant a reviewer can see. It is never longer than the
 *    shortest lease this API issues (`lease_parse_job_v1`'s 60 s floor), so a URL cannot outlive the
 *    lease that produced it.
 * 4. **Nothing is written down.** No database write, no file, no log line, no cache. The URL is a
 *    capability: ADR-0011 Decision 3 says it is handed to the lease holder once and never stored, and
 *    the same discipline as `job_api.worker_credentials.token_hash` applies to it. On a refusal this
 *    module names the failure from a closed vocabulary and drops Storage's own body — the rule the
 *    gateway adapters apply to a provider error (`src/platform/gateway/adapters.ts:16-23`).
 *
 * No storage SDK is added (ADR-0011 Consequences): this is plain `fetch`, the house pattern.
 */

/** #146: 60 seconds, asserted by `workers/import-boundary.test.ts` as `0 < ttl <= 300`. */
export const SIGNED_URL_TTL_SECONDS = 60;

/** Storage is our own infrastructure; a mint that hangs must not hold a Worker invocation open. */
export const SIGNED_URL_TIMEOUT_MS = 10_000;

/**
 * The `source_versions.object_ref` CHECK, restated: `^knowledge/[a-z0-9][a-z0-9/_.-]*$`, 12..512
 * chars, no `//`, no `../`. Anything else is not a key SQL issued, so it is not signed.
 */
const OBJECT_REF_SHAPE = /^knowledge\/[a-z0-9][a-z0-9/_.-]*$/;
const BUCKET_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Closed vocabulary: what a caller may branch on, and the only thing a refusal may say. */
export type StorageSignFailure =
  /** A secret or a deployment setting is absent: fail closed before the socket (AGENTS §4.6). */
  | "not_configured"
  /** The key is not in the shape `object_ref_for_lease_v1` issues: wrong source, or a path attempt. */
  | "key_not_allowed"
  /** Storage refused the key (401/403): the secret is wrong or was rotated. */
  | "denied"
  /** No such object or bucket (404). */
  | "not_found"
  /** Storage answered 5xx. */
  | "server_error"
  /** The request never completed. */
  | "network"
  /** A 2xx this module will not use — unusable body, or an origin other than the configured one. */
  | "bad_response";

export type SignedUrlResult =
  /** A live capability. Return it to the lease holder; never log it, store it or put it in an event. */
  | { status: "ok"; url: string }
  | { status: "unavailable"; reason: StorageSignFailure };

/** True when `objectRef` is in the shape the merged column CHECK allows. */
export function objectRefIsServerIssued(objectRef: string): boolean {
  if (typeof objectRef !== "string") return false;
  if (objectRef.length < 12 || objectRef.length > 512) return false;
  if (objectRef.includes("//") || objectRef.includes("../") || objectRef.includes("\\")) return false;
  return OBJECT_REF_SHAPE.test(objectRef);
}

export interface SignedUrlRequest {
  /** The Supabase project base, from deployment configuration — never from a request. */
  baseUrl: string;
  /** The private bucket, from deployment configuration (#38 decided capture; the bucket name is a deploy setting, not a secret). */
  bucket: string;
  /** ONLY the value `job_api.object_ref_for_lease_v1` returned for the lease the caller holds. */
  objectRef: string;
  /** Read at call time by `createStorageUrlSigner`; this module never stores or returns it. */
  serviceRoleKey: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

function classifyStatus(status: number): StorageSignFailure {
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  return "bad_response";
}

/** Storage returns either spelling; both are relative to `<base>/storage/v1`. */
function signedPathOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["signedURL", "signedUrl"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Mint one short-lived URL. Returns a named refusal rather than throwing: a caller on a Worker
 * invocation should map a refusal to an action (`abort_parse_job_v1`'s `object_missing`, or drop the
 * lease and let #99's reclaim run), not to a stack trace that might carry the URL in its message.
 */
export async function createSignedUrl(request: SignedUrlRequest): Promise<SignedUrlResult> {
  const { baseUrl, bucket, objectRef, serviceRoleKey } = request;
  if (
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    typeof serviceRoleKey !== "string" ||
    serviceRoleKey.length === 0 ||
    typeof bucket !== "string" ||
    !BUCKET_SHAPE.test(bucket)
  ) {
    return { status: "unavailable", reason: "not_configured" };
  }
  if (!objectRefIsServerIssued(objectRef)) return { status: "unavailable", reason: "key_not_allowed" };

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { status: "unavailable", reason: "not_configured" };
  }

  // Each segment is escaped on its own, so a key that tried to carry a `?`, a `#` or an extra
  // segment cannot rewrite the endpoint it is sent to. (The shape check above already refuses those.)
  const escapedKey = objectRef
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `${base.origin}${base.pathname.replace(/\/+$/, "")}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${escapedKey}`;

  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS, download: false }),
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs ?? SIGNED_URL_TIMEOUT_MS),
    });
  } catch {
    return { status: "unavailable", reason: "network" };
  }

  if (!response.ok) {
    // The body is Storage's, and can name a host, a policy or an object. Classify it; keep nothing.
    void response.body?.cancel().catch(() => undefined);
    return { status: "unavailable", reason: classifyStatus(response.status) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", reason: "bad_response" };
  }

  const signedPath = signedPathOf(payload);
  if (signedPath === undefined) return { status: "unavailable", reason: "bad_response" };

  if (/^https?:\/\//i.test(signedPath)) {
    // A URL that points at another origin would send the token, and whatever the caller adds to the
    // request, somewhere the deployment did not configure. Refuse it.
    if (!sameOrigin(signedPath, baseUrl)) return { status: "unavailable", reason: "bad_response" };
    return { status: "ok", url: signedPath };
  }
  if (signedPath.startsWith("/")) {
    return { status: "ok", url: `${base.origin}${signedPath}` };
  }
  return { status: "ok", url: `${base.origin}${base.pathname.replace(/\/+$/, "")}/storage/v1/${signedPath}` };
}

/**
 * The names this deployment must be configured with. **Names, never values** (AGENTS §4.6): the
 * service-role half is set with `wrangler secret put` and is an owner human step (T-004 §20.8);
 * `wrangler.jsonc` may name it and must never carry it.
 */
export interface StorageSignEnv {
  TOI_SUPABASE_URL?: string | undefined;
  /** The only storage-capable credential in the system, and it exists on this deployment only. */
  TOI_STORAGE_SERVICE_ROLE_KEY?: string | undefined;
  TOI_STORAGE_BUCKET?: string | undefined;
}

/** What the pull loop holds: ask for a URL for a key SQL gave you, get a named answer. */
export type ObjectUrlSigner = (objectRef: string) => Promise<SignedUrlResult>;

/**
 * Reads the secret **when the call is made**, exactly like the gateway's adapters read theirs
 * (`src/platform/gateway/adapters.ts:253-260`): secret bindings resolve per request, so a
 * construction-time read never sees a rotation and freezes a cold-start race into a refusal.
 */
export function createStorageUrlSigner(
  env: StorageSignEnv,
  fetchImpl?: FetchImpl,
): ObjectUrlSigner {
  return (objectRef: string) => {
    // The secret is read here, at call time, and nowhere else in this repository. These are the
    // names `wrangler secret put` and the deployment's `vars` set (T-004 §20.8): the values never
    // appear in this file, in a log, or in anything this function returns.
    const baseUrl = env.TOI_SUPABASE_URL;
    const serviceRoleKey = env.TOI_STORAGE_SERVICE_ROLE_KEY;
    const bucket = env.TOI_STORAGE_BUCKET;
    if (baseUrl === undefined || serviceRoleKey === undefined || bucket === undefined) {
      return Promise.resolve({ status: "unavailable", reason: "not_configured" });
    }
    return createSignedUrl({
      baseUrl,
      bucket,
      objectRef,
      serviceRoleKey,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  };
}
