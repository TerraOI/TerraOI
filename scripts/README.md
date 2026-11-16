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

One row is not a repository policy check: `check-ops-alerts.mjs` is an **operational evaluator** whose rules happen to be unit-tested the same way. It never gates a build, and its `--dry-run` exit 0 proves only that each rule can fire — not that an alert was delivered or a threshold was chosen. Its `main()` is guarded so the module is importable and the CLI runs only when invoked directly. (`workers-rollback.mjs`, the other non-gate shape, lives on [PR #191](https://github.com/TerraOI/TerraOI/pull/191), not on this branch — this row is written so the two land without contradicting each other, and whichever merges second keeps both rows.)

Change a rule by editing its module and its tests together; the supervisor reviews changes to policy checks.
