import { describe, expect, it, vi } from "vitest";

import { runScheduledCloudPull, runScheduledIndexPull, runScheduledTick } from "./scheduled";
import type { ExtractorPort } from "./ocr-pull";
import type { IndexEmbedPort } from "./index-pull";

const idleExtractor: ExtractorPort = {
  extract: async () => ({ outcome: "unsupported", reason: "unsupported_document" }),
};

const idleEmbed: IndexEmbedPort = {
  embed: async () => ({ outcome: "lexical_only" }),
};

describe("runScheduledCloudPull (#170 cron)", () => {
  it("skips without leasing when the T-212 extractor is unwired", async () => {
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

describe("runScheduledIndexPull (T-113 index consumer)", () => {
  it("skips without leasing when the embed port is unwired", async () => {
    const log = vi.fn();
    const result = await runScheduledIndexPull(
      { JOB_DB: { connectionString: "postgres://x" }, TOI_WORKER_TOKEN: "tok" },
      { indexEmbed: null, log },
    );
    expect(result).toEqual({ skipped: "index_embed_unwired" });
    expect(log).toHaveBeenCalledWith({ kind: "scheduled_skip", reason: "index_embed_unwired" });
  });

  it("skips when JOB_DB is unbound", async () => {
    const result = await runScheduledIndexPull(
      { TOI_WORKER_TOKEN: "tok" },
      { indexEmbed: idleEmbed },
    );
    expect(result).toEqual({ skipped: "job_db_unbound" });
  });
});

describe("runScheduledTick (#99 outbox + #170 pull + T-113 index)", () => {
  it("dispatches outbox even when extract and index ports are unwired", async () => {
    const log = vi.fn();
    const result = await runScheduledTick(
      { JOB_DB: { connectionString: "postgres://x" }, TOI_WORKER_TOKEN: "tok" },
      {
        extractor: null,
        indexEmbed: null,
        log,
        dispatchOutbox: async () => ({ processed: 2, enqueued: 1, skipped: 1 }),
      },
    );
    expect(result.outbox).toEqual({ processed: 2, enqueued: 1, skipped: 1 });
    expect(result.pull).toEqual({ skipped: "extractor_unwired" });
    expect(result.indexPull).toEqual({ skipped: "index_embed_unwired" });
    expect(log).toHaveBeenCalledWith({
      kind: "outbox_dispatch",
      result: { processed: 2, enqueued: 1, skipped: 1 },
    });
  });

  it("skips outbox when JOB_DB is unbound and still reports pull skips", async () => {
    const result = await runScheduledTick(
      { TOI_WORKER_TOKEN: "tok" },
      { extractor: null, indexEmbed: null },
    );
    expect(result.outbox).toEqual({ skipped: "job_db_unbound" });
    expect(result.pull).toEqual({ skipped: "extractor_unwired" });
    expect(result.indexPull).toEqual({ skipped: "index_embed_unwired" });
  });

  it("skips outbox when the worker token is missing", async () => {
    const result = await runScheduledTick(
      { JOB_DB: { connectionString: "postgres://x" } },
      { extractor: null, indexEmbed: null },
    );
    expect(result.outbox).toEqual({ skipped: "worker_token_missing" });
  });
});
