import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  asPullLoopExtractor,
  createCommandBoxExtractor,
  createFixedBoxExtractor,
  createUnavailableBoxExtractor,
  resolveBoxExtractor,
  type BoxExtractorPort,
  type CommandRunner,
} from "./box-extractor";
import type { ArtifactInput } from "./ocr-pull";

const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const ONE_ARTIFACT: ArtifactInput[] = [
  {
    artifactIndex: 0,
    bodyText: "synthetic OCR text with page locator",
    locator: { page: 1 },
    confidence: 0.84,
  },
];

describe("localbox/box-extractor.ts — BoxExtractorPort (T-211 PR-3f)", () => {
  it("embeds no secrets, no service-role, and does not write document bytes to disk", () => {
    const source = readFileSync(new URL("./box-extractor.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/SERVICE_ROLE|service_role|SUPABASE_SERVICE/);
    expect(source).not.toMatch(/createSignedUrl|object\/sign/);
    expect(source).not.toMatch(/writeFile|appendFile|mkdir|createWriteStream|mkdtemp|tmpdir/);
    // Credentials and OCR command values are never stringified into logs.
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("createUnavailableBoxExtractor always aborts with a closed reason", async () => {
    const port = createUnavailableBoxExtractor();
    const result = await port.extract({
      bytes: new TextEncoder().encode("synthetic scanned page"),
      mediaType: "application/pdf",
      sourceVersionId: VERSION_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected abort");
    expect(["unsupported_document", "quality_failed"]).toContain(result.abortReason);
  });

  it("createFixedBoxExtractor is a deterministic test double", async () => {
    const okPort = createFixedBoxExtractor({ ok: true, artifacts: ONE_ARTIFACT });
    await expect(
      okPort.extract({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        sourceVersionId: VERSION_ID,
      }),
    ).resolves.toEqual({ ok: true, artifacts: ONE_ARTIFACT });

    const failPort = createFixedBoxExtractor({
      ok: false,
      abortReason: "quality_failed",
      notes: ["engine_refused"],
    });
    await expect(
      failPort.extract({
        bytes: new Uint8Array([1]),
        mediaType: "image/jpeg",
        sourceVersionId: VERSION_ID,
      }),
    ).resolves.toEqual({
      ok: false,
      abortReason: "quality_failed",
      notes: ["engine_refused"],
    });
  });

  it("createCommandBoxExtractor is unavailable when OCR_COMMAND is unbound", async () => {
    const port = createCommandBoxExtractor({
      commandFromEnv: () => undefined,
    });
    const result = await port.extract({
      bytes: new TextEncoder().encode("%PDF-1.4"),
      mediaType: "application/pdf",
      sourceVersionId: VERSION_ID,
    });
    expect(result).toEqual({
      ok: false,
      abortReason: "unsupported_document",
      notes: ["ocr_command_unbound"],
    });
  });

  it("createCommandBoxExtractor refuses an empty command string", async () => {
    const run = vi.fn<CommandRunner>();
    const port = createCommandBoxExtractor({
      commandFromEnv: () => "   ",
      run,
    });
    const result = await port.extract({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      mediaType: "image/jpeg",
      sourceVersionId: VERSION_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected abort");
    expect(result.abortReason).toBe("unsupported_document");
    expect(run).not.toHaveBeenCalled();
  });

  it("createCommandBoxExtractor invokes the runner with stdin bytes when bound", async () => {
    const bytes = new TextEncoder().encode("synthetic image bytes");
    const run = vi.fn<CommandRunner>(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        artifacts: ONE_ARTIFACT,
      }),
      stderr: "",
    }));
    const port = createCommandBoxExtractor({
      commandFromEnv: () => "ocr-engine --json",
      run,
      timeoutMs: 5_000,
    });
    const result = await port.extract({
      bytes,
      mediaType: "image/png",
      sourceVersionId: VERSION_ID,
    });
    expect(result).toEqual({ ok: true, artifacts: ONE_ARTIFACT });
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0]![0];
    expect(call.command).toBe("ocr-engine --json");
    expect(call.stdin).toEqual(bytes);
    expect(call.timeoutMs).toBe(5_000);
    // Runner request is command/stdin/timeout only — never a credential env bag.
    expect(Object.keys(call).sort()).toEqual(["command", "stdin", "timeoutMs"]);
  });

  it("createCommandBoxExtractor aborts quality_failed when the command exits non-zero", async () => {
    const port = createCommandBoxExtractor({
      commandFromEnv: () => "ocr-engine",
      run: async () => ({ exitCode: 2, stdout: "", stderr: "engine boom detail must not leak" }),
    });
    const result = await port.extract({
      bytes: new Uint8Array([1]),
      mediaType: "image/png",
      sourceVersionId: VERSION_ID,
    });
    expect(result).toEqual({
      ok: false,
      abortReason: "quality_failed",
      notes: ["ocr_command_failed"],
    });
    expect(JSON.stringify(result)).not.toContain("boom");
  });

  it("createCommandBoxExtractor aborts quality_failed on malformed engine JSON", async () => {
    const port = createCommandBoxExtractor({
      commandFromEnv: () => "ocr-engine",
      run: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
    });
    const result = await port.extract({
      bytes: new Uint8Array([1]),
      mediaType: "image/png",
      sourceVersionId: VERSION_ID,
    });
    expect(result).toEqual({
      ok: false,
      abortReason: "quality_failed",
      notes: ["ocr_output_malformed"],
    });
  });

  it("createCommandBoxExtractor aborts quality_failed when the runner times out or throws", async () => {
    const port = createCommandBoxExtractor({
      commandFromEnv: () => "ocr-engine",
      run: async () => {
        throw new Error("spawn ETIMEDOUT must not leak into notes");
      },
    });
    const result = await port.extract({
      bytes: new Uint8Array([1]),
      mediaType: "image/png",
      sourceVersionId: VERSION_ID,
    });
    expect(result).toEqual({
      ok: false,
      abortReason: "quality_failed",
      notes: ["ocr_command_unavailable"],
    });
    expect(JSON.stringify(result)).not.toContain("ETIMEDOUT");
  });

  it("asPullLoopExtractor maps engine success and abort into the pull-loop shape", async () => {
    const engine: BoxExtractorPort = createFixedBoxExtractor({ ok: true, artifacts: ONE_ARTIFACT });
    const loop = asPullLoopExtractor(engine);
    const extracted = await loop.extract({
      payload: {
        jobId: "33333333-3333-4333-8333-333333333333",
        organisationId: "11111111-1111-4111-8111-111111111111",
        sourceVersionId: VERSION_ID,
        stage: "extract",
        executor: "local_box",
        dataClass: "client_confidential",
        parserGeneration: "v1",
        indexGeneration: 1,
        attempt: 1,
        leaseToken: "synthetic-lease-token-01",
        issuedAt: "2026-11-24T00:00:00.000Z",
      },
      url: "http://127.0.0.1/bytes/x",
      bytes: new TextEncoder().encode("%PDF-1.4 synthetic"),
    });
    expect(extracted).toEqual({ outcome: "extracted", artifacts: ONE_ARTIFACT });

    const aborting = asPullLoopExtractor(
      createFixedBoxExtractor({ ok: false, abortReason: "unsupported_document" }),
    );
    const unsupported = await aborting.extract({
      payload: {
        jobId: "33333333-3333-4333-8333-333333333333",
        organisationId: "11111111-1111-4111-8111-111111111111",
        sourceVersionId: VERSION_ID,
        stage: "extract",
        executor: "local_box",
        dataClass: "client_confidential",
        parserGeneration: "v1",
        indexGeneration: 1,
        attempt: 1,
        leaseToken: "synthetic-lease-token-01",
        issuedAt: "2026-11-24T00:00:00.000Z",
      },
      url: "http://127.0.0.1/bytes/x",
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(unsupported).toEqual({ outcome: "unsupported", reason: "unsupported_document" });
  });

  it("resolveBoxExtractor returns unavailable when OCR_COMMAND is unset", async () => {
    const loop = resolveBoxExtractor({ commandFromEnv: () => undefined });
    const result = await loop.extract({
      payload: {
        jobId: "33333333-3333-4333-8333-333333333333",
        organisationId: "11111111-1111-4111-8111-111111111111",
        sourceVersionId: VERSION_ID,
        stage: "extract",
        executor: "local_box",
        dataClass: "internal",
        parserGeneration: "v1",
        indexGeneration: 1,
        attempt: 1,
        leaseToken: "synthetic-lease-token-01",
        issuedAt: "2026-11-24T00:00:00.000Z",
      },
      url: "http://127.0.0.1/bytes/x",
      bytes: new TextEncoder().encode("scan"),
    });
    expect(result).toEqual({
      outcome: "unsupported",
      reason: "unsupported_document",
      notes: ["ocr_command_unbound"],
    });
  });
});
