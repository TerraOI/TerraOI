#!/usr/bin/env node
// T-304 — F05 tenant provisioning, by script and not by an admin UI (plan §15.0: "Tenant provisioning
// by script (F05), not an admin UI"). It is the operator's entry point to exactly one database
// function, `toi_control.provision_tenant_v1`, added by
// supabase/migrations/*_lifecycle_switches.sql, and it is a *thin* one: it validates what it was
// given, dials one call, and then **uses the read-back the function returns** rather than selecting
// public tenancy tables (the control-plane login holds no table privilege — Round 1 B2).
//
// Three properties this file exists to keep, each pinned in provision-tenant.test.mjs:
//
// 1. **The rules here are the rules in the migration, not a paraphrase of them.** `RULES` and
//    `RESERVED_SLUGS` are compared character-for-character against the SQL off disk (tests 8-9), so
//    the client-side copy cannot wander. The database still decides — this only means an operator
//    gets a named argument error in the first second instead of a 22023 from the server, and that a
//    reviewer who changes one list watches the other go red.
// 2. **No credential passes through a string this file writes.** The DSN arrives in
//    `CONTROL_PLANE_DB` and is handed to the driver and nowhere else: not to a log line, not into an
//    error message, not into the SQL (tests 22, 30, 33). AGENTS §4.6.
// 3. **A provisioning run reports what the database ended up with.** The RPC returns status, host,
//    role count, permission count and membership count; a membership row appearing, a status that is
//    not `provisioning`, or no row at all is a failure (tests 24-27). F05's load-bearing absence is
//    the membership row: holding the credential that ran this must grant no operational access.
//
// What the script does **not** do, deliberately:
//   * It never sends an actor. The database derives the actor from the login
//     (`session_user` inside the SECURITY DEFINER body), and there is no `p_actor` argument to forge —
//     suite test 58 pins that on the SQL side and test 30 on this one.
//   * It does not create the login, its password, or the Hyperdrive/DSN that carries them. Those are
//     §20.8 human steps, the same split the supervisor accepted for the session Worker in #75. A run
//     with no binding says so and dials nothing.
//   * It does not suspend, resume or flip a switch. Those are separate control-plane calls with
//     separate reasons, and one CLI that can do all of them is how an operator stops a production
//     tenant while meaning to create a staging one.
import { pathToFileURL } from "node:url";
import postgres from "postgres";

// ---------------------------------------------------------------- the rules, mirrored from the SQL
// Keep these in step with the migration; tests 8 and 9 are what enforce it.
export const RULES = {
  slug: /^[a-z0-9][a-z0-9-]{1,62}$/,
  host: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9]))+$/,
  locale: /^[a-z]{2}(-[A-Z][a-z]{2})?$/,
  timezone: /^[A-Za-z]{1,32}(\/[A-Za-z0-9_+.-]{1,32})?$/,
};

export const RESERVED_SLUGS = ["admin", "platform", "staging", "www", "terraoi"];

// The dot ceiling is a second half of the host rule the regex cannot express, and it is pinned against
// the SQL's own `> 2` by test 14b, because a limit that only lives in a comment is a limit that drifts.
export const HOST_MAX_DOTS = 2;

const LIMITS = { displayName: 200, reason: 500, requestedBy: 200 };

const USAGE = [
  "usage: node scripts/provision-tenant.mjs \\",
  "     --slug <tenant-slug>       lowercase, 2-63, dashes not at either end",
  "     --host <exact-host>        one host, no scheme, at most one subdomain level below the zone",
  "     --name <display-name>      up to 200 characters",
  "     --locale <locale>          default en; the merged CHECK rejects en-GB today (#67)",
  "     --timezone <IANA-name>     default UTC; the merged CHECK allows exactly one slash (#67)",
  "     --reason <text>            required: why this tenant is being created",
  "     --requested-by <text>      required: who asked, recorded as named and not verified",
  "",
  "reads CONTROL_PLANE_DB (a DSN for a login that is IN ROLE toi_control_plane); never prints it.",
  "it provisions only. Stopping a tenant is suspend_tenant_v1, and it is not this script.",
].join("\n");

