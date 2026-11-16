#!/usr/bin/env node
// CI / release-job entry point for the §17.2 step-2 preflight (T-404).
// Usage: node scripts/check-release-preflight.mjs --env staging
//        node scripts/check-release-preflight.mjs --env production --config wrangler.jsonc
//
// The rules live in release-preflight.mjs and are tested there; this file only reads the config,
// picks the environment and sets the exit code. It is the "thin CLI" shape scripts/README.md asks for,
// and it is what a release workflow would run *before* any deploy step, which is where the packet's
// negative acceptance test expects it to stop the job.
//
// Exit codes: 0 passed · 1 the gate refused (a real finding) · 2 the check itself could not be run
// (missing argument, unreadable or unparseable config). Distinguishing 1 from 2 matters: "the check
// refused this deploy" and "the check never ran" are different facts for whoever reads the log.
import { readFileSync } from "node:fs";
import { checkReleaseConfig, parseJsonc } from "./release-preflight.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const env = flag("env") ?? process.env.DEPLOY_ENV;
if (!env) {
  console.error('usage: node scripts/check-release-preflight.mjs --env <environment> [--config wrangler.jsonc]');
  process.exit(2);
}

const path = flag("config") ?? "wrangler.jsonc";
let config;
try {
  config = parseJsonc(readFileSync(path, "utf8"));
} catch (problem) {
  console.error(`Release preflight could not run: cannot parse ${path}: ${problem.message}`);
  process.exit(2);
}

const result = checkReleaseConfig(config, env);
if (result.ok) {
  console.log(`Release preflight passed for "${env}".`);
} else if (result.findings.every((f) => f.rule === "unknown-environment")) {
  // Nothing in the config matches the requested environment: that is a mis-set job, not a leak, and the
  // log should not read as if a staging value had been found in production.
  console.error(
    `Release preflight could not run: ${result.findings[0].detail}. ` +
      "Pass --env with one of the environments the config declares.",
  );
  process.exit(2);
} else {
  console.error(
    `Release preflight refused "${env}" (${result.findings.length} finding(s)); no deploy step runs:\n` +
      result.findings.map((f) => `- ${f.rule}: ${f.detail}`).join("\n"),
  );
  process.exit(1);
}
