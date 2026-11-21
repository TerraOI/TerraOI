import { WorkerEntrypoint } from "cloudflare:workers";

import {
  mintObjectUrl,
  type MintObjectUrlArgs,
  type MintObjectUrlEnv,
  type MintObjectUrlResult,
} from "./mint-object-url";
import { runScheduledTick, type ScheduledEnv } from "./scheduled";

/**
 * Named RPC entrypoint for the app Worker's service binding (#170 / ADR-0011).
 * Publishes no HTTP route: `workers/wrangler.jsonc` sets `workers_dev: false` and
 * declares no `routes`. The only caller is the app Worker via `OBJECT_URL_MINT`.
 */
export class ObjectUrlMint extends WorkerEntrypoint<MintObjectUrlEnv> {
  async mintObjectUrl(args: MintObjectUrlArgs): Promise<MintObjectUrlResult> {
    return mintObjectUrl(args, this.env);
  }
}

type ExtractionEnv = MintObjectUrlEnv & ScheduledEnv;

/**
 * Default export: no public HTTP; cron drives outbox dispatch then pull (#170 / #99).
 * T-212 extractor wiring lands in `resolveCloudExtractor()` — until then pull stays idle;
 * outbox dispatch still runs whenever JOB_DB + TOI_WORKER_TOKEN are bound.
 */
export default class ExtractionWorker extends WorkerEntrypoint<ExtractionEnv> {
  fetch(): Response {
    return new Response("not found", { status: 404 });
  }

  async scheduled(): Promise<void> {
    await runScheduledTick(this.env);
  }
}
