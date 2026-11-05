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

Change a rule by editing its module and its tests together; the supervisor reviews changes to policy checks.
