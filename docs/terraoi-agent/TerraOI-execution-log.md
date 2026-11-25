# Execution log

- 2026-11-25 Baseline: repo TerraOI/TerraOI (only remote; plan at docs/plan/TerraOI-plan-v1.3.md). main a0a6b3c: lint/typecheck pass, unit 1473 pass, build env-blocked (fonts). Docker daemon starts but registry pulls fail (no DNS) → built PG16 shim; main pgTAP 1160 pass after matching Supabase's non-superuser `postgres`.
- 2026-11-25 Found 75 open PRs (27 tips). Integrated all on `terraoi/build` (TOI-001), fixed 3 migration version collisions (TOI-002), one cross-PR async test break (TOI-003), regenerated types with byte-faithful postgres-meta (TOI-004). Composed tree: unit 2074, pgTAP 1664, lint/type/structure/docs pass.
- 2026-11-25 Moved harness into `scripts/db-shim/` (TOI-005).
- 2026-11-25 GitHub write attempts: create_branch 403, comment denied → Q-07; deliver bundle.
- 2026-11-25 TOI-006 T-303: migration 20261125100000 + pgTAP 091 (30) + client/service/UI (+34 unit). Guard spot-check done. Full suite: unit 2108, pgTAP 1694.
- 2026-11-25 TOI-007 T-203 slices 1+3 (history/resume, evidence panel): +2 test files, chat suites 126 pass. Picker → Q-11, citation open → Q-10 (ADR-0011 boundary).
- 2026-11-25 TOI-008 T-302: migration 20261125110000 + pgTAP 085 (22) + feedback/collections routes, controls, reviewer queue (+18 unit). Full: unit 2136, pgTAP 1716.
- 2026-11-25 TOI-009 T-402 local legs: pgTAP 110 (24; 2 findings as todo R-1/R-2), R-3 noted. Mapped forged-history/spoofed-header boxes to existing tests.
- 2026-11-25 Found #219 migration silently dropped by T-113 stack merge → restored (TOI-014/Q-12). TOI-013: worker publish bypassed T-213 review → wrapper migration 20261125120000 + worker outcome; pgTAP 049 (14), workers +2.
- 2026-11-25 TOI-015: #186 (T-201 PR-2) closed unmerged with rulings given → re-implemented to #179/#182-#185: migration 20261125130000, pgTAP 018 (27), identity TS wiring + tests.
- 2026-11-25 TOI-013 park path hardened (advisor review); 018 owner pin; TOI-015 reframed as reference impl; TOI-016 chat composition left BLOCKED with packet proposal. Final: unit 2145, pgTAP 1864.
