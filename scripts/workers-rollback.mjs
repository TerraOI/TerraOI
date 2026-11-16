// T-404 — the Worker rollback helper (§17.2 step 5, "keep a known compatible artifact").
//
// What this is: a small module that lists the Worker versions for one environment and rolls back to a
// version that is on that list. What it is not: a deploy tool, and not something that runs against
// production from a development machine — plan §20.8 and AGENTS §6 keep production writes with the owner,
// and the packet limits execution here to `--env staging`.
//
// The design rule that follows from §17.2 is that a rollback **names** an artifact: "Rollback is an app
// artifact plus an index generation, never 'the last deploy'." So there is no `--to-previous`, no
// `latest`, and no rollback to a version id that the listing does not contain. A typo'd version id
// against a real account would otherwise be the command that "worked" and changed nothing.
//
// `exec` is injected (the CLI passes node:child_process), which is what makes the whole module testable
// without Cloudflare credentials — and what keeps a test from ever deploying anything.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const KNOWN_ENVIRONMENTS = ["staging", "production"];

// The runbook's proposed retention (T-404 "Assumed, decision owed": three versions and the last two
// published generations). It stays a default until the `workers/` deployment makes it a setting.
const DEFAULT_DEPTH = 3;

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RollbackError extends Error {
  constructor(rule, detail) {
    super(`${rule}: ${detail}`);
    this.name = "RollbackError";
    this.rule = rule;
    this.detail = detail;
  }
}

/** Environment names this repository's `wrangler.jsonc` knows. A typo must not answer "no versions". */
export function assertKnownEnvironment(env) {
  if (!KNOWN_ENVIRONMENTS.includes(env)) {
    throw new RollbackError("unknown environment", `"${env}" is not one of ${KNOWN_ENVIRONMENTS.join(", ")} — fix the name before reading the listing`);
  }
  return env;
}

/**
 * Production is the owner's (§20.8). The module can be told explicitly, because the same code path is
 * what the owner will use by hand; the default refuses so that an agent cannot reach it by omission.
 */
export function assertEnvironmentAllowed(env, { allowProduction = false } = {}) {
  assertKnownEnvironment(env);
  if (env === "production" && !allowProduction) {
    throw new RollbackError(
      "owner-only",
      "production rollback needs an explicit --allow-production and an owner: plan §20.8 keeps production writes off a development machine, and this packet rehearses on staging only",
    );
  }
  return env;
}

/** `latest`, `current`, a bare prefix and anything shell-shaped are all refused. */
export function assertVersionId(versionId) {
  if (typeof versionId !== "string" || !VERSION_ID.test(versionId)) {
    throw new RollbackError("version id", `"${versionId}" is not a UUID-shaped Worker version id — take it from the listing, never from memory`);
  }
  return versionId;
}

export function listVersions({ exec }, env) {
  assertKnownEnvironment(env);
  const raw = exec("wrangler", "deployments", "list", "--env", env, "--json");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (problem) {
    throw new RollbackError("unreadable listing", `wrangler printed something that is not JSON for --env ${env}: ${problem.message}`);
  }
  const versions = [];
  for (const deployment of parsed?.deployments ?? []) {
    for (const version of deployment?.versions ?? []) {
      if (!version?.version_id) continue;
      versions.push({
        versionId: version.version_id,
        createdOn: version.created_on ?? "",
        revision: version?.sources?.git?.revision ?? "",
        deploymentId: deployment?.deployment_id ?? "",
      });
    }
  }
  return versions.sort((a, b) => (a.createdOn < b.createdOn ? 1 : -1));
}

export function recentVersions(versions, limit = DEFAULT_DEPTH) {
  if (!Number.isInteger(limit) || limit < 1) throw new RollbackError("bad depth", `retention depth must be a positive integer, got ${limit}`);
  return versions.slice(0, limit);
}

export function rollbackCommand({ env, versionId }) {
  assertKnownEnvironment(env);
  assertVersionId(versionId);
  return ["wrangler", "deployments", "rollback", versionId, "--env", env];
}

/**
 * The one entry point the CLI and the runbook use. Dry-run by default: the rehearsal value is in seeing
 * the exact command, and an accidental deploy during a rehearsal is worse than no rehearsal.
 */
export function rollbackVersion({ exec }, { env, versionId, dryRun = true, allowProduction = false, depth = DEFAULT_DEPTH } = {}) {
  assertEnvironmentAllowed(env, { allowProduction });
  assertVersionId(versionId);

  const versions = listVersions({ exec }, env);
  const chosen = versions.find((v) => v.versionId === versionId);
  if (!chosen) {
    throw new RollbackError(
      "not among the listed versions",
      `${versionId} is not on the ${versions.length} version(s) wrangler listed for ${env}; the retained set is ${recentVersions(versions, depth).map((v) => v.versionId).join(", ") || "empty"}`,
    );
  }
  if (versions[0]?.versionId === versionId) {
    throw new RollbackError(
      "already serving",
      `${versionId} is the version ${env} serves now; rolling back to it changes nothing and would be read as a fix`,
    );
  }

  const command = rollbackCommand({ env, versionId });
  if (dryRun) return { dryRun: true, command, target: chosen, retained: recentVersions(versions, depth) };

  const output = exec(...command);
  return { dryRun: false, command, target: chosen, output, retained: recentVersions(versions, depth) };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
// Usage (the runbook quotes these exact lines):
//   node scripts/workers-rollback.mjs --env staging --list
//   node scripts/workers-rollback.mjs --env staging --to <version-id>                 # dry-run: prints the command
//   node scripts/workers-rollback.mjs --env staging --to <version-id> --execute       # the rehearsal step
// Exit codes: 0 ok · 1 refused (a rule above stopped it) · 2 usage
const USAGE =
  "usage: node scripts/workers-rollback.mjs --env staging --list | --to <version-id> [--execute] [--allow-production] [--depth N]";

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = flag("env");
  const target = flag("to");
  if (!env || (!target && !argv.includes("--list"))) {
    console.error(USAGE);
    process.exit(2);
  }

  const exec = (...args) => execFileSync(args[0], args.slice(1), { encoding: "utf8" });
  const depth = Number(flag("depth") ?? DEFAULT_DEPTH);
  try {
    if (!target) {
      const versions = listVersions({ exec }, env);
      for (const v of recentVersions(versions, depth)) {
        console.log(`${v.versionId}  ${v.createdOn}  ${v.revision}`);
      }
      console.log(`(${versions.length} version(s) listed for ${env}; ${DEFAULT_DEPTH} retained by the runbook's proposed depth)`);
      return;
    }
    const result = rollbackVersion({ exec }, {
      env,
      versionId: target,
      dryRun: !argv.includes("--execute"),
      allowProduction: argv.includes("--allow-production"),
      depth,
    });
    console.log(`${result.dryRun ? "dry-run, nothing executed:" : "executed:"} ${result.command.join(" ")}`);
    console.log(`target ${result.target.versionId} (${result.target.createdOn}${result.target.revision ? ` ${result.target.revision}` : ""})`);
    if (!result.dryRun) console.log(String(result.output ?? "").trim());
  } catch (problem) {
    if (problem instanceof RollbackError) {
      console.error(`refused — ${problem.message}`);
      process.exit(1);
    }
    console.error(`failed — ${problem.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
