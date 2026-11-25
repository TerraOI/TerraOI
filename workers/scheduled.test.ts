import { describe, expect, it, vi } from "vitest";

import { resolveCloudExtractor, runScheduledCloudPull, runScheduledTick } from "./scheduled";
import type { ExtractorPort } from "./ocr-pull";

const idleExtractor: ExtractorPort = {
  extract: async () => ({ outcome: "unsupported", reason: "unsupported_document" }),
};

describe("resolveCloudExtractor (T-211 Cut E)", () => {
  it("returns the T-212-backed cloud extractor port", () => {
    const port = resolveCloudExtractor();
    expect(port).not.toBeNull();
    expect(typeof port?.extract).toBe("function");
  });
});

describe("runScheduledCloudPull (#170 cron)", () => {
  it("skips without leasing when the extractor is explicitly null", async () => {
    const log = vi.fn();
    const result = await runScheduledCloudPull(
      { JOB_DB: { connectionString: "postgres://x" }, TOI_WORKER_TOKEN: "tok" },
      { extractor: null, log },
    );
    expect(result).toEqual({ skipped: "extractor_unwired" });
    expect(log).toHaveBeenCalledWith({ kind: "scheduled_skip", reason: "extractor_unwired" });
  });

  it("skips when JOB_DB is unbound", async () => {
    const result = await runScheduledCloudPull(
      { TOI_WORKER_TOKEN: "tok" },
      { extractor: idleExtractor },
    );
    expect(result).toEqual({ skipped: "job_db_unbound" });
  });
});

describe("runScheduledTick (#99 outbox + #170 pull)", () => {
  it("dispatches outbox even when the extractor is unwired", async () => {
    const log = vi.fn();
    const result = await runScheduledTick(
      { JOB_DB: { connectionString: "postgres://x" }, TOI_WORKER_TOKEN: "tok" },
      {
        extractor: null,
        log,
        dispatchOutbox: async () => ({ processed: 2, enqueued: 1, skipped: 1 }),
      },
    );
    expect(result.outbox).toEqual({ processed: 2, enqueued: 1, skipped: 1 });
    expect(result.pull).toEqual({ skipped: "extractor_unwired" });
    expect(log).toHaveBeenCalledWith({
      kind: "outbox_dispatch",
      result: { processed: 2, enqueued: 1, skipped: 1 },
    });
  });

  it("skips outbox when JOB_DB is unbound and still reports pull skip", async () => {
    const result = await runScheduledTick(
      { TOI_WORKER_TOKEN: "tok" },
      { extractor: null },
    );
    expect(result.outbox).toEqual({ skipped: "job_db_unbound" });
    expect(result.pull).toEqual({ skipped: "extractor_unwired" });
  });

  it("skips outbox when the worker token is missing", async () => {
    const result = await runScheduledTick(
      { JOB_DB: { connectionString: "postgres://x" } },
      { extractor: null },
    );
    expect(result.outbox).toEqual({ skipped: "worker_token_missing" });
  });
});
