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
 * (a URL, which this file does contain) is not mistaken for a comment, and so trailing commas are
 * removed only outside strings.
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
    // Trailing comma before } or ]: JSONC allows it; JSON does not. Only strip outside strings.
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /[ \t\r\n]/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

/**
 * Bindings each environment must declare before a deploy of that environment is allowed.
 *
 * Staging: what is bound on the staging Worker today (Hyperdrive for SESSION_DB / INQUIRY_DB is still
 * an owner T-004 step, so requiring those names here would fail every staging deploy for a reason that
 * is not a mistake). Production: the T-404 checklist of Hyperdrive binding names the owner creates
 * before traffic — SESSION_DB and INQUIRY_DB are what code on main reads; CONFIG_DB and JOB_DB are the
 * server-path bindings the packet names for T-116 / T-211.
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

/** Resource-bearing keys wrangler does not inherit into named environments (default []). */
const RESOURCE_ARRAY_KEYS = [
  "hyperdrive",
  "ratelimits",
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "queues",
  "services",
  "vectorize",
  "workflows",
  "analytics_engine_datasets",
];

/** Angle-bracket placeholders the owner fills later — not real Cloudflare resource ids. */
function isPlaceholder(value) {
  return typeof value === "string" && /^<[^<>]+>$/.test(value.trim());
}

/**
 * Merge top-level + named env the way wrangler does for the fields this gate cares about:
 * named-env values win; resource arrays that are absent from the named env stay empty (they are
 * `@nonInheritable`), not the top-level list.
 */
export function mergeEnvironment(config, envName) {
  const envs = config?.env ?? {};
  const topLevelIsTarget = envName === "production" && !Object.hasOwn(envs, "production");
  if (topLevelIsTarget) {
    const { env: _env, ...top } = config;
    return top;
  }
  const block = envs[envName] ?? {};
  const merged = { ...config, ...block };
  delete merged.env;
  for (const key of RESOURCE_ARRAY_KEYS) {
    if (!Object.hasOwn(block, key)) {
      if (key === "queues") merged.queues = { producers: [], consumers: [] };
      else merged[key] = [];
    }
  }
  return merged;
}

function collectBindings(merged) {
  const names = new Set();
  if (merged.assets?.binding) names.add(merged.assets.binding);
  for (const key of ["hyperdrive", "services", "d1_databases", "kv_namespaces", "r2_buckets", "vectorize", "workflows", "queues"]) {
    const entries = key === "queues" ? [...(merged.queues?.producers ?? []), ...(merged.queues?.consumers ?? [])] : (merged[key] ?? []);
    for (const entry of entries) {
      const name = entry?.binding ?? entry?.script_name ?? entry?.queue;
      if (name) names.add(name);
    }
  }
  for (const entry of merged.ratelimits ?? []) if (entry?.name) names.add(entry.name);
  return names;
}

/**
 * Cloudflare resource ids that must stay isolated across environments (plan §17.2 step 2).
 * Returns `{ kind, id, binding }` rows; placeholders are still listed so callers can filter.
 */
export function collectResourceIds(source) {
  const found = [];
  const push = (kind, id, binding = "") => {
    if (id === undefined || id === null || id === "") return;
    found.push({ kind, id: String(id), binding: binding || "" });
  };
  for (const entry of source.hyperdrive ?? []) push("hyperdrive", entry?.id ?? entry?.database_id, entry?.binding);
  for (const entry of source.ratelimits ?? []) push("ratelimit", entry?.namespace_id, entry?.name);
  for (const entry of source.kv_namespaces ?? []) push("kv", entry?.id, entry?.binding);
  for (const entry of source.d1_databases ?? []) push("d1", entry?.database_id ?? entry?.id, entry?.binding);
  for (const entry of source.r2_buckets ?? []) push("r2", entry?.bucket_name ?? entry?.id, entry?.binding);
  for (const entry of source.queues?.producers ?? []) push("queue", entry?.queue, entry?.binding);
  for (const entry of source.queues?.consumers ?? []) push("queue", entry?.queue, entry?.binding);
  return found;
}

function topLevelResourceSource(config) {
  const { env: _env, ...top } = config ?? {};
  return top;
}

function stringValues(value, keyHint = "") {
  const found = [];
  if (typeof value === "string") found.push({ key: keyHint, value });
  else if (Array.isArray(value)) value.forEach((v, i) => found.push(...stringValues(v, keyHint || String(i))));
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

  const merged = mergeEnvironment(config, envName);
  const productionName = config.name;
  const routes = merged.routes ?? [];
  const envBlock = topLevelIsTarget ? {} : (envs[envName] ?? {});

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

  // Plan §17.2 step 2: resource ids must be isolated. Placeholders (`<LIKE_THIS>`) are exempt.
  const topSource = topLevelResourceSource(config);
  const topIds = collectResourceIds(topSource).filter((r) => !isPlaceholder(r.id));
  // Production's declared resource arrays when env.production exists; otherwise the top level is production.
  const productionResourceIds = (
    Object.hasOwn(envs, "production") ? collectResourceIds(envs.production) : topIds
  ).filter((r) => !isPlaceholder(r.id));
  const stagingResourceIds = (
    Object.hasOwn(envs, "staging") ? collectResourceIds(envs.staging) : []
  ).filter((r) => !isPlaceholder(r.id));

  if (envName === "staging") {
    for (const key of RESOURCE_ARRAY_KEYS) {
      if (Object.hasOwn(envBlock, key)) continue;
      const inherited = collectResourceIds({ [key]: topSource[key] }).filter((r) => !isPlaceholder(r.id));
      for (const row of inherited) {
        add(
          "staging-inherits-toplevel-resource-id",
          `${row.kind} ${row.binding || "(unnamed)"} id ${row.id} would come from the top level because env.staging omits ${key}`,
        );
      }
    }
    const forbidden = new Set([...topIds, ...productionResourceIds].map((r) => `${r.kind}:${r.id}`));
    for (const row of collectResourceIds(envBlock).filter((r) => !isPlaceholder(r.id))) {
      if (forbidden.has(`${row.kind}:${row.id}`)) {
        add(
          "staging-reuses-production-resource-id",
          `${row.kind} ${row.binding || "(unnamed)"} id ${row.id} is also a top-level/production resource id`,
        );
      }
    }
  }

  if (envName === "production") {
    const forbidden = new Set(stagingResourceIds.map((r) => `${r.kind}:${r.id}`));
    for (const row of collectResourceIds(merged).filter((r) => !isPlaceholder(r.id))) {
      if (forbidden.has(`${row.kind}:${row.id}`)) {
        add(
          "production-reuses-staging-resource-id",
          `${row.kind} ${row.binding || "(unnamed)"} id ${row.id} is also a staging resource id`,
        );
      }
    }
  }

  // Secret shapes over every string in the merged environment — including hyperdrive
  // localConnectionString — not only vars or credential-named keys (AGENTS §4.6).
  for (const { key, value } of stringValues(merged)) {
    for (const { re, why } of SECRET_SHAPES) {
      if (re.test(value)) add("secret-shaped-var", `${key || "a value"} holds ${why}`);
    }
  }
  for (const { key, value } of stringValues(merged)) {
    for (const { re, why } of PROJECT_REF_SHAPES) {
      if (re.test(value)) add("project-ref-in-config", `${key || "a value"} names ${why}`);
    }
  }

  return { ok: findings.length === 0, findings };
}
