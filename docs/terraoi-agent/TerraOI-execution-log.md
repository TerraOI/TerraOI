# Execution log

- 2026-11-25 Baseline: repo TerraOI/TerraOI (only remote; plan at docs/plan/TerraOI-plan-v1.3.md). main a0a6b3c: lint/typecheck pass, unit 1473 pass, build env-blocked (fonts). Docker daemon starts but registry pulls fail (no DNS) → built PG16 shim; main pgTAP 1160 pass after matching Supabase's non-superuser `postgres`.
- 2026-11-25 Found 75 open PRs (27 tips). Integrated all on `terraoi/build` (TOI-001), fixed 3 migration version collisions (TOI-002), one cross-PR async test break (TOI-003), regenerated types with byte-faithful postgres-meta (TOI-004). Composed tree: unit 2074, pgTAP 1664, lint/type/structure/docs pass.
- 2026-11-25 Moved harness into `scripts/db-shim/` (TOI-005).
