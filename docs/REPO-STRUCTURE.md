# Repository structure and conventions

The single description of **where things go** in TerraOI. `scripts/check-structure.mjs` enforces the mechanical parts in `pnpm verify` and CI. The supervisor's weekly housekeeping review (`/terraoi-housekeeping`) covers the parts that need judgment. If this file and the check disagree, fix both in the same PR.

## Top level

| Entry | Purpose | Owner |
|---|---|---|
| `README.md` | Front door: what TerraOI is, quick start, where to go next | Supervisor |
| `AGENTS.md`, `CLAUDE.md`, `.cursor/` | Rules for AI agents (CLAUDE/Cursor only point to AGENTS.md) | Supervisor |
| `src/` | Application code (Next.js app, platform modules, contracts) | Lanes 1/2 |
| `supabase/` | Database: `config.toml`, `migrations/`, `tests/database/` (pgTAP), `seed.sql` | Shared, protected |
| `workers/` | Background workers (ingestion, sync, dispatcher, scheduled) | Lane 2 |
| `localbox/` | Local-box OCR pull worker and setup notes; never secrets | Lane 2 |
| `evals/` | Approved evaluation fixtures per expert | Lane 2 |
| `brand/` | TerraOI Brand Kit, a design source ([brand/README.md](../brand/README.md)) | Supervisor |
| `public/` | Static files served as-is by Next.js | Lane 1 |
| `scripts/` | Repository policy checks and dev tooling ([scripts/README.md](../scripts/README.md)) | Shared |
| `docs/` | Plan, coordination, tasks, decisions, status ([docs/README.md](README.md)) | Supervisor |
| `.github/` | CI/CD workflows, CODEOWNERS, PR/issue templates, labels | Supervisor |
| `.claude/` | Supervisor's Claude Code commands | Supervisor |
| Root config | `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `next.config.ts`, `open-next.config.ts`, `wrangler.jsonc`, `.nvmrc`, `.gitignore` | Shared |

Nothing else belongs at the top level. A new top-level entry needs a PR that updates this table and `scripts/structure.mjs`, reviewed by the supervisor.

## Inside `src/`

```text
src/
  proxy.ts             # Next 16's proxy (ADR-0006): stamps the routed host for pages; see below
  app/                 # routes, pages, API handlers only; thin; call platform modules
  components/          # React UI components (tenant-shell, chat, citations, knowledge, approvals)
  contracts/           # Zod schemas + generated database.types.ts; protected
  platform/<module>/   # one folder per platform module (list below); business logic lives here
  modules/<service>/   # service add-ons (uav, gpr) when their operational work starts
```

`proxy.ts` and its two colocated tests are the only files allowed directly under `src/` (`SRC_ROOT_FILES` in `scripts/structure.mjs`, shared path). They sit there because Next requires the proxy entry at the `src/` root, and the repo's rule is that a test lives next to the file it covers. Nothing else may sit at that level: `middleware.ts` is rejected by the structure check, so a second entry point that touches the routed host cannot appear under a stale name. Route handlers keep reading `request.url`; only pages read the header the proxy sets ([ADR-0006](decisions/0006-page-host-via-proxy-header.md)).

`src/app/` is Lane 1, except `src/app/api/jobs/` (local-box job API) and `src/app/api/knowledge/` (review, publish, revoke), which are Lane 2 and protected ([FAQ-0005](FAQ.md)). `scripts/lanes.mjs` resolves ownership by the **longest matching prefix**, so a narrower folder can belong to the other lane. Adding another such folder needs a supervisor PR that changes `lanes.mjs`, its tests, CODEOWNERS and this paragraph together.

Allowed platform modules (plan §3.3): `tenancy`, `identity`, `policy`, `branding`, `services`, `chat`, `forms`, `notifications`, `approvals`, `knowledge`, `retrieval`, `agents`, `gateway`, `evals`, `budgets`, `audit`, `connectors`, `site` (public terraoi.app site and pilot intake, T-130). A new module needs supervisor approval and an entry in `scripts/structure.mjs`.

## Naming conventions

| What | Pattern | Example |
|---|---|---|
| Task packet | `docs/tasks/T-NNN-kebab-name.md` | `T-101-host-resolver.md` |
| Decision record | `docs/decisions/NNNN-kebab-name.md` | `0001-core-contracts.md` |
| Weekly status | `docs/status/YYYY-Www.md` (ISO week) | `2026-W45.md` |
| Plan | `docs/plan/TerraOI-plan-vX.Y.md`; older versions go to `docs/plan/archive/` unchanged | `TerraOI-plan-v1.3.md` |
| Migration | `supabase/migrations/YYYYMMDDHHMMSS_snake_name.sql` (UTC), one per PR | `20261110090000_tenancy_core.sql` |
| pgTAP test | `supabase/tests/database/NNN_topic.test.sql` | `010_tenancy.test.sql` |
| Unit test | next to the code: `name.test.ts` | `host.test.ts` |
| Branch | `t-NNN-short-name` (task) or `chore/…`, `fix/…`, `docs/…` | `t-101-host-resolver` |
| TypeScript files | `kebab-case.ts`; React components `PascalCase.tsx` | `host-resolver.ts`, `EvidencePanel.tsx` |

## Hygiene rules

- No OS/editor junk, logs, `.env*` (except `.env.example`), `.dev.vars*` or `node_modules` in git.
- Generated files are committed only where listed (`database.types.ts`, the brand kit's `02-system` outputs) and are never hand-edited.
- Every top-level folder that people browse has a `README.md` saying what is in it and who owns it.
- Documents move, they don't get copied: when a doc is superseded, move the old one to an `archive/` folder and fix links to the new one.
- Dead code, unused dependencies and stale packets are removed in the weekly housekeeping review, not left "for later".