// ---------------------------------------------------------------- argv
const FLAGS = {
  "--slug": "slug",
  "--host": "host",
  "--name": "displayName",
  "--locale": "locale",
  "--timezone": "timezone",
  "--reason": "reason",
  "--requested-by": "requestedBy",
};

/**
 * Structure only: which flags were given, exactly once, with a value. Semantics are
 * `validateRequest`'s job, so a caller can validate a request it built some other way.
 */
export function parseArgs(argv) {
  const errors = [];
  const request = { locale: "en", timezone: "UTC" };
  const seen = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!(token in FLAGS)) {
      errors.push(`unknown or misplaced argument: ${token}`);
      continue;
    }
    if (seen.has(token)) {
      errors.push(`${token} given more than once — the last value would win silently, so nothing is accepted`);
      continue;
    }
    seen.add(token);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${token} needs a value`);
      continue;
    }
    i += 1;
    request[FLAGS[token]] = value;
  }

  for (const required of ["slug", "host", "displayName", "reason", "requestedBy"]) {
    if (request[required] === undefined) {
      errors.push(`missing ${Object.keys(FLAGS).find((f) => FLAGS[f] === required)}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, request };
}

// ---------------------------------------------------------------- semantics
/**
 * Why each refusal names the rule and the ref: the operator is about to hand this to a human
 * onboarding a real customer, and "invalid" is not something they can act on.
 */
export function validateRequest(request) {
  const errors = [];

  if (typeof request.slug !== "string" || !RULES.slug.test(request.slug)) {
    errors.push("slug must match the organisations.slug CHECK: lowercase letters, digits and dashes, 2-63 characters, no dash at either end");
  } else if (RESERVED_SLUGS.includes(request.slug)) {
    errors.push(`slug "${request.slug}" is reserved: it names a tenant_domains.kind class, the plan §214 apex alias, or the zone label itself`);
  }

  if (typeof request.host !== "string" || !RULES.host.test(request.host)) {
    errors.push("host must be an exact normalized hostname per tenancy_core:41-44: lowercase labels, no scheme, no port, no path, at least one dot");
  } else if ((request.host.match(/\./g) || []).length > HOST_MAX_DOTS) {
    errors.push("host has too many subdomain levels: the merged CHECK allows at most one below the zone, so acme.surveys.terraoi.app is not an exact tenant host");
  }

  if (typeof request.displayName !== "string" || !/^\S(.*\S)?$/.test(request.displayName)) {
    errors.push("display name must not be empty and must not start or end with whitespace (organisations.display_name CHECK)");
  } else if (request.displayName.length > LIMITS.displayName) {
    errors.push(`display name must be at most ${LIMITS.displayName} characters`);
  }

  if (typeof request.locale !== "string" || !RULES.locale.test(request.locale)) {
    errors.push(`locale must match the merged organisations.locale CHECK — #67: en-GB does not match it today, and this script will not work around that CHECK`);
  }

  if (typeof request.timezone !== "string" || !RULES.timezone.test(request.timezone)) {
    errors.push(`timezone must match the merged CHECK — #67: it allows exactly one slash, so America/Argentina/Buenos_Aires is refused until someone widens it`);
  }

  if (typeof request.reason !== "string" || request.reason.trim() === "") {
    errors.push("reason is required: §972 asks for attribution per action, and an unattributed tenant creation is a mystery waiting to be reviewed");
  } else if (request.reason.length > LIMITS.reason) {
    errors.push(`reason must be at most ${LIMITS.reason} characters`);
  }

  if (typeof request.requestedBy !== "string" || request.requestedBy.trim() === "") {
    errors.push("requested-by is required (the human who asked; the database records it and cannot verify it)");
  } else if (request.requestedBy.length > LIMITS.requestedBy) {
    errors.push(`requested-by must be at most ${LIMITS.requestedBy} characters`);
  }

  return errors;
}

// ---------------------------------------------------------------- the connection
export const BINDING = "CONTROL_PLANE_DB";

/**
 * The DSN is read at call time and returned only so the caller can hand it to the driver. The failure
 * object never carries it, and no log line in this file does.
 */
