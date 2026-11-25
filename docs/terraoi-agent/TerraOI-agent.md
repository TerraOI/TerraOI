# TerraOI agent: execution instructions

1. Read [AGENTS.md](../../AGENTS.md) first; it binds this agent like any builder (non-negotiables §4, forbidden actions §6).
2. Resume from [TerraOI-state.md](TerraOI-state.md); never re-audit the whole repository.
3. One verifiable task at a time: cite the plan section / packet, inspect only relevant code, write the failing test first, implement the smallest change, run the checks below, update todo/state/log and the task file, commit.
4. Statuses: PENDING, IN_PROGRESS, VERIFY, DONE, BLOCKED. DONE only with executed evidence; staging/owner evidence stays visible as owed.
5. Never push to `main`, never merge or approve PRs (provenance guard: a non-author supervisor approval is required), never touch production, never invent credentials or results.

## Branch model

`terraoi/build` = `origin/main` + every open PR head (merged in PR-number order of stack tips) + integration fixes + agent work. It is an **integration and evidence branch**: the individual PRs stay the review units. Conflict rules used: `docs/` packet bodies → main's text; shared pgTAP slot files → both sides, with `plan(N)` = ours + theirs − base and pinned counts recomputed by hand; `database.types.ts` → regenerated, never hand-merged.

## Local checks (no Docker image pulls in this sandbox)

| Check | Command | Note |
|---|---|---|
| lint / types / unit | `pnpm lint`, `pnpm typecheck`, `pnpm test` | as CI |
| structure / docs | `pnpm check:structure`, `pnpm check:docs` | as CI |
| pgTAP | `scripts/db-shim/run.sh` | PG16 + pgvector + pgtap + pg_cron, Supabase roles emulated (non-superuser `postgres`); **not** `supabase db test` (config pins PG17) |
| generated types | `scripts/db-shim/gentypes.sh` | postgres-meta v0.100.0 (the CLI 3.0.0 pin), identity formatter; byte-identical to CI on `main` |
| Next build | `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=scripts/db-shim/font-mock.cjs next build --webpack` | sandbox has no DNS for Google Fonts; Turbopack build cannot be run here |
