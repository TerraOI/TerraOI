# TerraOI

Multi-tenant operational intelligence platform: each customer company gets a branded workspace at `<company>.terraoi.app` with expert agents that answer from that company's authorized documents, with verified citations.

**Start here:**

- **Builders and their AI agents:** read [AGENTS.md](AGENTS.md), then your task packet in [docs/tasks/](docs/tasks/).
- **Architecture and build plan:** [docs/plan/TerraOI-plan-v1.3.md](docs/plan/TerraOI-plan-v1.3.md) (build plan in §20).
- **Brand kit:** [brand/](brand/) (TerraOI Brand Kit v1.0.0).
- **Weekly status:** [docs/status/](docs/status/).

## Quick start

Requires Node 22+ (CI uses the version in `.nvmrc`), pnpm 10, and Docker for the local database.

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm verify       # lint + typecheck + tests + docs links + build
pnpm db:start && pnpm db:reset && pnpm db:test   # local Supabase + pgTAP tests (needs Docker)
```

## Layout

| Path | Purpose |
|---|---|
| `src/app/` | Next.js routes and API (Lane 1) |
| `src/platform/` | Platform modules split by lane (see AGENTS.md §3) |
| `src/contracts/` | Shared runtime schemas; protected |
| `supabase/` | Migrations, pgTAP tests, local config |
| `scripts/` | Repository policy checks (lanes, migrations, structure, docs links) |
| `brand/` | TerraOI Brand Kit (design source; see `brand/README.md`) |
| `docs/` | Plan, tasks, decisions, status |
| `.github/` | CI, PR policy, staging deploy, CODEOWNERS |

| | |
|---|---|
| Remote | <https://github.com/TerraOI/TerraOI> |
| Default branch | `main` (PRs only; see AGENTS.md §6) |
