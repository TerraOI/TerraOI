import {
  lookupObjectRefByTokenHash,
  type JobDbBinding,
  type JobDbDeps,
} from "./job-db";
import {
  SIGNED_URL_TTL_SECONDS,
  createStorageUrlSigner,
  type ObjectUrlSigner,
  type StorageSignEnv,
} from "./object-signing";
import type { ObjectRefOutcome } from "./ocr-pull";

/**
 * Bound-call mint for `/api/jobs/object-url` (#170 / ADR-0011).
 *
 * The app Worker authenticates the box, hashes the credential, and sends only
 * `{ tokenHash, jobId, leaseToken, fence }` over the service binding. This module
 * (and the WorkerEntrypoint that wraps it) runs on the `workers/` deployment: it
 * re-checks the lease over its own `JOB_DB`, signs through `object-signing`, and
 * returns `{ url }` or one generic refusal. The app Worker never sees `object_ref`.
 */

export type MintObjectUrlArgs = {
  tokenHash: string;
  jobId: string;
  leaseToken: string;
  fence: number;
};

export type MintObjectUrlResult = { ok: true; url: string } | { ok: false };

export type MintObjectUrlEnv = StorageSignEnv & {
  JOB_DB?: JobDbBinding;
};

export type MintObjectUrlDeps = {
  lookup?: (deps: JobDbDeps, args: MintObjectUrlArgs) => Promise<ObjectRefOutcome>;
  signer?: ObjectUrlSigner;
  fetchImpl?: typeof fetch;
};

const TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/i;
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argsAreWellFormed(args: MintObjectUrlArgs): boolean {
  return (
    TOKEN_HASH_SHAPE.test(args.tokenHash) &&
    UUID_SHAPE.test(args.jobId) &&
    typeof args.leaseToken === "string" &&
    args.leaseToken.length > 0 &&
    Number.isInteger(args.fence)
  );
}

export async function mintObjectUrl(
  args: MintObjectUrlArgs,
  env: MintObjectUrlEnv,
  deps: MintObjectUrlDeps = {},
): Promise<MintObjectUrlResult> {
  if (!argsAreWellFormed(args)) return { ok: false };
  if (env.JOB_DB === undefined && deps.lookup === undefined) return { ok: false };

  const lookup = deps.lookup ?? lookupObjectRefByTokenHash;
  const ref = await lookup({ binding: env.JOB_DB ?? null }, args);
  if (!ref.found) return { ok: false };

  const signer = deps.signer ?? createStorageUrlSigner(env, deps.fetchImpl);
  const signed = await signer(ref.objectRef);
  if (signed.status !== "ok") return { ok: false };
  return { ok: true, url: signed.url };
}

export { SIGNED_URL_TTL_SECONDS };
