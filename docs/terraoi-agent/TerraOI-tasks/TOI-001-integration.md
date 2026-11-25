# TOI-001..005 Integration of the open PR queue

Source: plan §20.1 (per-task flow, CI repeats checks), COORDINATION §3 (migration ordering), W48 status ("the review queue is the critical path").

## Scope
Merge every open PR head (75 PRs; 27 stack tips) onto `origin/main` a0a6b3c in PR-number order of tips; resolve conflicts; prove the composed tree passes every check that can run here.

## Merge order used (stack tips)
#178, #190, #191, #192, #219, #220, #223, #224, #226, #227, #229, #237, #252, #253, #265, #266, #272, #276, #278, #280, #283, #284, #285, #287, #288, #289, #290 (each tip carries its stack).

## Conflicts and resolutions
| File | Cause | Resolution |
|---|---|---|
| `supabase/tests/database/001_function_privileges.test.sql` | every RPC PR appends to the request-role allow-list | union of entries; #33 schema list gained `budget_ledger` next to `gateway_config` |
| `supabase/tests/database/013_tenant_admin.test.sql` | `plan(N)`, pinned trigger count #148, seeded matrix count #91 | plan = ours + theirs − base (173); #148 = 9 tables listed explicitly → 23; #91 = 9 rows |
| `supabase/tests/database/010_tenancy.test.sql` | seed counts #44/#45 | 4 roles; 9 permission rows + 7 assignments = 16 |
| `supabase/seed.sql` | #227 contributor vs T-312 eval_reviewer | both roles, both permission sets, separate assignment inserts |
| `src/contracts/database.types.ts` | generated file | regenerated (TOI-004) |
| `workers/scheduled.ts` / `.test.ts` | T-211 cloud extractor vs T-113 index/publish pulls | doc comment merged; imports and test blocks from both |
| `package.json` | `eval:ci` vs `eval:nightly` | keep `evals` in `eval:ci`; nightly runs `scripts/eval-nightly.mjs` |
| `docs/tasks/*`, `docs/REPO-STRUCTURE.md` | packet bodies edited on main since | main's text |
| `scripts/README.md` | two new tool rows | both |

## Defects found that no single PR's CI can see
1. Duplicate migration versions (Q-03) → re-timestamped: `20261124120500_index_stage_lease`, `20261124130500_publish_stage_lease`, `20261124140500_knowledge_submissions` (header/test references updated).
2. `src/platform/evals/draft.test.ts` (#250 stack) asserts a synchronous throw from `runExpertEval`, which #274 made async → unhandled rejection. Fixed with `await expect(...).rejects`.

3. **Lost migration.** The T-113 consumer stack (#282/#285) contains #219's commits and then deletes `20261120217000_chunk_publish.sql` and `036_chunk_publish.test.sql` (b476ae6, "one migration per PR", expecting #219 to merge separately). A plain merge of both therefore *drops* #219's `job_api.write_chunks_v1` / `publish_version_v1`, which `workers/index-pull.ts` and `publish-pull.ts` call — and every check still passed, because nothing in pgTAP or unit tests reaches those RPCs without #219's own `036`. Restored from #219's tip; pgTAP 38 files / 1818 pass. **Merge-order note for the owner: merge #219 before #282, and expect git to propose deleting the file — keep it.**

## Verification (executed 2026-11-25 on `terraoi/build`)
- `pnpm lint` exit 0; `pnpm typecheck` exit 0; `pnpm test` 186 files / 2074 tests pass.
- `scripts/db-shim/run.sh`: 34 files / 1664 assertions pass (PG16 shim).
- `pnpm check:structure`, `pnpm check:docs` pass. `check:migrations` reports 20 new migrations (expected for an integration branch; ordering clean).
- `next build --webpack` with font mock: compiles all 45 routes (type step skipped, Q-04). Turbopack build not runnable here.

## Lost-hunk audit (2026-11-25)
For every stack tip, every added line (>25 chars) outside docs was searched for in the integrated file. All misses were accounted for: the conflict resolutions above, the three re-timestamped migration names, T-312 `runExpertEval` tests rewritten async by #274 (same test names present), and `workers/scheduled*` describe blocks renamed by #285. The only real loss found was #219's migration (defect 3). Script: `node /workspace/pgshim/lost-lines.mjs` (sandbox-local).
