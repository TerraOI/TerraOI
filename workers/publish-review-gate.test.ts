import { describe, expect, it } from "vitest";

import { createPublishJobApi, type JobSql } from "./job-db";
import { runPublishWorkerIteration, createPublishWorkerDeps, type PublishJobApiPort } from "./publish-pull";

/**
 * TOI-013: `job_api.publish_version_v1` now parks a version that has no T-213 review decision
 * (outcome `awaiting_review`). The adapter must read that as its own outcome and the loop must
 * finish quietly — never abort the job as "source_revoked", never report a publication.
 */

const TOKEN = "synthetic-worker-token-shape-only-0001";
const JOB = "95000000-0000-4000-8000-000000004912";
const VERSION = "71000000-0000-4000-8000-000000004901";
const SOURCE = "61000000-0000-4000-8000-000000004901";

function sqlReturning(rows: unknown[]): JobSql {
  const tag = (async () => rows) as unknown as JobSql;
  (tag as unknown as { end: () => Promise<void> }).end = async () => undefined;
  return tag;
}

describe("publish review gate (TOI-013)", () => {
  it("the adapter maps awaiting_review to its own outcome", async () => {
    const api = createPublishJobApi({
      openSql: () =>
        sqlReturning([
          {
            o_outcome: "awaiting_review",
            o_source_id: SOURCE,
            o_source_version_id: VERSION,
            o_previous_version_id: null,
            o_published_at: null,
            o_event_id: null,
          },
        ]),
    })!;
    await expect(
      api.publishVersion({ credential: TOKEN, jobId: JOB, leaseToken: "t", fence: 1, sourceVersionId: VERSION, indexGeneration: 1 }),
    ).resolves.toEqual({ outcome: "awaiting_review", sourceId: SOURCE, sourceVersionId: VERSION });
  });

  it("the loop records held_for_review and does not abort the job", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const jobApi: PublishJobApiPort = {
      async lease() {
        calls.push("lease");
        return {
          jobId: JOB,
          organisationId: "11111111-1111-4111-8111-111111111111",
          sourceVersionId: VERSION,
          stage: "publish",
          executor: "cloud_worker",
          parserGeneration: "v1",
          indexGeneration: 1,
          dataClass: "internal",
          leaseToken: "synthetic-publish-lease-01",
          fence: 1,
          attempt: 1,
        } as never;
      },
      async renew() {
        calls.push("renew");
        return { outcome: "renewed", expiresAt: new Date(Date.now() + 60_000).toISOString(), fence: 1 };
      },
      async abort() {
        calls.push("abort");
        return { outcome: "aborted" };
      },
      async publishVersion() {
        calls.push("publishVersion");
        return { outcome: "awaiting_review", sourceId: SOURCE, sourceVersionId: VERSION };
      },
    };
    const outcome = await runPublishWorkerIteration(
      createPublishWorkerDeps({ jobApi, credential: () => TOKEN, log: (e) => events.push(e.kind) }),
    );
    expect(outcome).toEqual({ action: "held_for_review", sourceVersionId: VERSION });
    expect(calls).not.toContain("abort");
    expect(events).toContain("held_for_review");
    expect(events).not.toContain("published");
  });
});
