// T-404 — the §17.2 step-2 release preflight: the rules module.
//
// Plan §17.2 step 2 asks for an isolated set of staging resources and says the preflight must reject
// production resource ids in staging. [T-404](../docs/tasks/T-404-production-readiness.md) states the
// contract this file implements, in its Contract section: "Preflight is a gate, not a notice: a mismatch
// fails the job and no deploy step runs." The reverse direction (a staging id in a production config) is
// in the same sentence, and it is the direction that turns a mis-set route into a tenant reading the
// wrong database, so it is checked here too rather than left to the release engineer.
//
// What this module does NOT do: reach the network, read a secret, or talk to Cloudflare. It takes a
// parsed `wrangler.jsonc` and a target environment name and reports findings, so the rule set is
// testable without an account (and without a `wrangler` login, which AGENTS §6 / plan §20.8 keep away
// from a development machine for production anyway).
//
// No real resource ids appear in this file. Hosts are named only through the staging marker test below.

/**
 * `wrangler.jsonc` is JSON with comments and, in principle, trailing content the JSON parser rejects.
 * Stripping is done character-by-character rather than with a regex so that a `//` inside a string
 * (a URL, which this file does contain) is not mistaken for a comment.
 */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      else continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += c;
  }
  // Trailing commas, which JSONC allows and a hand-edited config acquires.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Bindings the deployed code is known to read, per environment.
 *
 * Staging's list is short on purpose: the Hyperdrive bindings are added by the owner as T-004 human
 * steps, and a preflight that demanded a binding the owner has not created yet would fail every deploy
 * for a reason that is not a mistake. Production's list is what the packet's `env.production` block
 * declares, and it is the list that must be complete *before traffic* (§17.2 step 4).
 */
const REQUIRED = {
  staging: ["ASSETS", "WORKER_SELF_REFERENCE", "INQUIRY_RATE_LIMITER"],
  production: [
    "ASSETS",
    "WORKER_SELF_REFERENCE",
    "INQUIRY_RATE_LIMITER",
    "SESSION_DB",
    "CONFIG_DB",
    "JOB_DB",
    "INQUIRY_DB",
  ],
};

export function requiredBindings(envName) {
  return REQUIRED[envName] ?? [];
}

/** A host is staging-marked when one of its labels is `staging` or ends in `-staging`. */
function isStagingHost(pattern) {
  const host = pattern.split("/")[0] ?? "";
  return host.split(".").some((label) => label === "staging" || label.endsWith("-staging"));
}

function isStagingName(name) {
  return /(^|-)staging$/.test(String(name ?? ""));
}

