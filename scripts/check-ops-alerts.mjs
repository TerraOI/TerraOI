#!/usr/bin/env node
/**
 * T-405's thin CLI over `ops-metrics.mjs` — the shape scripts/README.md asks for: the rules and
 * metrics live in the module, this file only decides what to print and which exit code to give.
 *
 * Exit codes are three different facts and are kept apart deliberately:
 *
 *   0  every rule produced a verdict (in a dry run: every rule fired; in evaluate mode: nothing
 *      errored — `not_available` and `threshold_unset` are honest absences, not failures)
 *   1  a proof failed: a dry-run rule could not be made to fire, or an evaluation errored
 *   2  the check could not run: bad argument, unreadable input file, an unknown rule id
 *
 * There is no scheduled alert job here and none is proposed for a builder to write: a workflow
 * that reads a production database needs a destination and a credential story the current plan
 * level does not have (§20.8, T-004's last checkbox, issue #180's scope limit). The dry run is
 * what a builder can honestly show: each rule fired against a synthetic condition, in the open.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ALERT_RULES, evaluateAlerts, ruleIds, runDryRuns } from "./ops-metrics.mjs";

export function parseArgs(argv) {
  const flags = new Set(["--dry-run", "--rules", "--facts", "--thresholds", "--rule"]);
  let mode = null;
  let factsFile = null;
  let thresholdsFile = null;
  const ids = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!flags.has(arg)) {
      return { error: `usage: check-ops-alerts --dry-run | --rules | --facts <file> [--thresholds <file>] [--rule <id>]; unknown argument ${arg}` };
    }
    if (arg === "--dry-run" || arg === "--rules") {
      if (mode) return { error: `usage: --${mode} and ${arg} cannot be combined` };
      mode = arg.slice(2);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      return { error: `usage: ${arg} needs a value` };
    }
    if (arg === "--facts") {
      if (factsFile) return { error: "usage: --facts given twice" };
      factsFile = value;
    } else if (arg === "--thresholds") {
      thresholdsFile = value;
    } else {
      ids.push(value);
    }
    i += 1;
  }

  if (!mode) {
    if (factsFile) mode = "evaluate";
    else return { error: "usage: check-ops-alerts --dry-run | --rules | --facts <file> [--thresholds <file>]" };
  }
  if (mode === "dry-run" && factsFile) {
    return { error: "usage: --dry-run and --facts cannot be combined (a dry run supplies its own conditions)" };
  }
  const known = ruleIds();
  for (const id of ids) {
    if (!known.includes(id)) return { error: `unknown rule id ${id}; the closed set is ${known.join(", ")}` };
  }

  const out = { mode, ruleIds: ids.length ? ids : null };
  if (factsFile) out.factsFile = factsFile;
  if (thresholdsFile) out.thresholdsFile = thresholdsFile;
  return out;
}

const label = (v) => `${v.ruleId} ${v.verdict} — ${v.detail}`;

export function evaluateMode({ mode, rules = ALERT_RULES, facts = {}, thresholds = {}, ruleIds: only = null } = {}) {
  const chosen = only ? rules.filter((r) => only.includes(r.id)) : rules;

  if (mode === "rules") {
    return {
      code: 0,
      lines: chosen.map((r) =>
        r.thresholdKind === "owner_set"
          ? `${r.id} (${r.className}) — ${r.definition} — threshold to set: ${r.thresholdKey}; destination: ${r.destination ?? "<owner-set>"}`
          : `${r.id} (${r.className}) — ${r.definition} — threshold: ${r.thresholdKind}`,
      ),
    };
  }

  if (mode === "dry-run") {
    const runs = runDryRuns({ rules: chosen });
    let code = 0;
    const lines = runs.map((run) => {
      if (run.verdict === "fired") return `${run.ruleId} fired — condition: ${run.condition} — ${run.detail}`;
      code = 1;
      return `${run.ruleId} ${run.verdict} — could not be made to fire (condition: ${run.condition}; ${run.detail})`;
    });
    return { code, lines };
  }

  const verdicts = evaluateAlerts({ rules: chosen, facts, thresholds });
  const code = verdicts.some((v) => v.verdict === "evaluation_error") ? 1 : 0;
  return { code, lines: verdicts.map(label) };
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { ok: false, message: `cannot read ${file}: ${err.message}` };
  }
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    return 2;
  }
  let facts = { tables: [], values: {} };
  let thresholds = {};
  if (parsed.mode === "evaluate") {
    const f = readJson(parsed.factsFile);
    if (!f.ok) {
      console.error(f.message);
      return 2;
    }
    facts = f.value;
    if (parsed.thresholdsFile) {
      const t = readJson(parsed.thresholdsFile);
      if (!t.ok) {
        console.error(t.message);
        return 2;
      }
      thresholds = t.value;
    }
  }
  const out = evaluateMode({ mode: parsed.mode, facts, thresholds, ruleIds: parsed.ruleIds });
  for (const line of out.lines) console.log(line);
  if (parsed.mode === "dry-run") {
    console.log(out.code === 0 ? `dry run: ${out.lines.length} rule(s) shown capable of firing` : "dry run refused: a rule could not be made to fire");
  }
  return out.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
