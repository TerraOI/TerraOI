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
| operator-run, never CI | `provision-tenant.mjs` | `provision-tenant.mjs` + `provision-tenant.test.mjs`: F05 tenant provisioning through `toi_control.provision_tenant_v1` (T-304) | an operator's shell, with `CONTROL_PLANE_DB` set |
| `pnpm eval:nightly` | `eval-nightly.mjs` | Soft-skip when staging secrets are missing; otherwise runs the full F35 Vitest suite (T-312 / #74) | `.github/workflows/eval-nightly.yml` (schedule + workflow_dispatch only) |

The provisioning row is not a policy check. It is an outward-facing action that ends with a real tenant existing, so it is deliberately in no workflow and in `pnpm test` only as a unit test that never dials a database (the query function is injected). Its validation mirrors the migration's rules, and two of its tests read those rules out of the SQL on disk rather than restating them — a client-side copy of a server-side rule is exactly the kind of second mechanism that drifts, which is also why this script refuses to stop or resume a tenant.

Change a rule by editing its module and its tests together; the supervisor reviews changes to policy checks.
