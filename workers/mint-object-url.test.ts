import { describe, expect, it, vi } from "vitest";

import { mintObjectUrl, SIGNED_URL_TTL_SECONDS } from "./mint-object-url";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HASH = "a".repeat(64);
const OBJECT_REF = "knowledge/11111111-1111-4111-8111-111111111111/src/v1.pdf";
const SIGNED = "https://proj.supabase.co/storage/v1/object/sign/knowledge/x?token=t";

describe("mintObjectUrl (#170)", () => {
  it("refuses malformed args without looking up or signing", async () => {
    const lookup = vi.fn();
    const signer = vi.fn();
    const result = await mintObjectUrl(
      { tokenHash: "short", jobId: JOB, leaseToken: "t", fence: 1 },
      {},
      { lookup, signer },
    );
    expect(result).toEqual({ ok: false });
    expect(lookup).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });

  it("signs when the lease compare returns an object_ref", async () => {
    const result = await mintObjectUrl(
      { tokenHash: HASH, jobId: JOB, leaseToken: "lease", fence: 2 },
      { JOB_DB: { connectionString: "postgres://unused" } },
      {
        lookup: async () => ({
          found: true,
          objectRef: OBJECT_REF,
          dataClass: "internal",
          executor: "local_box",
        }),
        signer: async (objectRef) => {
          expect(objectRef).toBe(OBJECT_REF);
          return { status: "ok", url: SIGNED };
        },
      },
    );
    expect(result).toEqual({ ok: true, url: SIGNED });
    expect(SIGNED_URL_TTL_SECONDS).toBe(60);
  });

  it("returns ok:false when the lease compare finds nothing", async () => {
    const signer = vi.fn();
    const result = await mintObjectUrl(
      { tokenHash: HASH, jobId: JOB, leaseToken: "lease", fence: 2 },
      { JOB_DB: { connectionString: "postgres://unused" } },
      { lookup: async () => ({ found: false }), signer },
    );
    expect(result).toEqual({ ok: false });
    expect(signer).not.toHaveBeenCalled();
  });

  it("returns ok:false when signing is unavailable", async () => {
    const result = await mintObjectUrl(
      { tokenHash: HASH, jobId: JOB, leaseToken: "lease", fence: 2 },
      { JOB_DB: { connectionString: "postgres://unused" } },
      {
        lookup: async () => ({
          found: true,
          objectRef: OBJECT_REF,
          dataClass: "internal",
          executor: "local_box",
        }),
        signer: async () => ({ status: "unavailable", reason: "not_configured" }),
      },
    );
    expect(result).toEqual({ ok: false });
  });
});
