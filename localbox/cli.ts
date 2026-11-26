import { resolveBoxExtractor } from "./box-extractor";
import {
  DEFAULT_POLL_INTERVAL_MS,
  createBoxWorkerDeps,
  runBoxPullIteration,
  runBoxPullLoop,
  type BoxEvent,
  type BoxWorkerDeps,
  type IterationOutcome,
} from "./ocr-pull";

/**
 * CLI entry for the tenant-box OCR pull loop (T-211 PR-3g, plan §13 / F32).
 *
 * Reads `TOI_JOB_API_BASE_URL` and `TOI_WORKER_TOKEN` from the process environment, wires
 * `createBoxWorkerDeps` + `resolveBoxExtractor()`, and either runs one poll (`--once`) or the
 * default sleep loop. Secrets are never logged — only closed `BoxEvent` shapes reach stdout.
 *
 * Run from the repo root (OWNER machine; env outside git):
 *   pnpm exec tsx localbox/cli.ts
 *   pnpm exec tsx localbox/cli.ts --once
 */

export type CliArgs = {
  once: boolean;
  pollIntervalMs: number;
};

export type CliEnv = {
  TOI_JOB_API_BASE_URL: string;
  TOI_WORKER_TOKEN: string;
};

export type CliEnvFailure = "missing_base_url" | "missing_worker_token";

export type CliEnvResult = { ok: true; env: CliEnv } | { ok: false; reason: CliEnvFailure };

/** Closed, fixed messages — never echo env values or token material. */
export const CLI_ENV_MESSAGES: Record<CliEnvFailure, string> = {
  missing_base_url: "localbox cli: TOI_JOB_API_BASE_URL is unbound",
  missing_worker_token: "localbox cli: TOI_WORKER_TOKEN is unbound",
};

/**
 * Parse argv after the script name. Unknown flags fail closed (throw) so an OPERATOR typo
 * cannot silently become a long-running poll with wrong settings.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let once = false;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) break;
    if (flag === "--once") {
      once = true;
      continue;
    }
    if (flag === "--poll-interval-ms") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new Error("localbox cli: --poll-interval-ms requires a positive integer");
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("localbox cli: --poll-interval-ms requires a positive integer");
      }
      pollIntervalMs = parsed;
      i += 1;
      continue;
    }
    throw new Error(`localbox cli: unknown argument ${flag}`);
  }

  return { once, pollIntervalMs };
}

/**
 * Fail-closed env resolution. Empty / whitespace-only values count as unbound.
 * Does not touch the network and never returns secret material in the failure arm.
 */
export function resolveCliEnv(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): CliEnvResult {
  const baseRaw = env["TOI_JOB_API_BASE_URL"];
  const tokenRaw = env["TOI_WORKER_TOKEN"];
  const base = typeof baseRaw === "string" ? baseRaw.trim() : "";
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  if (base.length === 0) return { ok: false, reason: "missing_base_url" };
  if (token.length === 0) return { ok: false, reason: "missing_worker_token" };
  return {
    ok: true,
    env: { TOI_JOB_API_BASE_URL: base, TOI_WORKER_TOKEN: token },
  };
}

/** Structured event sink: JSON lines of closed BoxEvent shapes only (no free text). */
export function createCliEventLogger(
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): (event: BoxEvent) => void {
  return (event) => {
    write(JSON.stringify(event));
  };
}

export type RunLocalboxCliOptions = {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  /** Injectable deps builder; production uses createBoxWorkerDeps + resolveBoxExtractor. */
  buildDeps?: (env: CliEnv, log: (event: BoxEvent) => void) => BoxWorkerDeps;
  runOnce?: (deps: BoxWorkerDeps) => Promise<IterationOutcome>;
  runLoop?: (
    deps: BoxWorkerDeps,
    options: { pollIntervalMs: number },
  ) => Promise<IterationOutcome[]>;
  logEvent?: (event: BoxEvent) => void;
  writeError?: (message: string) => void;
};

/**
 * Programmatic entry used by tests and by the process main. Returns a process exit code:
 * 0 on a completed once/loop without hard config failure; 1 on unbound env or bad argv;
 * 2 when the pull loop stops on a hard refusal (credential / configuration / lease lost).
 */
export async function runLocalboxCli(options: RunLocalboxCliOptions = {}): Promise<number> {
  const writeError =
    options.writeError ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });

  let args: CliArgs;
  try {
    args = parseCliArgs(options.argv ?? process.argv.slice(2));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "localbox cli: invalid arguments";
    writeError(message);
    return 1;
  }

  const resolved = resolveCliEnv(options.env ?? process.env);
  if (!resolved.ok) {
    writeError(CLI_ENV_MESSAGES[resolved.reason]);
    return 1;
  }

  const log = options.logEvent ?? createCliEventLogger();
  const buildDeps =
    options.buildDeps ??
    ((env: CliEnv, eventLog: (event: BoxEvent) => void) =>
      createBoxWorkerDeps({
        env,
        extractor: resolveBoxExtractor(),
        log: eventLog,
      }));

  const deps = buildDeps(resolved.env, log);

  if (args.once) {
    const runOnce = options.runOnce ?? runBoxPullIteration;
    const outcome = await runOnce(deps);
    return exitCodeForOutcome(outcome);
  }

  const runLoop =
    options.runLoop ??
    ((workerDeps, loopOpts) =>
      runBoxPullLoop(workerDeps, { pollIntervalMs: loopOpts.pollIntervalMs }));
  const outcomes = await runLoop(deps, { pollIntervalMs: args.pollIntervalMs });
  const last = outcomes[outcomes.length - 1];
  if (last === undefined) return 0;
  return exitCodeForOutcome(last);
}

function exitCodeForOutcome(outcome: IterationOutcome): number {
  switch (outcome.action) {
    case "configuration_missing":
    case "credential_missing":
    case "credential_refused":
    case "lease_lost":
      return 2;
    case "no_work":
    case "lease_row_rejected":
    case "object_unavailable":
    case "completed":
    case "already_completed":
    case "aborted":
    case "refused":
    case "job_api_unavailable":
    case "job_api_malformed":
      return 0;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function isDirectCliInvocation(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  const normalized = entry.replace(/\\/g, "/");
  return normalized.endsWith("/localbox/cli.ts") || normalized.endsWith("/localbox/cli.js");
}

if (isDirectCliInvocation()) {
  void runLocalboxCli().then((code) => {
    process.exitCode = code;
  });
}
