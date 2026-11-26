#!/usr/bin/env node
/**
 * T-312 nightly eval entry (#74): run the full F35 harness against staging, or report
 * `unavailable` when staging keys are missing — never fail the schedule as a red X for an
 * unprovisioned environment (plan §14.1 step 4, packet Done evidence).
 *
 * Invoked by `.github/workflows/eval-nightly.yml` and `pnpm eval:nightly`. Not used on PRs.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

/** Staging secrets the deploy workflow already gates on; eval needs the same venue. */
export const STAGING_READY_FLAGS = [
  "HAS_CF_TOKEN",
  "HAS_CF_ACCOUNT",
  "HAS_SB_TOKEN",
  "HAS_SB_REF",
  "HAS_SB_PASSWORD",
];

/**
 * Pure gate: every flag must be the string `"true"`. Anything else (unset, empty, false) is missing.
 * @param {Record<string, string | undefined>} env
 * @returns {{ ready: boolean, missing: string[] }}
 */
export function assessStagingGate(env) {
  const missing = STAGING_READY_FLAGS.filter((flag) => env[flag] !== "true");
  return { ready: missing.length === 0, missing };
}

/**
 * When staging is not configured, return `unavailable` (exit 0 at the CLI). When it is, run the
 * injected eval command and surface its exit code.
 * @param {Record<string, string | undefined>} env
 * @param {() => { status: number }} [runEval]
 * @returns {{ status: "unavailable", reason: string, missing: string[] } | { status: "ran", exitCode: number }}
 */
export function runNightlyEval(env, runEval = defaultRunEval) {
  const gate = assessStagingGate(env);
  if (!gate.ready) {
    return {
      status: "unavailable",
      reason: "staging secrets are not set (T-004); nightly eval did not run",
      missing: gate.missing,
    };
  }
  const result = runEval();
  return { status: "ran", exitCode: result.status };
}

function defaultRunEval() {
  // The full Vitest eval suite is the M1 stand-in for a live staging asker until T-315/T-403 wire one.
  const child = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "src/platform/evals",
      "src/contracts/eval-case.test.ts",
      "evals",
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  return { status: child.status ?? 1 };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function main(env = process.env) {
  const outcome = runNightlyEval(env);
  if (outcome.status === "unavailable") {
    const missing = outcome.missing.join(", ");
    console.log(`unavailable: ${outcome.reason} (missing: ${missing})`);
    return 0;
  }
  return outcome.exitCode === 0 ? 0 : outcome.exitCode;
}

const entry = process.argv[1] ?? "";
const isDirectRun = entry.endsWith("eval-nightly.mjs");

if (isDirectRun) {
  process.exitCode = main();
}
