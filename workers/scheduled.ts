import { chunkExtractedText } from "@/platform/knowledge/chunker";

import {
  createIndexJobApi,
  createJobApi,
  createPublishJobApi,
  dispatchOutboxEvents,
  type DispatchOutboxResult,
  type JobDbBinding,
} from "./job-db";
import { createCloudExtractor } from "./cloud-extractor";
import {
  createIndexWorkerDeps,
  runIndexWorkerPull,
  type IndexChunkerPort,
  type IndexEmbedPort,
  type IndexIterationOutcome,
} from "./index-pull";
import {
  createCloudWorkerDeps,
  runCloudWorkerPull,
  type CloudWorkerEnv,
  type ExtractorPort,
  type IterationOutcome,
} from "./ocr-pull";
import {
  createPublishWorkerDeps,
  runPublishWorkerPull,
  type PublishIterationOutcome,
  type PublishJobApiPort,
} from "./publish-pull";

/**
 * Cron entry for the extraction deployment (#170): `triggers.crons` → `scheduled()` →
 * outbox dispatch (#99) then extract / index / publish pulls, each bounded by
 * `DEFAULT_MAX_JOBS_PER_INVOCATION`.
 *
 * Outbox dispatch runs whenever `JOB_DB` + `TOI_WORKER_TOKEN` are bound. Extract pull runs when
 * `resolveCloudExtractor()` returns the T-212-backed port. Index pull stays idle until
 * `resolveIndexEmbed()` returns a port (OWNER wires real embed; chunker is the in-process T-113
 * chunker by default). Publish pull runs whenever JOB_DB + token are bound (skeleton
 * auto-publish; T-213 owns review/revoke policy later).
 */

export type ScheduledEnv = CloudWorkerEnv & {
  JOB_DB?: JobDbBinding;
  TOI_WORKER_TOKEN?: string;
};

export type ScheduledDeps = {
  extractor?: ExtractorPort | null;
  indexChunker?: IndexChunkerPort | null;
  indexEmbed?: IndexEmbedPort | null;
  /**
   * Publish Job API override. `null` keeps the pull idle (tests). Omitted → bind from
   * `JOB_DB` via `createPublishJobApi` (production cron).
   */
  publishJobApi?: PublishJobApiPort | null;
  fetchImpl?: typeof fetch;
  log?: (event:
    | { kind: "scheduled_skip"; reason: string }
    | { kind: "outbox_dispatch"; result: DispatchOutboxResult }
  ) => void;
  /** Override outbox dispatch in tests; default calls `dispatchOutboxEvents`. */
  dispatchOutbox?: (env: ScheduledEnv) => Promise<DispatchOutboxResult | null | { skipped: string }>;
};

export type ScheduledTickResult = {
  outbox: DispatchOutboxResult | { skipped: string };
  pull: IterationOutcome[] | { skipped: string };
  indexPull: IndexIterationOutcome[] | { skipped: string };
  publishPull: PublishIterationOutcome[] | { skipped: string };
};

/**
 * T-212-backed cloud extractor (#135). Returns a port so cron pull leases extract jobs.
 */
export function resolveCloudExtractor(): ExtractorPort | null {
  return createCloudExtractor();
}

/**
 * OWNER / gateway wiring replaces this with a real embed port. Until then the index loop stays
 * idle — lexical-only fixture embeds belong in unit tests, not production cron.
 */
export function resolveIndexEmbed(): IndexEmbedPort | null {
  return null;
}

/** Default chunker: in-process `chunkExtractedText` over extract artifact pages/text. */
export function createDefaultIndexChunker(): IndexChunkerPort {
  return {
    async chunk(input) {
      const pages = input.artifacts
        .map((artifact) => {
          const page =
            artifact.locator !== undefined && typeof artifact.locator.page === "number"
              ? artifact.locator.page
              : undefined;
          return page === undefined
            ? { page: artifact.artifactIndex + 1, text: artifact.bodyText }
            : { page, text: artifact.bodyText };
        })
        .filter((page) => page.text.trim().length > 0);
      if (pages.length === 0) return [];
      return chunkExtractedText({
        sourceVersionId: input.sourceVersionId,
        parserGeneration: input.parserGeneration,
        dataClass: input.dataClass,
        pages,
      });
    },
  };
}

const DEFAULT_OUTBOX_LIMIT = 32;

