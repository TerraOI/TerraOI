# Production release (plan §17.2)

**Status of this runbook: prepared, never executed.** Every `OWNER` line below needs account access, a secret, DNS or a production write, and plan §20.8 says agents do not perform those. Every `AGENT` line is a command that exists in this repository and has been run against **staging** or in dry-run only. Nothing in this file has ever touched production, because production does not exist yet: [T-004](../tasks/T-004-infrastructure.md)'s production checkboxes are still open, and there is no production job in `.github/workflows/` (the job is **proposed** in [T-404](../tasks/T-404-production-readiness.md) and lands with the supervisor, who owns that path).

Placeholders are `<LIKE_THIS>`. A real value never goes in this file (AGENTS §4.6): binding names yes, credentials and connection strings no.

## The two artifacts a release pairs

A release is a **pair**, and a rollback restores the pair, not one half of it:

1. the app artifact: a tagged commit (`git tag -a v<SEMVER> -m "…"`) plus the `wrangler` **version id** that deployment produced (`node scripts/workers-rollback.mjs --env <env> --list` prints both);
2. the data generation: the pinned `embedding_indexes` generation for that corpus, per [ADR-0007](../decisions/0007-e1-embedding-clearance.md) and [T-113](../tasks/T-113-chunk-embed-publish.md)'s pointer switch.

§17.2: "App/DNS rollback does not undo database, published-source or external-action changes." So the tag and the version id are recorded together **in the register row for the release**, and a release whose generation is not recorded cannot be rolled back safely.

## Step 1 — confirm what is being released · `AGENT` (the checklist) + `OWNER` (the numbers)

```bash
git fetch origin && git log --oneline origin/main -20
node scripts/check-migrations.mjs          # one new, later migration per PR; merged ones immutable
node scripts/check-release-preflight.mjs --env staging
```

Confirm, in writing, in the week's `docs/status/YYYY-Www.md`: the target commit, which lane owns each changed area, the migration sequence the release applies, and the processor policies. **`OWNER`:** the numeric thresholds (§18.3 leaves them owner-set — see D-5 in [BACKLOG.md, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190)). The preflight for `production` refuses today with `no-routes-declared`; that is the guard working, not a defect — production routes arrive with DNS verification on T-004.

## Step 2 — isolated environments, checked rather than assumed · `OWNER` creates, `AGENT` checks

Staging must be isolated from production in database, storage, keys and budget. The machine-checkable half is the preflight:

```bash
node scripts/check-release-preflight.mjs --env production   # refuses until the owner fills the routes
```

Its rules are in `scripts/release-preflight.mjs` and each has a test: no production route, Worker name or service target under `env.staging`; no staging one in production; the bindings the code reads must be declared; no secret-shaped value and no project ref in the config. A staging value inherited into production is the failure this step exists to prevent — wrangler replaces arrays rather than merging them, which is why `env.staging` and `env.production` each spell out their own `services` and `ratelimits`.

## Step 3 — rehearse before releasing · `AGENT` on staging, `OWNER` for production

Run [restore-rehearsal.md](restore-rehearsal.md) and [rollback.md](rollback.md). Both are gated today: an open `policy-violation` issue ([#177](https://github.com/TerraOI/TerraOI/issues/177)) makes `deploy-staging.yml` refuse every staging deploy, so the rehearsals are **owed, not waived** ([COORDINATION §6a](../COORDINATION.md)).

## Step 4 — DNS, routes, bindings and secrets **before traffic** · `OWNER` (§20.8 rows 1–2, 5)

Names the owner creates, in this order, each cross-referenced to a [T-004](../tasks/T-004-infrastructure.md) checkbox:

| What | Name the code reads | T-004 step |
|---|---|---|
| Hyperdrive configs and their login roles | `SESSION_DB`, `CONFIG_DB`, `JOB_DB`, `INQUIRY_DB` | provisioning |
| Worker secrets (`wrangler secret put`) | `SESSION_TOKEN_KEY`, `IDENTITY_SESSION_KEY`, `TURNSTILE_SECRET`, `INQUIRY_IP_HMAC_KEY`, the email API key, the model key | provisioning |
| Production routes | exact hosts; a `*.terraoi.app/*` wildcard is an explicit owner decision, and the exact staging hosts must be listed alongside it | DNS verified, then routes |
| Local-box access (only when the chain uses it) | the Access service token and the model server's own credential | §13 topology |

Then re-run the preflight for production: it must report no findings. Filling `routes` in `wrangler.jsonc` is the last config edit, never the first.

## Step 5 — deploy schema, then cut over · `AGENT` prepares, `OWNER` decides the cutover

Forward-compatible migrations only: an app rollback must not require a schema rollback. A migration that breaks the previous app version is a **cutover**, and a cutover needs the owner's decision plus a frozen artifact pair (old app + old generation). The corpus/prompt/model cutovers are separate deploys from the schema deploy — §17.2 says so precisely because doing them together removes the ability to roll back one without the other.

## Step 6 — observe, and record the pair · `OWNER` (the thresholds) + `AGENT` (the row)

The register row for a release carries: the tag, the version id, the migration files applied in order, the generation pinned, the preflight output line, and the alert thresholds being watched (from [T-405, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190) once it exists; until then §17.1's thresholds are `<owner-set>`, and "one active scheduler per logical job" is checked by hand).

## Stop conditions

- The preflight reports any finding → **stop**, no deploy step runs. That is the rule, not advice (`scripts/check-release-preflight.mjs` exits 1; a mis-typed environment name exits 2, which is a different fact and should be read as one).
- A migration in the sequence fails → the environment stays on the previous compatible version and the sequence is recorded in the register, per §17.2.
- `pg_prove` is not green after the schema deploy → stop; the app deploy does not proceed. pgTAP runs only in CI's `database` job here (FAQ-0009: no Docker on a builder machine).
- Nobody can name the previous artifact pair in one line → stop and write it down first.

## What is still missing before this runbook is executable

1. a production job in `.github/workflows/` (the supervisor's; proposed in T-404 and deliberately not written by an agent);
2. a `production` GitHub environment with approval requirements — and the plan-level question behind it (D-7 in [BACKLOG.md, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190): on the current subscription, repository secrets are readable by any workflow on any branch, including one edited in a PR);
3. T-004's production provisioning checkboxes;
4. branch protection on `main`, which the `main-guard` stopgap stands in for today.
