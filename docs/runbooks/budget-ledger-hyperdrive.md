# Budget ledger Hyperdrive path (T-313 / [#134](https://github.com/TerraOI/TerraOI/issues/134))

**Status: prepared; the live Hyperdrive login and binding are `OWNER` steps (T-004 §20.8) and are not executed from this PR.** Agents must not create database logins, passwords, Hyperdrive configs or `wrangler` secrets (AGENTS.md §4.6 / §6).

F19 reservation authority lives in schema `budget_ledger` as role `toi_budget_ledger` (`NOLOGIN`). Request roles (`anon`, `authenticated`, `service_role`) hold **no** `EXECUTE`. The Worker reaches the ledger the same way `JOB_DB` / `CONFIG_DB` reach their paths: a dedicated login user `IN ROLE toi_budget_ledger` over its own Hyperdrive binding.

## What this path proves

| # | Proof | Who |
|---|---|---|
| 1 | Login user can `EXECUTE` only `budget_ledger.ensure_account_v1` / `reserve_v1` / `reconcile_v1` | Owner smoke + CI pgTAP `095` |
| 2 | Same login cannot `INSERT`/`SELECT` budget tables directly | Owner smoke + CI pgTAP `095` |
| 3 | App Worker binds **`BUDGET_DB`** (name only in repo; id is owner-created) | Owner |
| 4 | No secret, password or connection string is committed | Agents / CI `secrets` job |

## Preconditions

- Migration that creates `toi_budget_ledger` and `budget_ledger.*` is applied on the target database (T-313 PR-1).
- Owner can create a Supabase / Postgres login and a Cloudflare Hyperdrive config for **staging first**.
- `wrangler.jsonc` `env.staging` may declare the binding **name** `BUDGET_DB` once the Hyperdrive id exists — never paste the connection string into the repo or a chat.

## Procedure · `OWNER`

1. **Login user.** In the staging database, create a login role whose only membership is `IN ROLE toi_budget_ledger`. Generate a password; store it only in the password manager. Do not grant table privileges.
2. **Hyperdrive.** Create a Hyperdrive config pointed at that login (SSL required). Note the config id in the password manager next to the password — not in git.
3. **Worker binding.** Add to the app Worker's `wrangler.jsonc` `env.staging` (and later production) a Hyperdrive binding named **`BUDGET_DB`** with that config id. Ship the binding name in a PR if the file is not already updated; the id value is environment configuration the owner sets.
4. **Smoke (staging).** From a one-off Worker or `wrangler d1`/`psql` session **as that login only**:
   - `select budget_ledger.ensure_account_v1(<synth org>, …)` succeeds for a synthetic ceiling.
   - `select budget_ledger.reserve_v1(…)` returns a reservation id.
   - A direct `select * from public.budget_accounts` as that login fails (no table grant).
5. **Record.** Append one row to the current `docs/status/YYYY-Www.md`: Hyperdrive config created (yes/no), binding name `BUDGET_DB` present (yes/no), smoke pass/fail. **No passwords, no connection strings, no Hyperdrive ids.**

## Agent half (no owner credentials)

```text
pnpm exec vitest run src/platform/budgets src/platform/audit
# 095 pgTAP: CI database job (FAQ-0009)
```

Unit and pgTAP suites prove the SQL authority and MeterPort / F22 writers. They do not replace the OWNER Hyperdrive smoke.

## Code half (agent)

`src/platform/budgets/ledger-sql.ts` — `createBudgetLedgerExecFromSql({ binding: env.BUDGET_DB })` returns `null` when unbound (fail closed) and dials only `reserve_v1` / `reconcile_v1` when bound. Wire it into the Worker gateway deps once the OWNER binding exists.

## Out of scope

Company1 ceiling numbers (§20.8); F22 SQL persistence into `agent_runs` (T-104 / #178).
