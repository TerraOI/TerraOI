# scripts/

Repository policy checks. Each check keeps its rules in a pure, unit-tested module (`*.mjs` + `*.test.mjs`) and a thin CLI (`check-*.mjs`) used by `pnpm` and CI.

| Command | CLI | Rules | Runs in |
|---|---|---|---|
| `pnpm check:structure` | `check-structure.mjs` | `structure.mjs`: layout and naming from docs/REPO-STRUCTURE.md | `pnpm verify`, CI `verify`, weekly hygiene |
| `pnpm check:docs` | `check-docs.mjs` | Relative Markdown links resolve (archive skipped) | `pnpm verify`, CI `verify`, weekly hygiene |
| `pnpm check:lanes` | `check-lanes.mjs` | `lanes.mjs`: one build lane per PR unless labeled `cross-lane` | CI `lanes` |
| `pnpm check:migrations` | `check-migrations.mjs` | `migrations.mjs`: one new, later migration per PR; merged ones immutable | CI `migrations` |
| (CI only) | `check-provisional.mjs` | `provisional.mjs`: a PR built on an open question cannot merge | CI `provisional` |
| (CI only) | `check-pr-provenance.mjs` | `provenance.mjs`: commits on `main` came through merged, reviewed PRs | `main-guard`, `deploy-staging` |
| (not wired) | `check-ops-alerts.mjs` | `ops-metrics.mjs`: §17.1's metric set and the eight alert rules; a metric with no table reads `not_available` and names who owes it, never `0` | its tests run under `pnpm test`; **no CI job and no scheduler** — a job that pages a human needs an owner-set destination (D-7) and the owner's decision on the plan-level credential question |
| `node scripts/check-release-preflight.mjs --env <name>` | `check-release-preflight.mjs` | `release-preflight.mjs`: no production route, Worker name or service target under `env.staging` and no staging one in production; the bindings the code reads are declared; no secret-shaped value or project ref in the config (T-404, plan §17.2 step 2) | `pnpm test` covers the rules today; wiring the CLI into a release job is **proposed, not done** (`.github/` is protected — see T-404's Owns) |
| `node scripts/workers-rollback.mjs --env staging --list` / `--to <version-id> [--execute]` | the same file | `workers-rollback.mjs`: a rollback names a version wrangler listed, refuses the one already serving, and refuses `production` without an explicit flag | a rehearsal tool run by a person, **never CI** |
| operator-run, never CI | `provision-tenant.mjs` | `provision-tenant.mjs` + `provision-tenant.test.mjs`: F05 tenant provisioning through `toi_control.provision_tenant_v1` (T-304) | an operator's shell, with `CONTROL_PLANE_DB` set |
| `pnpm eval:nightly` | `eval-nightly.mjs` | Soft-skip when staging secrets are missing; otherwise runs the full F35 Vitest suite (T-312 / #74) | `.github/workflows/eval-nightly.yml` (schedule + workflow_dispatch only) |

The last three rows are outward-facing operator tools rather than policy checks: their CLIs sit with their rules (or use an injected query/`exec` so unit tests never dial a database or deploy). Rollback and provision are deliberately in no workflow; release-preflight is proposed for a release job only under supervisor-owned `.github/`.
Rows below the CI-only provenance check are outward-facing operator / ops tools rather than build gates: `check-ops-alerts.mjs` is an operational evaluator (never pages from CI; `--dry-run` exit 0 proves only that each rule can fire); rollback and provision are deliberately in no workflow; release-preflight is proposed for a release job only under supervisor-owned `.github/`. Whichever of #191 / #192 / #193 merges last keeps all of these rows.
The provisioning row is not a policy check. It is an outward-facing action that ends with a real tenant existing, so it is deliberately in no workflow and in `pnpm test` only as a unit test that never dials a database (the query function is injected). Its validation mirrors the migration's rules, and two of its tests read those rules out of the SQL on disk rather than restating them — a client-side copy of a server-side rule is exactly the kind of second mechanism that drifts, which is also why this script refuses to stop or resume a tenant.

Change a rule by editing its module and its tests together; the supervisor reviews changes to policy checks.
