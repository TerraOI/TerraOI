#!/usr/bin/env node
// T-211 / #134: issue a worker credential for the job API and store **only its hash**.
//
// This is an owner tool, not an application path. It writes one row into
// `job_api.worker_credentials`, which no request role and not even `toi_job_api` can read, and it
// prints the clear-text token exactly once, to the terminal, for the operator to place in the box's
// secret store or in `wrangler secret` for the `workers/` deployment (AGENTS §4.6: never in the repo,
// never in an agent chat, never in a log). The digest is what the job-API compares match on
// (`lease_parse_job_v1` and friends), so the database can never reveal a token.
//
// The same digest discipline as ADR-0002 §4's `ip_hash`: SHA-256, lowercase hex, and a token with
// enough entropy that the digest is not guessable (256 bits).
//
// Usage (the human steps around it are ADR-0005 §9 and T-004 §20.8; there is no runbook yet — the
// box-offline drill that needs one is T-314's):
//   node scripts/worker-credential.mjs issue --label syn-box-company1 --executor local_box \
//        --org 11111111-1111-4111-8111-111111111111
//   node scripts/worker-credential.mjs revoke --label syn-box-company1
//   JOB_DB_URL=postgresql://… node scripts/worker-credential.mjs …   # connects; otherwise it prints
//                                                                    # the SQL for the owner to run
// Connecting to a database from a development machine is an owner action on a documented server path
// (AGENTS §6, "touching production resources … from a development machine"): the target is staging
// first, and the connection string comes from the operator's environment, never from this file.

import { createHash, randomBytes } from "node:crypto";

const LABEL_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXECUTORS = ["local_box", "cloud_worker"];

/** 32 random bytes, base64url without padding: 43 characters, inside the column and contract bounds. */
export function newToken() {
  return randomBytes(32).toString("base64url");
}

/** What gets stored. The token itself is never written anywhere. */
export function digestOf(token) {
  if (typeof token !== "string" || token.length < 43) {
    throw new Error("token must be a 43-character base64url value");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Parses and validates the arguments, so a typo cannot produce a credential that leases nothing. */
export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (action !== "issue" && action !== "revoke") {
    throw new Error("first argument must be `issue` or `revoke`");
  }
  const out = { action, label: null, executor: null, orgs: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag || !flag.startsWith("--") || value === undefined) {
      throw new Error(`unpaired flag near ${flag ?? "(end of arguments)"}`);
    }
    if (flag === "--label") out.label = value;
    else if (flag === "--executor") out.executor = value;
    else if (flag === "--org") out.orgs.push(...value.split(","));
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!out.label || !LABEL_RE.test(out.label)) {
    throw new Error(`--label must match ${LABEL_RE} (3-64 chars, lowercase, no underscores)`);
  }
  if (action === "issue") {
    if (!EXECUTORS.includes(out.executor)) {
      throw new Error(`--executor must be one of ${EXECUTORS.join(", ")} (#135: one credential, one executor)`);
    }
    if (out.orgs.length < 1 || out.orgs.length > 8) {
      throw new Error("--org must name between 1 and 8 organisations (the column's CHECK)");
    }
    for (const id of out.orgs) {
      if (!UUID_RE.test(id.toLowerCase())) throw new Error(`--org ${id} is not a uuid`);
    }
  } else if (out.orgs.length || out.executor) {
    throw new Error("`revoke` takes only --label");
  }
  return out;
}

/** The SQL for an operator who prefers to run it themselves, and the only output when there is no
 *  connection string. Quoting is the same for both paths, so what is printed is what was run. */
export function insertSql({ label, executor, orgs }) {
  const list = orgs.map((o) => `'${o.toLowerCase()}'::uuid`).join(", ");
  return (
    "insert into job_api.worker_credentials (label, token_hash, executor, organisations)\n" +
    `  values ('${label}', '<64-hex-sha256-of-the-token>', '${executor}', array[${list}]::uuid[]);`
  );
}

export function revokeSql({ label }) {
  return (
    "update job_api.worker_credentials set revoked_at = now()\n" +
    ` where label = '${label}' and revoked_at is null;`
  );
}

// Run only when invoked directly, so the test file can import the helpers above.
if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = parseArgs(process.argv.slice(2));
  if (spec.action === "revoke") {
    console.log(revokeSql(spec));
    console.log("\nRevocation stops new leases *and* in-flight renew/complete: every job-API compare");
    console.log("joins worker_credentials with revoked_at is null (#134).");
    process.exit(0);
  }
  const token = newToken();
  const digest = digestOf(token);
  const sql = insertSql({ ...spec });
  if (!process.env.JOB_DB_URL) {
    console.log("No JOB_DB_URL in the environment, so nothing was written. Run this as the owner:");
    console.log(`\n${sql.replace("<64-hex-sha256-of-the-token>", digest)}\n`);
    console.log(`Token for ${spec.label} (shown once, store it in the box's secret store):`);
    console.log(token);
    process.exit(0);
  }
  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(process.env.JOB_DB_URL, { max: 1, ssl: "require" });
  try {
    await sqlClient`insert into job_api.worker_credentials
                      (label, token_hash, executor, organisations)
                    values (${spec.label}, ${digest}, ${spec.executor},
                            ${spec.orgs.map((o) => o.toLowerCase())}::uuid[])`;
    console.log(`Stored the digest for ${spec.label} (${spec.executor}, ${spec.orgs.length} tenant(s)).`);
    console.log(`Token for ${spec.label} (shown once — the database cannot give it back later):`);
    console.log(token);
  } finally {
    await sqlClient.end({ timeout: 5 });
  }
}
