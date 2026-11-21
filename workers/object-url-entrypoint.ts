import { WorkerEntrypoint } from "cloudflare:workers";

import {
  mintObjectUrl,
  type MintObjectUrlArgs,
  type MintObjectUrlEnv,
  type MintObjectUrlResult,
} from "./mint-object-url";

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

/** Default export answers no public traffic — the deployment has no routes. */
export default class extends WorkerEntrypoint {
  fetch(): Response {
    return new Response("not found", { status: 404 });
  }
}
