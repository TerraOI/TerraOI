import { describe, expect, it, vi } from "vitest";

import { runScheduledCloudPull } from "./scheduled";
import type { ExtractorPort } from "./ocr-pull";

const idleExtractor: ExtractorPort = {
  extract: async () => ({ outcome: "unsupported", reason: "unsupported_document" }),
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
