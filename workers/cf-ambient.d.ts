/** Minimal ambient types so `workers/` can extend WorkerEntrypoint without a Workers types package. */
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    readonly env: Env;
    readonly ctx: {
      waitUntil(promise: Promise<unknown>): void;
    };
    constructor(ctx: WorkerEntrypoint["ctx"], env: Env);
  }
}