async function defaultDispatchOutbox(env: ScheduledEnv): Promise<DispatchOutboxResult | null | { skipped: string }> {
  if (env.JOB_DB === undefined) return { skipped: "job_db_unbound" };
  const token = env.TOI_WORKER_TOKEN;
  if (token === undefined || token.length === 0) return { skipped: "worker_token_missing" };
  return dispatchOutboxEvents({ binding: env.JOB_DB }, { credential: token, limit: DEFAULT_OUTBOX_LIMIT });
}

/**
 * One cron tick: drain extract_succeeded → index and index_succeeded → publish, then
 * (if wired) extract + index pulls, and always the publish pull when JOB_DB is bound.
 */
export async function runScheduledTick(
  env: ScheduledEnv,
  deps: ScheduledDeps = {},
): Promise<ScheduledTickResult> {
  const dispatch = deps.dispatchOutbox ?? defaultDispatchOutbox;
  let outbox: DispatchOutboxResult | { skipped: string };
  try {
    const raw = await dispatch(env);
    if (raw === null) {
      outbox = { skipped: "job_db_unbound" };
    } else {
      outbox = raw;
    }
  } catch {
    outbox = { skipped: "dispatch_refused" };
  }
  if ("processed" in outbox) {
    deps.log?.({ kind: "outbox_dispatch", result: outbox });
  } else {
    deps.log?.({ kind: "scheduled_skip", reason: outbox.skipped });
  }

  const pull = await runScheduledCloudPull(env, deps);
  const indexPull = await runScheduledIndexPull(env, deps);
  const publishPull = await runScheduledPublishPull(env, deps);
  return { outbox, pull, indexPull, publishPull };
}

export async function runScheduledCloudPull(
  env: ScheduledEnv,
  deps: ScheduledDeps = {},
): Promise<IterationOutcome[] | { skipped: string }> {
  const extractor = deps.extractor !== undefined ? deps.extractor : resolveCloudExtractor();
  if (extractor === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "extractor_unwired" });
    return { skipped: "extractor_unwired" };
  }
  if (env.JOB_DB === undefined) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }
  const jobApi = createJobApi({ binding: env.JOB_DB });
  if (jobApi === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }

  const cloudDeps = createCloudWorkerDeps({
    env,
    jobApi,
    extractor,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  return runCloudWorkerPull(cloudDeps);
}

export async function runScheduledIndexPull(
  env: ScheduledEnv,
  deps: ScheduledDeps = {},
): Promise<IndexIterationOutcome[] | { skipped: string }> {
  const embed = deps.indexEmbed !== undefined ? deps.indexEmbed : resolveIndexEmbed();
  if (embed === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "index_embed_unwired" });
    return { skipped: "index_embed_unwired" };
  }
  if (env.JOB_DB === undefined) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }
  const jobApi = createIndexJobApi({ binding: env.JOB_DB });
  if (jobApi === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }

  const chunker =
    deps.indexChunker !== undefined && deps.indexChunker !== null
      ? deps.indexChunker
      : createDefaultIndexChunker();

  const indexDeps = createIndexWorkerDeps({
    env,
    jobApi,
    chunker,
    embed,
  });
  return runIndexWorkerPull(indexDeps);
}

/**
 * Skeleton auto-publish: lease `publish` and call `publish_version_v1`. Idle when JOB_DB
 * or the worker token is missing, or when tests pass `publishJobApi: null`.
 */
export async function runScheduledPublishPull(
  env: ScheduledEnv,
  deps: ScheduledDeps = {},
): Promise<PublishIterationOutcome[] | { skipped: string }> {
  if (deps.publishJobApi === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "publish_unwired" });
    return { skipped: "publish_unwired" };
  }
  if (env.JOB_DB === undefined && deps.publishJobApi === undefined) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }
  const jobApi =
    deps.publishJobApi ??
    (env.JOB_DB !== undefined ? createPublishJobApi({ binding: env.JOB_DB }) : null);
  if (jobApi === null) {
    deps.log?.({ kind: "scheduled_skip", reason: "job_db_unbound" });
    return { skipped: "job_db_unbound" };
  }
  const token = env.TOI_WORKER_TOKEN;
  if (token === undefined || token.length === 0) {
    deps.log?.({ kind: "scheduled_skip", reason: "worker_token_missing" });
    return { skipped: "worker_token_missing" };
  }

  const publishDeps = createPublishWorkerDeps({
    env,
    jobApi,
  });
  return runPublishWorkerPull(publishDeps);
}
