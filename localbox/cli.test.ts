import { describe, expect, it, vi } from "vitest";

import {
  CLI_ENV_MESSAGES,
  createCliEventLogger,
  parseCliArgs,
  resolveCliEnv,
  runLocalboxCli,
} from "./cli";
import { DEFAULT_POLL_INTERVAL_MS, type BoxWorkerDeps, type IterationOutcome } from "./ocr-pull";

function stubDeps(): BoxWorkerDeps {
  return {
    jobApi: {
      lease: vi.fn(),
      renew: vi.fn(),
      objectUrl: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    },
    credential: () => "synthetic-token",
    extractor: { extract: vi.fn() },
    readObjectBytes: vi.fn(),
    leaseSeconds: 900,
    maxObjectBytes: 1,
    log: () => undefined,
    now: () => 0,
  };
}

describe("localbox/cli.ts — arg parsing and fail-closed env (T-211 PR-3g)", () => {
  it("parseCliArgs defaults to a loop with the shared poll interval", () => {
    expect(parseCliArgs([])).toEqual({ once: false, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS });
  });

  it("parseCliArgs accepts --once and --poll-interval-ms", () => {
    expect(parseCliArgs(["--once"])).toEqual({
      once: true,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    });
    expect(parseCliArgs(["--poll-interval-ms", "5000"])).toEqual({
      once: false,
      pollIntervalMs: 5000,
    });
    expect(parseCliArgs(["--once", "--poll-interval-ms", "2500"])).toEqual({
      once: true,
      pollIntervalMs: 2500,
    });
  });

  it("parseCliArgs refuses unknown flags and bad interval values", () => {
    expect(() => parseCliArgs(["--daemon"])).toThrow(/unknown argument/);
    expect(() => parseCliArgs(["--poll-interval-ms"])).toThrow(/positive integer/);
    expect(() => parseCliArgs(["--poll-interval-ms", "0"])).toThrow(/positive integer/);
    expect(() => parseCliArgs(["--poll-interval-ms", "1.5"])).toThrow(/positive integer/);
    expect(() => parseCliArgs(["--poll-interval-ms", "nope"])).toThrow(/positive integer/);
  });

  it("resolveCliEnv fails closed when base URL or worker token is unbound", () => {
    expect(resolveCliEnv({})).toEqual({ ok: false, reason: "missing_base_url" });
    expect(resolveCliEnv({ TOI_JOB_API_BASE_URL: "   " })).toEqual({
      ok: false,
      reason: "missing_base_url",
    });
    expect(
      resolveCliEnv({
        TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app",
      }),
    ).toEqual({ ok: false, reason: "missing_worker_token" });
    expect(
      resolveCliEnv({
        TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app",
        TOI_WORKER_TOKEN: "   ",
      }),
    ).toEqual({ ok: false, reason: "missing_worker_token" });
  });

  it("resolveCliEnv returns trimmed values and never embeds secrets in the failure arm", () => {
    const secret = "synthetic-box-credential-never-log-me";
    const ok = resolveCliEnv({
      TOI_JOB_API_BASE_URL: "  https://company1-staging.terraoi.app/  ",
      TOI_WORKER_TOKEN: `  ${secret}  `,
    });
    expect(ok).toEqual({
      ok: true,
      env: {
        TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app/",
        TOI_WORKER_TOKEN: secret,
      },
    });

    const failure = resolveCliEnv({
      TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app",
      TOI_WORKER_TOKEN: "",
    });
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error("expected failure");
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(CLI_ENV_MESSAGES[failure.reason]).not.toContain(secret);
    expect(CLI_ENV_MESSAGES[failure.reason]).not.toMatch(/https?:\/\//);
  });

  it("createCliEventLogger writes JSON BoxEvent lines without free-text secrets", () => {
    const lines: string[] = [];
    const log = createCliEventLogger((line) => lines.push(line));
    log({ kind: "no_work" });
    log({ kind: "completed", jobId: "33333333-3333-4333-8333-333333333333", artifacts: 1 });
    expect(lines).toEqual([
      JSON.stringify({ kind: "no_work" }),
      JSON.stringify({
        kind: "completed",
        jobId: "33333333-3333-4333-8333-333333333333",
        artifacts: 1,
      }),
    ]);
    expect(lines.join("\n")).not.toMatch(/Bearer|TOI_WORKER_TOKEN|password/i);
  });

  it("runLocalboxCli exits 1 on unbound env before any network work", async () => {
    const runOnce = vi.fn(async (): Promise<IterationOutcome> => ({ action: "no_work" }));
    const buildDeps = vi.fn(() => stubDeps());
    const errors: string[] = [];

    const code = await runLocalboxCli({
      argv: ["--once"],
      env: { TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app" },
      buildDeps,
      runOnce,
      writeError: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors).toEqual([CLI_ENV_MESSAGES.missing_worker_token]);
    expect(buildDeps).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("runLocalboxCli exits 1 on bad argv without reading the network path", async () => {
    const runOnce = vi.fn(async (): Promise<IterationOutcome> => ({ action: "no_work" }));
    const buildDeps = vi.fn(() => stubDeps());
    const errors: string[] = [];

    const code = await runLocalboxCli({
      argv: ["--nope"],
      env: {
        TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app",
        TOI_WORKER_TOKEN: "synthetic-token",
      },
      buildDeps,
      runOnce,
      writeError: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors[0]).toMatch(/unknown argument/);
    expect(buildDeps).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("runLocalboxCli --once wires deps and returns the iteration exit code", async () => {
    const deps = stubDeps();
    const buildDeps = vi.fn(() => deps);
    const runOnce = vi.fn(async (): Promise<IterationOutcome> => ({ action: "no_work" }));
    const events: string[] = [];

    const code = await runLocalboxCli({
      argv: ["--once"],
      env: {
        TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app",
        TOI_WORKER_TOKEN: "synthetic-token",
      },
      buildDeps,
      runOnce,
      logEvent: createCliEventLogger((line) => events.push(line)),
    });

    expect(code).toBe(0);
    expect(buildDeps).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(deps);
    expect(events).toEqual([]);
  });

  it("runLocalboxCli default mode runs the loop and maps hard stops to exit 2", async () => {
    const deps = stubDeps();
    const buildDeps = vi.fn(() => deps);
    const runLoop = vi.fn(async (): Promise<IterationOutcome[]> => [
      { action: "no_work" },
      { action: "credential_refused" },
    ]);

    const code = await runLocalboxCli({
      argv: ["--poll-interval-ms", "100"],
      env: {
        TOI_JOB_API_BASE_URL: "https://company1-staging.terraoi.app",
        TOI_WORKER_TOKEN: "synthetic-token",
      },
      buildDeps,
      runLoop,
    });

    expect(code).toBe(2);
    expect(runLoop).toHaveBeenCalledWith(deps, { pollIntervalMs: 100 });
  });
});
