# Staging restore rehearsal (plan §16 Operations row, §17.2 step 3)

**Status: prepared, not run — owed, not waived.** Two things block every run today, and both are named rather than worked around:

1. [#177](https://github.com/TerraOI/TerraOI/issues/177) is open with the `policy-violation` label, and `.github/workflows/deploy-staging.yml` refuses to deploy while any such issue is open — so no staging environment can be brought up to restore into ([COORDINATION §6a](../COORDINATION.md): a rehearsal that could not run is recorded as owed).
2. There is no realistic corpus to restore: the storage path is still the deliberate `null` at `src/platform/knowledge/upload-adapters.ts:19`, so **every upload route answers 503** and no document has ever been ingested into staging (U-1 in [BACKLOG.md, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190)). A rehearsal now would exercise rows and auth only, and would report a coverage it does not have.

pgTAP and `pg_dump`/`psql` against a real Postgres also do not run on this machine — no Docker, so CI's `database` job is the only venue (FAQ-0009). Everything below is the procedure the owner runs, with the exact commands, plus the assertions that make the run mean something.

## Why a restore rehearsal rather than a backup check

A backup proves bytes exist. This rehearsal proves four things the plan cares about: the migration sequence replays in order, auth dependencies come back with the rows, object references still resolve, and **permission state and tenancy survive the round trip**. §16's row is "restore to an isolated environment"; the isolation is what makes it safe to run at all.

## Step 1 — capture · `OWNER` (credentials) + `AGENT` (the command)

```bash
# <STAGING_SESSION_DB_URL> is a Hyperdrive-managed connection string; it lives in the password
# manager, never in this file, a shell history file committed anywhere, or a log (AGENTS §4.6).
pg_dump --format=custom --file=<WORK>/staging-$(date -u +%Y%m%dT%H%M%SZ).dump "<STAGING_SESSION_DB_URL>"
```

Record the dump's sha256, the `wrangler` version id then serving staging, and the pinned `embedding_indexes` generation. Those three are the artifact set the restore is judged against.

## Step 2 — replay into an isolated environment, twice · `OWNER` runs, `AGENT` wrote the check

Two different replays, because they prove different things (§17.2 step 3: "an empty replay and a realistic upgrade"):

```bash
# (a) empty replay: the merged migration sequence must reproduce the live schema exactly
createdb <REHEARSAL_DB>
git ls-files 'supabase/migrations/*.sql' | sort | while read -r f; do
  psql -v ON_ERROR_STOP=1 -d <REHEARSAL_DB> -f "$f" || break
done
pg_dump --schema-only -d <REHEARSAL_DB> > <WORK>/built.sql
pg_dump --schema-only -d <STAGING_SESSION_DB> > <WORK>/live.sql
diff -u <WORK>/live.sql <WORK>/built.sql     # empty diff, or the drift is written down as a finding
```

`git ls-files | sort` is the same order `supabase/migrations/` implies and the same order CI applies; `scripts/migrations.mjs` enforces that no merged file is edited and that each new one sorts later, so a diff here means the sequence itself is wrong, not the dump.

```bash
# (b) realistic upgrade: restore the capture, then apply the migrations added since it was taken
pg_restore -d <REHEARSAL_DB> --exit-on-error <WORK>/staging-<STAMP>.dump
```

A migration that fails partway is reported as **failed**, with the sequence position recorded — never as half-restored-and-serving. That is §17.2's failure rule, and it is the reason the environment is isolated: a broken replay must not be reachable by a user.

## Step 3 — the assertions that make the run mean something · `AGENT` specifies, `OWNER` approves the result

After a restore, all of these are checked, and the register row carries each answer:

- **Tenancy still holds.** The company1/company2 isolation check: a company1 session reads its own rows and nothing else — the same pair the pgTAP suites pin (11 suites, 417 planned assertions on `main`).
- **Revoked sources stay revoked.** A source revoked before the capture is not retrievable after the restore. This is T-213's revoke predicate and T-214's read decision; **while those do not exist, this assertion is reported as not run**, never as passed (T-404 acceptance test 6).
- **A stale ingestion job cannot resurrect a revoked source.** Requeue a job whose source row was revoked before the capture, and assert it ends in a refusal with a recorded reason (the closed reason vocabulary in [#99](https://github.com/TerraOI/TerraOI/issues/99)).
- **No signed URL survives in any row** ([#10](https://github.com/TerraOI/TerraOI/issues/10)): a `select` over every column that could hold one returns nothing but opaque object keys.
- **Auth dependencies came back**: the tenant's users, their membership rows and their role grants; a login that worked before the capture still resolves to the same tenant.
- **Object references resolve**: every stored document key still names an object that exists in the restored bucket, with the same access policy.

## Step 4 — timings, and what they mean · `OWNER` owns the targets

Record wall-clock for capture, empty replay, upgrade replay and each assertion. §18.3 sets RPO/RTO as owner numbers, so the runbook reports **measured** durations and names the target as `<owner-set>` (D-5 in [BACKLOG.md, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190)). A rehearsal without timings is a story.

## What this rehearsal does *not* prove

- It does not prove production can be restored — production does not exist yet, and only the owner runs a production restore (§20.8).
- It does not prove the connector or external-action paths; those actions are not reversible by a restore, which is why §17.2 separates them.
- If the owner decides the rehearsal may not run against a copy containing Company1 corpora (the clearance question parked as D-6), it runs on synthetic fixtures instead, and that keeps the auth-dependency half weaker — the runbook says so in its own register row rather than letting the substitution disappear.

## Register row shape

`docs/status/YYYY-Www.md`: **Observed** only if the run happened here or was read from a CI job id; the row names the dump sha256, the three replays' durations, each assertion's answer, and every assertion that could not be run with the human step that would unblock it.