export function connectFromEnv(env) {
  const dsn = typeof env?.[BINDING] === "string" ? env[BINDING].trim() : "";
  if (dsn === "") {
    return {
      ok: false,
      reason: "not_configured",
      message:
        `${BINDING} is not set. It must hold the DSN of a login that is IN ROLE toi_control_plane. ` +
        "Creating that login, its password and its binding are §20.8 human steps (the #75 split), and this script will not run without them.",
    };
  }
  return { ok: true, dsn };
}

/**
 * Wire the existing `postgres` driver for the CLI main path (Round 1 B2). Tests inject their own
 * `connect`; this is what `run()` receives when the module is executed as a program.
 */
export function connectWithPostgres(dsn) {
  const sql = postgres(dsn, { prepare: false, max: 1 });
  return {
    async query(text, params = []) {
      return await sql.unsafe(text, params);
    },
    async end() {
      await sql.end({ timeout: 5 });
    },
  };
}

const isSqlState = (code) => typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);

/**
 * One RPC: `toi_control.provision_tenant_v1` returns the read-back columns, so the control-plane
 * login never SELECTs public tenancy tables.
 */
export async function provisionTenant({ request, query }) {
  let row;
  try {
    const rows = await query(
      "select organisation_id, status, host, roles, permissions, members " +
        "from toi_control.provision_tenant_v1($1, $2, $3, $4, $5, $6, $7)",
      [request.slug, request.host, request.displayName, request.locale, request.timezone,
        request.reason, request.requestedBy],
    );
    row = rows?.[0];
  } catch (error) {
    if (isSqlState(error?.code)) {
      return { ok: false, sqlState: error.code, problem: `the database refused the provisioning call (${error.code})` };
    }
    return { ok: false, reason: "unavailable", problem: "the control-plane database could not be reached" };
  }

  if (!row?.organisation_id) {
    return { ok: false, problem: "provisioning returned no organisation id, so there is nothing to report" };
  }

  const readBack = {
    organisationId: row.organisation_id,
    status: row.status,
    host: row.host ?? null,
    roles: Number(row.roles ?? 0),
    permissions: Number(row.permissions ?? 0),
    members: Number(row.members ?? 0),
  };

  if (readBack.members > 0) {
    return {
      ok: false,
      readBack,
      problem: `F05 says a platform administrator gains no operational access, yet ${readBack.members} membership row(s) exist for this tenant`,
    };
  }
  if (readBack.status !== "provisioning") {
    return {
      ok: false,
      readBack,
      problem: `expected the new tenant to be in status provisioning and found ${readBack.status}; a half-provisioned tenant must not be reported as created`,
    };
  }
  if (readBack.roles !== 2 || readBack.permissions !== 6) {
    return {
      ok: false,
      readBack,
      problem: `expected the two default roles and six permission areas the merged seed uses and found ${readBack.roles}/${readBack.permissions}`,
    };
  }

  return { ok: true, readBack };
}

// ---------------------------------------------------------------- CLI
export async function run({ argv, env, connect, log = console.log }) {
  if (argv.includes("--help") || argv.length === 0) {
    log(USAGE);
    return 0;
  }

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const e of parsed.errors) log(`error: ${e}`);
    log(USAGE);
    return 2;
  }

  const problems = validateRequest(parsed.request);
  if (problems.length > 0) {
    for (const p of problems) log(`error: ${p}`);
    return 2;
  }

  const binding = connectFromEnv(env);
  if (!binding.ok) {
    log(`error: ${binding.message}`);
    return 2;
  }

  const client = connect(binding.dsn);
  try {
    const result = await provisionTenant({ request: parsed.request, query: client.query });
    if (!result.ok) {
      log(`error: ${result.problem}`);
      if (result.readBack) log(`state read back: ${JSON.stringify(result.readBack)}`);
      return 1;
    }
    const b = result.readBack;
    log(`provisioned tenant ${b.organisationId} (slug ${parsed.request.slug}, host ${b.host})`);
    log(`status ${b.status}; roles ${b.roles}; permission areas ${b.permissions}; membership rows ${b.members}`);
    log("next: activation out of provisioning is a human step (resume_tenant_v1 is for a suspended tenant, not a new one).");
    return 0;
  } finally {
    await client.end();
  }
}

// Run as a program, not as an import: the same guard the other CLIs in this folder use, so the test
// file can call run() without a real environment being dialled behind its back.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    connect: connectWithPostgres,
  });
}