// Shapes a value must never have in this file (AGENTS §4.6: no secret, no connection string, not in a
// config, not in a runbook, not in a log). Each shape is matched, not the exact value.
const SECRET_SHAPES = [
  { re: /^postgres(ql)?:\/\//, why: "a connection string" },
  { re: /^eyJ[A-Za-z0-9_-]*\./, why: "a JWT-shaped token" },
  { re: /BEGIN [A-Z ]*PRIVATE KEY/, why: "a private key" },
  { re: /aws_secret_access_key\s*=/, why: "an AWS secret assignment" },
];

// A Supabase project ref is 20 lowercase letters; a `*.supabase.co` URL also names one. Neither belongs
// in a repository file: the reference lives in the Hyperdrive config the owner creates (T-004).
const PROJECT_REF_SHAPES = [
  { re: /\b[a-z]{20}\.supabase\.(co|in)\b/, why: "a Supabase project URL" },
  { re: /\b(?:project_ref|projectRef)\b\s*[:=]/, why: "an inline project reference" },
];

function collectBindings(merged) {
  const names = new Set();
  if (merged.assets?.binding) names.add(merged.assets.binding);
  for (const key of ["hyperdrive", "services", "d1_databases", "kv_namespaces", "r2_buckets", "vectorize", "workflows", "artifacts"]) {
    for (const entry of merged[key] ?? []) {
      const name = entry?.binding ?? entry?.script_name;
      if (name) names.add(name);
    }
  }
  for (const entry of merged.ratelimits ?? []) if (entry?.name) names.add(entry.name);
  for (const entry of merged.queues?.consumers ?? []) if (entry?.queue) names.add(entry.queue);
  return names;
}

function stringValues(value, keyHint = "") {
  const found = [];
  if (typeof value === "string") found.push({ key: keyHint, value });
  else if (Array.isArray(value)) value.forEach((v) => found.push(...stringValues(v, keyHint)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) found.push(...stringValues(v, k));
  }
  return found;
}

/**
 * The gate. `config` is a parsed `wrangler.jsonc`; `envName` is the environment about to be deployed.
 * Returns `{ ok, findings }`, each finding `{ rule, env, detail }` so a CI log can point at the rule
 * rather than at a stack trace.
 */
export function checkReleaseConfig(config, envName) {
  const findings = [];
  const add = (rule, detail) => findings.push({ rule, env: envName, detail });

  const envs = config?.env ?? {};
  // In this repository's config the top level *is* the production deployment and `env.staging` is the
  // override (see wrangler.jsonc: `"name": "terraoi-web"` at the top, `"terraoi-web-staging"` under
  // env.staging). So "production" is a valid target with no `env.production` block — and it is then
  // the *least* specified one, which is exactly what the packet's `env.production` work fixes.
  const topLevelIsTarget = envName === "production" && !Object.hasOwn(envs, "production");
  if (!Object.hasOwn(envs, envName) && !topLevelIsTarget) {
    // Passing silently because there is nothing to check is the zero-step-passes failure COORDINATION
    // #100 rules out; a typo in the environment name must fail the job.
    add("unknown-environment", `no environment "${envName}" in the wrangler config (known: ${Object.keys(envs).join(", ") || "none"})`);
    return { ok: false, findings };
  }

  if (topLevelIsTarget) {
    add("production-has-no-env-block", "production is inheriting the top-level config; T-404 gives it an explicit env.production block so a staging value can never leak into it");
  }

  // An env block overrides the top-level config; arrays replace rather than merge, which is what
  // wrangler does, so the merged view here mirrors the deployed one.
  const merged = topLevelIsTarget ? { ...config } : { ...config, ...envs[envName] };
  const productionName = config.name;
  const routes = merged.routes ?? [];

  if (routes.length === 0) {
    // No routes means the Worker answers only on workers.dev/preview URLs, which plan §4.1 forbids as
    // a tenant entry point — and a deploy that changes nothing looks like a success without this rule.
    add("no-routes-declared", `${envName} declares 0 routes, so nothing new would be reachable`);
  }

  for (const route of routes) {
    const pattern = route?.pattern ?? "";
    if (envName === "staging" && !isStagingHost(pattern)) add("staging-route-is-production", pattern);
    if (envName === "production" && isStagingHost(pattern)) add("production-route-is-staging", pattern);
  }

  if (envName === "staging") {
    if (merged.name === productionName) add("staging-uses-production-worker-name", `${productionName} is the production Worker name`);
    if (isStagingName(productionName)) add("production-worker-name-is-staging-shaped", `${productionName} looks like a staging Worker`);
  }
  if (envName === "production" && isStagingName(merged.name)) {
    add("production-uses-staging-worker-name", `${merged.name} is a staging Worker name`);
  }

  // Service bindings are the quiet cross-environment path: an inherited top-level `services` entry
  // aims a staging Worker at the production Worker, and it looks like a successful deploy.
  for (const entry of merged.services ?? []) {
    const target = entry?.service;
    if (!target) continue;
    if (envName === "staging" && target === productionName) {
      add("staging-service-points-at-production-worker", `${entry.binding} → ${target}`);
    }
    if (envName === "production" && isStagingName(target)) {
      add("production-service-points-at-staging-worker", `${entry.binding} → ${target}`);
    }
  }

  for (const binding of REQUIRED[envName] ?? []) {
    if (!collectBindings(merged).has(binding)) add("missing-binding", binding);
  }

  // Only `vars` and anything whose key says it holds a credential are scanned: Hyperdrive blocks
  // legitimately carry placeholder names for the secrets the owner sets.
  const scanned = [...stringValues(merged.vars ?? {}, "var")];
  for (const [key, value] of Object.entries(merged)) {
    if (/token|secret|key|password/i.test(key)) scanned.push(...stringValues(value, key));
  }
  for (const { key, value } of scanned) {
    for (const { re, why } of SECRET_SHAPES) {
      if (re.test(value)) add("secret-shaped-var", `${key || "a var"} holds ${why}`);
    }
  }
  for (const { key, value } of stringValues({ routes, hyperdrive: merged.hyperdrive, vars: merged.vars, services: merged.services }, "")) {
    for (const { re, why } of PROJECT_REF_SHAPES) {
      if (re.test(value)) add("project-ref-in-config", `${key || "a value"} names ${why}`);
    }
  }

  return { ok: findings.length === 0, findings };
}
