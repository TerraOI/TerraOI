# plan.md — Master Project Initiation & Onboarding File

**Project:** `uav-ops-portal` — UAV/RPAS operations & compliance portal (Inline Group), expanding to GPR survey delivery
**Repo:** `https://github.com/Wei-Inline/IGI-UAV.git` · local root `I:\_IGI-UAV`
**Written:** 2026-11-04 (analysis verified against the tree, not against stale docs — see §2 and §23)
**Audience:** every human who joins this project, and the AI agent that works beside them.

---

## 0. How to use this file

This is the single entry point: what the project is, how it is built, how it is delivered, what is true **right now**, and what to do next. Read §0–§2 fully before touching anything; skim the rest on demand.

**Document precedence (do not fight about this):**

| Question | Authoritative source |
|---|---|
| What is this project, how does it work, how do we work? | **this file** (`plan.md`) |
| What are we building next, track-by-track state, decision log `D-nn`, task ids | [proj-plan.md](proj-plan.md) (its own rule: “when this file and a design doc disagree, this file wins for *what are we building next*”) |
| Compliance module spec and status | [COMPLIANCE.md](COMPLIANCE.md) over [docs/sky-lounge-rpas-compliance-plan.md](docs/sky-lounge-rpas-compliance-plan.md) |
| Deferred backlog | [DEFERRED.md](DEFERRED.md) |
| Platform/dependency/retrieval reasoning | the design docs in `docs/` — kept as the *reasoning trail* even where superseded (see §23 staleness table) |
| The database's meaning | the SQL in [supabase/migrations/](supabase/migrations/) and its `comment on` statements — **the schema is the source of truth**, docs and comments are its documentation |

**If you are an AI agent — read first (condensed from AGENTS.md + house rules):**

1. `AGENTS.md` says it bluntly: **this is NOT the Next.js you know.** This is Next 16.4.4 with breaking changes vs common training data (file-convention `proxy.ts` instead of `middleware.ts`, async `params`/`headers()`, AI-SDK-era APIs). Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code.
2. Never edit an **applied** migration. New decision = new migration file, sorting after `20261101000002`.
3. Never add `organisation_id` filters or values in application code where RLS owns tenancy (the exceptions are the hand-scoped service-role call sites — see §9.3).
4. Do not “fix” regulatory citations from summaries. `docs/cloudflare-migration.md`'s sister defect (§17): several seeded `car_reference` strings are dead 2019-era numbers. Read the regulation text first (Track R).
5. Run gates before claiming anything: `npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build`. They were green at the time of writing (§2).
6. Conventions are load-bearing comments. Before restructuring a file, read its doc-comment — half of them record a defect the current shape exists to prevent.

---

## 1. Project identity

| Field | Value |
|---|---|
| Package | `uav-ops-portal`, v0.1.0, private |
| Domain | Remotely piloted aircraft systems (RPAS/drone) **operations + compliance recording**, regulated under **Transport Canada CARs Part IX** (SOR/96-433 as amended by SOR/2025-70); users sit in **New Zealand**, privacy posture PIPEDA-flavoured (restricted personal data + read log) |
| Second domain (planned) | **GPR** (ground-penetrating radar) survey delivery: equipment, jobs, datasets/lineage, QC, estimates — see §18 |
| Product shape | Multi-tenant SaaS portal; **Inline Group** is tenant one (`slug inline-group`); other operators are provisioned by a platform admin who “can do nothing else” |
| Brand lineage | started as “Sky Lounge” (`docs/sky-lounge-rpas-compliance-plan.md`, host `uav-lounge.vercel.app`, Vercel team `sky-lounge`, Supabase `project_id = Sky_Lounge`); rebranded to Inline Group in commits `2a0dc29`/`03f93c4`; repo now `_IGI-UAV` |
| Stack, one line | **Next.js 16 App Router + Supabase (Postgres/RLS/Auth/Storage) + Tailwind v4 + shadcn-on-Base-UI**, deployed on **Vercel today**, moving to **Cloudflare Workers (OpenNext)** with Supabase kept (§12) |
| Planned AI layer | two in-portal **expert agents** (UAV Compliance, GPR) over a **pgvector RAG corpus inside the same Postgres** — design exists, zero code (§18) |
| Standing disclaimer (COMPLIANCE.md) | “This module records compliance. It is not a determination that you are compliant.” Every compliance answer ends with a named human decision. |

**Git reality:** 69 commits, **zero merges, zero tags**, authors `wyuinline` (62) → `Wei-Inline` (7). Remote `origin`. The Phase-1–5 parity roadmap and gap analysis are **external claude.ai artifacts** (ids `958f6078-…`, `7b0535ca-…`) not in the repo; the local trace of the phases is the commit prefixes `Phase N: …` and [DEFERRED.md](DEFERRED.md).

---

## 2. Current state board — verified 2026-11-04 against the working tree

This section overrides anything in older docs (their staleness is tabulated in §23).

**Branch & worktree:**

| Fact | Value |
|---|---|
| Checked-out branch | **`cloudflare-prep`** at `8d03f98` — byte-identical to `dev`; **contains no commits of its own**; no upstream |
| `dev` | `8d03f98` (2026-10-02 13:41) |
| `main` | `af47958`, four commits behind `dev` |
| Nothing committed since | **2026-10-02** — while the working tree holds the entire 2026-11-01/02/03 program |
| Dirty tree | **77 entries**: 34 tracked files modified (**+18,712 / −11,364**), 43 untracked paths (some directories): all seven new `docs/`, `proj-plan.md`, `research-llm-gateway-workers-2026-11-02.md`, `.github/`, `workers/`, `tools/`, `wrangler*.jsonc`, `open-next.config.ts`, `public/_headers`, `src/test/`, new src areas (credential/declaration screens, `throttle.ts`, `request-notices.ts`), **4 new migrations** |

**Gate results run on this tree on 2026-11-04 (local, Windows, Node 24):**

| Gate | Result |
|---|---|
| `npm test` (vitest) | ✅ **36 files / 694 tests passed** in ~11 s |
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ clean |
| `npm run build` | ✅ per docs (2026-11-02; 32 static generations, route manifest unchanged) |

**Database state:** 54 migration files on disk; **50 applied to the hosted project, 4 NOT applied**:
`20261002170000_project_uav_lead.sql`, `20261101000000_front_door_one_operation.sql`, `20261101000001_processing_task_throttle.sql`, `20261101000002_project_lead_tenancy.sql` — “written to be run on a live database, and they have never been run at all”. Until pushed, the hosted project lacks the throttle trigger, front-door scoping, and the two composite-FK fixes. `src/lib/database.types.ts` is **one migration behind** (missing `front_door_org_id()`, `throttle_salt()`).

**P0 hygiene status (proj-plan §10), re-scored against the tree:**

| Task | Status |
|---|---|
| P0-1 commit the tree | **not done** — the biggest single risk: no rollback point, no CI evidence for ~3 weeks of work |
| P0-2 track `package-lock.json` | **done** (docs saying otherwise are stale) |
| P0-3 apply the 4 pending migrations | **not done** (needs `alter role authenticator set app.throttle_salt = …` matching `REQUEST_THROTTLE_SALT`) |
| P0-4 set `SUPABASE_SECRET_KEY`, `REQUEST_THROTTLE_SALT` on the platform | **not done** |
| P0-5 regenerate `database.types.ts` in CI, fail on drift | **not done** (proposed in `docs/tech-stack.md` §4) |
| P0-6 rotate the Supabase DB password (was pasted into a chat 2026-08-17) | **not done — treat as exposed** |
| P0-7 click credential/declaration screens against live DB | **not done** |
| CI workflow exists | ✅ on disk (`.github/workflows/ci.yml`) — but **untracked**, so CI has never actually run |

**Next three things, in order** (proj-plan §15, still correct, endorsed):

1. **P0-1** split the tree into reviewable commits (dependency bump + lockfile; the four platform-neutral fixes with their tests; the platform rig; the docs; then P0-3 the migrations) — this also turns CI on.
2. **R-01 → R-02** the `car_citations` authority table + the citation re-baseline — “the highest-value work in the plan, because it fixes a live defect *and* it is what makes any agent answer citable”.
3. **M-01 → M-04** the corpus schema + `search_corpus` (with `hnsw.iterative_scan`, D-21), seeded from CARs Part IX only.
   Hard rule: **nothing that talks to an operator comes before C0 (certificate cutover) and R-02.**

---

## 3. Product definition

**What it is.** A system of record for one drone operation: fleet and components, batteries, pilots and their Transport Canada credentials/training/competencies, flight requests/logs/telemetry/weather, maintenance with three-clock inspection plans, safety (incidents, hazards, audits, findings), documents + numbered operations manuals, checklists, projects/clients, a public processing-task intake form, notifications, per-tenant users and a role×area×level permission matrix, a read API and outbound webhooks, and a printable regulator-facing report suite including a 9-section **RPOC evidence pack**. Each operator is white-labelled inside the portal — its own name, legal name, logo and accent colour (§8.5).

**The product thesis** (from the compliance plan): a flight happens only when **three independent gates** all pass for the *specific aircraft and operation type*:

- **Gate A — credentials:** TC certificate level + recency (Basic/Advanced/L1C ladder, 24-month currency).
- **Gate B — company authorisation:** operations the pilot is authorised for (CAR 901.219 family).
- **Gate C — type competency:** airframe / payload / GCS / RTK / software sign-offs.

`evaluateReadiness()` ([src/lib/readiness.ts](src/lib/readiness.ts), 533 lines, 43 tests) evaluates **11 predicates** across the three gates plus the aircraft, never short-circuits, and returns `{predicate, gate, pass, reason, carReference, remediation, severity}` with `blocking` kept apart from `advisory`. Wired since 2026-10-02 into flight-request **submission, approval, and logging** — the first blocking reason refuses the write.

**Users/roles (DB enum `user_role`, 6):** `system_admin` (owns accounts+matrix), `uav_admin` (runs the programme), `uav_lead` (flying + airworthiness), `auditor` (reads the record, raises findings), `pilot` (own credentials, files own reports), `read_only`. Plus the human vocabulary from the compliance plan (Accountable Executive, Chief Pilot, PRM, Training Pilot, VO) mapped onto roles, and the **platform administrator** (`profiles.is_platform_admin`, grants *no* access to any organisation's operational data).

**Permission model (both app and RLS read the same table):** `access_area` **16 values** — `fleet, maintenance, pilots, training, requests, logs, incidents, audits, docs_general, docs_restricted, roc_a, notifications, users, permissions, processing_tasks, personal_data` — × `access_level` **5 values** — `full, create, read, own, none`. Adding an area in a migration surfaces as a compile error in [src/lib/access.ts](src/lib/access.ts) — intended wiring.

**Deliberate design stances** (recurring in code comments — respect them):
- “hiding a button was never the access control” — every server action re-checks;
- “the matrix is the access control, not a picture of it”;
- “a safety system that gates reporting by seniority does not get told about problems” — incident reporting is the widest area (pilots and read-only hold `incidents: create`, anonymous reports allowed);
- “a report that quietly stops short reads as a complete record” — truncation is always announced;
- “never store time-derived state” — expiry/overdue/currency derived at read ([src/lib/compliance.ts](src/lib/compliance.ts));
- “a certificate is not a competency.”

---

## 4. Tech stack

### 4.1 Runtime & frameworks (measured from [package.json](package.json))

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js 16.4.4** (exact pin), App Router in `src/`, `src/proxy.ts` as the edge guard | 16.4.4 clears the OpenNext peer floor `>=16.4.1`; AMP removed upstream — nothing used it. AGENTS.md warning applies: this Next ≠ old Next. |
| UI | **React 19.3.1 / react-dom 19.3.1** (exact pins) | Server Components default; 64 of 126 `.tsx` carry `"use client"` |
| Styling | **Tailwind CSS v4** (CSS-first; no JS config), `tw-animate-css` | 130 custom properties in [src/app/globals.css](src/app/globals.css); `@media print` block; `print:` variants ×13 |
| Components | **shadcn over Base UI** (`@base-ui/react` ^1.9.0 — *not Radix*); `components.json` style `base-nova` | Base UI idioms: `render={...}` not `asChild`; [src/components/portal/option-select.tsx](src/components/portal/option-select.tsx) exists because Base UI `SelectValue` renders the raw value |
| Charts | recharts (analytics page only) | heaviest client dep, deliberately confined |
| Feedback | sonner (toasts, 161 call sites), next-themes | dark mode tokens exist but theme toggle is unreachable/never verified (DEFERRED #14) |
| Data | **Supabase**: `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.118.0; PostgREST **v14.18**, GoTrue **v2.197.0**, **Postgres 17** hosted `AWS us-west-2` | call sites: ~286 `.from()`, 8 `.rpc()`, 18 `.storage` |
| Types | **TypeScript ^5** (5.9.3; 7.0.2 blocked — see §4.3), strict mode; `database.types.ts` **generated**, never authored | |
| Tests | **Vitest 4.1.11** (node env default; jsdom opt-in per file via docblock), @testing-library/react + user-event, jsdom 30, coverage-v8 | [vitest.config.mts](vitest.config.mts): alias `server-only` → [src/test/server-only-stub.ts](src/test/server-only-stub.ts) |
| Lint | ESLint 9 flat config, modular `eslint-config-next/core-web-vitals` + `/typescript` | [eslint.config.mjs](eslint.config.mjs): `globalIgnores` must restate defaults + adds `.open-next/**`, `.wrangler/**` (flat config ignores no `.gitignore`) |
| Platform today | **Vercel** (host `uav-lounge.vercel.app`, team `sky-lounge`) + one Vercel Cron (`0 7 * * 3` → `/api/cron/reminders`) | |
| Platform target | **Cloudflare Workers via `@opennextjs/cloudflare` 1.20.15** + `wrangler` 4.156.2 + `workers/` cron companion | Supabase stays; D1 rejected (no RLS) — §12 |
| Email | Resend HTTP API (optional; in-app notifications work without) | |
| Docs mirror | SharePoint via Microsoft Graph, app-only client-credentials, `Sites.Selected` | built, never run against a live tenant (DEFERRED #9) |
| PWA | hand-rolled service worker [public/sw.js](public/sw.js) + manifest + IndexedDB offline queue | no Background Sync (iOS); offline flight-log capture |
| Node | **24** “Krypton” both locally and in CI (`@types/node` ^24 matches). 26 “Lithium” too new; 22 in maintenance to 2027-04-30 | |

### 4.2 Explicitly not touching (docs/tech-stack.md §3, endorsed)

No new framework, no SPA, no separate API tier. **No ORM** (“do not put an ORM between the team and that SQL file”). No self-hosted/external vector DB (retrieval lives inside the same Postgres under the same RLS — D-05, “do not revisit”). No general-purpose chat surface decoupled from the domain. zod is *planned for agent schemas only* — the hand-rolled validators in `action-utils.ts`/`processing-task.ts` stay (they are the product's voice).

### 4.3 Upgrade policy (from [docs/dependency-status.md](docs/dependency-status.md))

- Every step gated: baseline build → bump → `tsc` → `lint` → `test` → `build`. Next bumps live on their own branch, isolated from platform work.
- **Blocked:** TypeScript 5.9.3 → 7.0.2 (`typescript-eslint` peer `<6.1.0` breaks the lint pipeline). **Own branch:** ESLint 9→10 (flat config already ready), Vitest 4→5, **Supabase CLI 2.114 → 3.0 (drives the security model — read release notes, never drive-by)**.
- `npm audit` sits at **62**, but 22 of 24 critical/high trace into the **`vercel` CLI subtree** (dev tooling, not shipped code). Real fix at cutover: `npm uninstall vercel`. Do not chase npm's suggested `vercel@53.2.0` (a downgrade).
- Pin policy: exact pins on `next`/`eslint-config-next`/`react`/`react-dom`; carets elsewhere; `npm ci` in CI; no Renovate/Dependabot configured (decision pending).
- Open policy choice: the workspace's `allow-scripts` suppresses `esbuild` and `unrs-resolver` postinstalls — approve deliberately or accept the warning loudly (§21).

---

## 5. Folder structure (annotated)

```
I:\_IGI-UAV\
├─ AGENTS.md / CLAUDE.md          # agent rules; the Next-16 warning block (auto-rewritten by `next dev`)
├─ README.md                      # still create-next-app boilerplate — rewrite owed (§21 fix list)
├─ plan.md                        # THIS FILE — master initiation/onboarding
├─ proj-plan.md                   # master control file: decision log D-01..D-22, tracks, roadmap (untracked!)
├─ COMPLIANCE.md                  # compliance module spec-vs-shipped status
├─ DEFERRED.md                    # the backlog of truth: cleared / unverified / accepted / needs-hands / deferred-by-decision
├─ research-llm-gateway-workers-2026-11-02.md  # sourced platform facts (move under docs/ at P0-1)
├─ docs/
│   ├─ sky-lounge-rpas-compliance-plan.md      # v1.0 2026-09-03: the regulatory engineering spec (P1..P6 roadmap)
│   ├─ expert-agents-plan.md                   # the two expert agents, delivery order (Phase 0..4)
│   ├─ rag-design.md                           # corpus/pgvector retrieval design (one date in it superseded: §17)
│   ├─ tech-stack.md                           # keep/add/don't-touch audit (pre-D-01 in places)
│   ├─ cloudflare-migration.md                 # 558 L assessment + the 4 mandatory fixes (§4.4) + §4.5 correction
│   ├─ cloudflare-deploy-runbook.md            # exact cutover commands
│   ├─ dependency-status.md                    # 2026-11-02 upgrade pass + advisory picture
│   ├─ architecture-map.html                   # GENERATED by tools/architecture-map.mjs — self-contained code map
│   └─ plan.html                               # GENERATED by tools/plan-html.mjs — interactive viewer for this file
├─ package.json / package-lock.json / package scripts (§11)
├─ next.config.ts                 # empty config + initOpenNextCloudflareForDev() appended after export
├─ open-next.config.ts            # R2 incremental cache
├─ wrangler.jsonc                 # APP worker `uav-ops-portal` (deliberately NO triggers — see §12.3)
├─ wrangler.cron.jsonc            # CRON worker `uav-ops-portal-cron`, 0 7 * * 3 UTC
├─ vercel.json                    # framework + the one cron (deleted at cutover)
├─ vitest.config.mts / tsconfig.json (excludes workers/) / eslint.config.mjs / postcss.config.mjs / components.json
├─ .env.local(.example)           # app env; secrets never committed. .dev.vars(.example) = Worker env for wrangler dev
├─ .github/workflows/ci.yml       # install→lint→tsc→tsc-workers→test→build (untracked until P0-1!)
├─ .claude/launch.json            # ⚠ stale: runtimeExecutable points at old path I:\_Sky Lounge\dev.cmd — repoint at repo dev.cmd
├─ dev.cmd                        # Windows launch wrapper (PATH + npm run dev)
├─ public/                        # sw.js, manifest.webmanifest, icon/branding svgs, _headers (CF asset caching)
├─ src/
│   ├─ proxy.ts                   # Next-16 proxy (was middleware.ts): matcher + delegates to lib/supabase/middleware
│   ├─ test/server-only-stub.ts   # test shim so component tests survive `import "server-only"`
│   ├─ app/
│   │   ├─ layout.tsx / globals.css / favicon.ico / offline/
│   │   ├─ (public)/              # / landing (landing_counts rpc), tasks/new public intake form
│   │   ├─ login/ · auth/confirm/ · auth/update-password/
│   │   ├─ (portal)/              # 26 screens + actions; see §8 route map
│   │   └─ api/                   # v1 (index+[resource]), reports/[report] (CSV), cron/reminders (the job)
│   ├─ components/
│   │   ├─ ui/                    # 17 shadcn-over-Base-UI primitives
│   │   └─ portal/                # 74 files: per-feature tables/dialogs (admin, analytics, audits, checklists,
│   │                             #   documents, fleet, flights, hazards, incidents, maintenance, pilots,
│   │                             #   platform, profile, projects, reports, training) + shell pieces
│   └─ lib/                       # 47 modules + 22 test files + generated database.types.ts — the rules live here (§8.3)
├─ supabase/
│   ├─ config.toml                # local stack config (project_id Sky_Lounge; auto_expose_new_tables OFF; pgdelta on)
│   ├─ migrations/                # 54 plain-SQL files, 20260817000000 → 20261101000002 (4 of them unapplied)
│   ├─ one-off/                   # NOT-migrations (reset script); never replayed by db push
│   └─ .temp/                     # CLI link state: project ref, versions, pooler URL — machine-written, don't edit
├─ workers/cron-reminders.ts      # Cloudflare Cron companion worker (sessionless scheduler → fetches the app route)
├─ tools/architecture-map.mjs     # node tools/architecture-map.mjs → docs/architecture-map.html (onboarding map)
├─ tools/plan-html.mjs            # node tools/plan-html.mjs → docs/plan.html (searchable/collapsible plan viewer)
└─ node_modules/ .next/ .open-next/ .wrangler/   # generated, gitignored (and eslint-ignored)
```

Regenerate the visual map after big changes: `node tools/architecture-map.mjs` (self-contained HTML; searchable file tree by layer, per-migration table/policy counts, tested badges).

---

## 6. Architecture — how a request flows

```
browser ──▶ edge guard src/proxy.ts ──▶ App Router pages (RSC) ──▶ server actions ("use server")
              │ session refresh via          │ getAccess() (react.cache)          │ re-check permission,
              │ @supabase/ssr; exact-set      │ then explicit-column queries        │ run write, revalidatePath
              │ exemptions; /api/* passes ────┴── reads through PostgREST ──────────┴──▶ Supabase Postgres
              │ (routes self-authorize)                                          RLS: owns_row AND can_*
              ▼                                                                  views are security_invoker
   /login, /, /tasks/new, /offline, /sw.js, /manifest.webmanifest, /icon.svg, /auth/confirm are the
   only unauthenticated paths. API keys (not people) authenticate /api/v1/*; CRON_SECRET the /api/cron route.
```

**The load-bearing invariants (all measured in the code):**

1. **Tenancy is Postgres's job, everywhere except 10 listed service-role call sites in 8 files** (`createAdminClient` in [src/lib/supabase/admin.ts](src/lib/supabase/admin.ts) imports `server-only`, so a browser-reachable import fails the build). Pages never filter by `organisation_id`; tenancy comes from RLS + DB defaults + `with check`.
2. **Authorisation has two doors that must agree:** RLS policies (hard) and `getAccess()`-driven action gates (intent + message quality). A page may render and toggle; **an action always re-checks**.
3. **The readiness gate is authoritative for flight decisions** — nothing an agent produces ever enters `evaluateReadiness` inputs (§18).
4. **Pure engines in `src/lib`, impure loaders beside them** — the dominant pattern and the reason 694 tests run in 11 s without a database.
5. **Platform-neutral right now:** the four Cloudflare fixes (§12.4) were made while still on Vercel, deliberately.

### 6.1 Decision log (proj-plan D-nn, condensed; supersede in place, never renumber)

| # | Decision |
|---|---|
| D-01 | Compute → Cloudflare Workers; **Supabase stays** (Postgres+RLS+Auth+Storage). Cloudflare cannot replace Supabase here: D1 has no RLS — and the RLS model *is* the security model. |
| D-02 | Cost-first rotating LLM gateway `src/lib/ai/llm.ts`: T0 local model (Cloudflare Tunnel + Access service token) → T1 DeepSeek → T2/T3 OpenRouter; **task classes**, not model names (`route/extract/embed-query/rerank/compose/verify/draft`); tests never call a provider. |
| D-03 | Both experts in parallel (UAV + GPR) on one shared platform — mitigated by corpus-only gating for GPR until `gpr_*` exists. |
| D-05 | Retrieval stays in Postgres: **pgvector, no external vector DB** (same RLS as cited records). Do not revisit. |
| D-06 | Embeddings fixed at **1024 dims** (HNSW `vector` caps at 2,000; halfvec 4,000). |
| D-07 | Long agent runs → **Cloudflare Queues (+ Workflows)**, consumer keeps the existing cron contract (fail-closed bearer, sharded, counts-only). Supersedes Vercel Workflow/Inngest/QStash. |
| D-08 | Embedding model is part of index identity (`embedding_model`, `embedding_dims`); model change = rebuild, never a mixed index. |
| D-09 | **No feature-flag system.** Gating = one env secret (`AGENT_ALLOWED_ORGS`) + per-tenant `agent_settings`. `src/lib/flags.ts` = attention flags; do not extend it. |
| D-10 | Documents/certificates/telemetry stay in Supabase Storage; **R2 only for the GPR raw-data lake**, URLs minted by an RLS-checked action. |
| D-11 | **One tool call = one DB round trip** (Workers allow **6 simultaneous outgoing connections/invocation** — today `loadReadiness` fans 10+ and dashboard ~15; P1-4 collapses them into RPCs). |
| D-12 | Verifier runs on a **different tier than the generator** for requirement claims; same-model self-approval is not allowed. |
| D-13 | Re-baseline every `car_reference` to post-SOR/2025-70 Part IX → **Track R**. |
| D-14 | Corpus source = consolidated CRFS text (laws-lois XML/pages), chunked Part→Subpart→Division→section→subsection→paragraph. |
| D-15 | Quarantine unsourced claims (`verify_state='unverified'`), including some inside the design docs themselves. |
| D-16 | Retention floors from the CARs (12 mo most, **24 mo registration/maintenance**, declarations 2 y past manufacture/notice) — the flat 12-month maintenance retention **under-shoots** (M-18). |
| D-17 | Embeddings + rerank via **Workers AI `env.AI` binding** (bge-m3 1024-dim $0.0118/M; bge-reranker-base $0.00311/M) — consumes none of the six connections. |
| D-18 | Cloudflare AI Gateway in front of T1/T2 for spend caps/routing/accounting — **not caching** (RAG hit rate ≈ 0). |
| D-19 | **AI SDK 7** target: `output: Output.object({schema})`; `generateObject`/`streamObject` no longer exist; DeepSeek is `json_object`-only ⇒ per-tier validate-and-repair. |
| D-20 | Byte-stable prompt prefix; cache economics (~50× cache-hit discount, peak 2× off-peak) are a design input. |
| D-21 | `hnsw.iterative_scan` must be set **inside `search_corpus`** — HNSW under an RLS filter silently under-returns otherwise. |
| D-22 | **Agent tool calls run in-request under the caller's session** (a Queue consumer has no JWT ⇒ `current_org_id()` null). Queues carry only session-free work over payloads re-validated by id. |

---

## 7. Backend data layer (Supabase Postgres)

### 7.1 Measured counts

| Object | Count |
|---|---|
| Migrations | **54** (2026-08-17 → 2026-11-01; 50 applied, 4 pending) |
| Tables (`public`) | **57**, all RLS-enabled |
| Views | **13 live**, all `with (security_invoker = true)` (cloudflare-migration.md's “32 views / 58 functions” counts *statements*, not objects) |
| Functions | **39 distinct** (58 creations; 43 `security definer`; 16 RPC-reachable in types) |
| Triggers | ~20 + 1 constraint trigger; generated columns: 2 |
| Policies | **226 `create policy`** statements (+120 drop) |
| Enum types | 48; `comment on …` 70; composite-FK adds: 64 |
| Storage buckets | **11** (10 private + public `organisation-logos`) |
| No extensions yet | pgvector will be the **first** `create extension`; no tsvector/FTS index yet; single GIN today (`notifications.target_roles`) |

### 7.2 Table inventory by domain (57)

| Domain | Tables |
|---|---|
| Org/tenancy/identity (5) | `organisations` (+`slug`, `rpoc_number`, `front_door`), `profiles` (8 cols, `is_platform_admin`), `role_permissions`, `role_permission_defaults`, `document_review_defaults` |
| Fleet (4) | `uavs` (27 cols; `flight_hours`/`battery_cycles` **deleted as stale liars** — now derived; `remote_id_*` fields built-but-never-gated), `components`, `component_installations`, `uav_inspection_plans` |
| Batteries (2) | `batteries`, `flight_battery_usage` |
| Maintenance (3) | `maintenance_records`, `inspection_plans`, `inspection_plan_items` |
| Pilots/credentials (11) | `pilots` (22 cols), `pilot_personal_data`, `personal_data_access_log`, `pilot_certificates` (**no expiry column, deliberately**), `pilot_exams`, `flight_reviews`, `ground_school_records`, `recency_records` (+24 mo generated `expires_on`), `foreign_qualifications` (zero credit, stated in a comment), `pilot_authorisations`, `type_competencies` |
| Training (5) | `training_records`, `training_modules` (16 seeded/operator from AC 901-002 App. A §11), `training_completions` (evaluator ≠ deliverer columns), `training_effectiveness_reviews` (annual 901.219(2)(c) as its own object), `training_module_defaults` |
| Flight ops (7) | `flight_requests`, `flight_logs` (append-only by trigger; `effective_duration_minutes` generated), `flight_crew`, `checklist_templates`, `checklist_items`, `checklist_completions` (one stored derivation: `all_critical_passed`), `checklist_responses` |
| Clients/intake (3) | `clients`, `projects`, `processing_tasks` (public intake; DB-side throttle) |
| Safety (6) | `incidents`, `hazards` (inherent+residual risk pairs), `hazard_incidents`, `audits`, `audit_findings`, `regulatory_watch` |
| Documents/manuals (4) | `documents` (21 cols incl. SharePoint mirror fields), `document_review_policy`, `manuals`, `manual_sections` (section numbers **derived from position**, never stored) |
| Declarations (2) | `declaration_requirements` (8 seeded rows — to be re-derived from Standard 922 Table 1, M-17), `aircraft_declarations` |
| Notifications (2) | `notifications` (19 `notification_kind`, unique `dedupe_key`, GIN target_roles), `notification_reads` |
| Integrations (3) | `api_keys` (SHA-256 `key_hash`, scopes = `access_area[]`, soft revoke), `webhooks` (https-only, 9 `webhook_event`), `webhook_deliveries` |

### 7.3 Tenancy model (the house idiom — copy it, don't invent)

- One database; **every table carries `organisation_id uuid not null default public.current_org_id() references organisations(id) on delete restrict`** + `<table>_id_org_key` unique + `<table>_org_idx` (“every policy filters on this column, so every table needs the index”).
- **Composite FKs** `foreign key (child, organisation_id) references parent (id, organisation_id)`: RLS stops cross-tenant *reads*, composite FKs stop cross-tenant *writes*. Column-list `on delete set null (col)` so a departing user nulls the person, never the org.
- Helpers: `current_org_id()` (definer, stable, “and active” since `20261002000000`), `owns_row(p_org)` (invoker by omission; **null org matches nothing — fails closed**), `is_platform_admin()`, `storage_path_org()/storage_path_owns()`.
- **No platform-admin bypass in domain RLS, ever.** Provisioning crosses the line exactly once: `provision_organisation(...)` (definer, checks `is_platform_admin()`, copies default permission/review rows).
- The public front door belongs to **one** organisation: `front_door_org_id()` behind a unique **partial index** (`organisations_one_front_door_uq`); the anonymous-insert trigger *overwrites* `organisation_id` rather than accepting one.

### 7.4 RLS strategy

- Policies = `public.owns_row(organisation_id) AND <permission check via the can_* ladder>`. The ladder (`access_level_for → can_read_all / can_read_own / can_create / can_manage`) is `sql stable security definer set search_path = public` — STABLE so Postgres evaluates once per statement, DEFINER so reading the matrix isn't blocked by its own policy.
- Notifications: **no insert/update policy at all** — only the service-role cron writes them (“no policy means no user can forge a reminder”). Organisations: **no delete policy** by design.
- Lockout guards: `keep_one_user_manager` as a **deferrable constraint trigger** (every active org must keep `full` on users *and* permissions); `enforce_role_change_is_admin_only` blocks self-role-change and session changes to `is_platform_admin/active/organisation_id/email`.
- Personal data (PIPEDA-shaped): `read_pilot_personal_data()` is a definer RPC and the **only writer** of `personal_data_access_log`; every role defaults to `none` except `system_admin`.
- Privilege hygiene: every security-definer function gets `revoke all … from public, anon, authenticated;` + narrow grants. **“Security-definer functions are not public RPCs.”**
- Throttle trigger `enforce_processing_task_throttle()`: two `pg_advisory_xact_lock`s in a fixed order, ceilings **5/15 min per day-rotated address key, 3/h per email, duplicate job inside 10 min**, all signalled as SQLSTATE **`P0002`** (the app prints the message verbatim); `throttle_salt()` reads `app.throttle_salt` set via `alter role authenticator set …` so the secret never enters the repo.
- JWT claims are **not** used in policies (the `custom_access_token` hook is commented out); everything resolves through definer helpers over `auth.uid()`.

### 7.5 Storage

Buckets: `sops, policies, flight-manuals, maintenance-manuals, regulatory-documents, incident-reports, training-materials, safety-documents, roc-a-certificates, flight-telemetry` + public `organisation-logos`. **Tenancy in storage = the first path segment** (`<org-uuid>/…`), built only by [src/lib/storage-paths.ts](src/lib/storage-paths.ts), enforced by `storage_path_owns(name)` policies (“a path is guessable in a way a row is not”). Downloads: 60-second signed URLs minted server-side.

### 7.6 Migration house rules (violating these is a review reject)

1. Plain SQL in `supabase/migrations/`, `YYYYMMDDHHMMSS_topic.sql`; `if not exists` idempotency everywhere; non-replayable scripts go in `supabase/one-off/`; **no `seed.sql`** (config points at a missing file — all seeding lives in migrations, per-tenant defaults retro-seeded via `cross join organisations … on conflict do nothing`).
2. Never edit an applied migration; **enum value additions need their own file** (Postgres forbids using a new value in its adding transaction — precedent `20260826000001/2`); tenancy-style work splits columns → constraints → policies.
3. Views are **wrapped, not rewritten** (a `create or replace view` cannot reorder columns; service-role callers read through them).
4. Closed workflow vocabulary → enum; regulatory/observational vocabulary → `text` + named `check` (so re-baselining data, not types, stays possible).
5. Retention = `prune_*` definer functions called from the reminders route (no new scheduler). Append-only = absence of update/delete policies + a guard trigger + a comment.
6. Comments are documentation, in the file *and* via `comment on`. Errcodes are chosen for the app (`P0002`, `check_violation`, `insufficient_privilege`).
7. Regenerate types after every migration: `npx supabase gen types typescript` → `src/lib/database.types.ts` (P0-5 wants CI to fail on drift).

---

## 8. Application layer (Next.js app)

Scale: **31 `page.tsx` + 5 `route.ts`**, 32 `"use server"` files exporting **99 server actions**, `src/components` 91 `.tsx` (17 `ui/` + 74 `portal/` incl. tests), `src/lib` 47 modules.

### 8.1 Route map

| URL | Auth | Purpose |
|---|---|---|
| `/` | public | front door: dashboard-first landing with `landing_counts()` scoped to the front-door org; signed-in → 307 `/dashboard` |
| `/tasks/new` | public | aerial-processing request form (allowed email domains = `inlinegroupinc.ca` today; DB throttle; abuse keys salted, hashed, pruned at 30 d) |
| `/login` | public | password sign-in (one control), forgot-password (`requestPasswordReset` never reveals account existence) |
| `/auth/confirm` | public | invite/reset OTP landing, open-redirect guard on `?next=` |
| `/auth/update-password` | token | `MIN_LENGTH = 10` |
| `/offline` | public | navigation fallback for the service worker |
| `/dashboard` | session+active profile | metrics, dock grid, todo rollup (`buildTodoList`), quick actions |
| `/fleet` · `/fleet/declarations` | session (+area gates) | UAVs/batteries/components + import dialogs; **CAR 901.69 declaration-coverage matrix** per airframe × operation |
| `/pilots` · `/pilots/[pilot]` | session | crew registry; per-pilot Gate A panels (certificates+verification step, recency, training, competencies) |
| `/flights` | session | requests + logs + telemetry track plots (`TRACK_POINTS = 400`) + METAR weather lookup; **the compliance refusals run at submission *and* approval *and* logging** |
| `/projects` | session (`canManage("requests")`) | clients + projects, hours/cost rollup |
| `/audits` · `/incidents` · `/hazards` | session | findings; safety occurrences (widest area); hazard register + 5×5 risk matrix |
| `/maintenance` · `/checklists` | session | records + **three-clock inspection plans** (hours/cycles/calendar) with `inspection_plan_status` grounding; template builder + signed completions |
| `/training` · `/documents` · `/documents/manuals/[id]` | session; manuals hard-gate `canReadAll("docs_general")` | certifications; document control with review cycles; numbered manual editor (printable) |
| `/analytics` | session (no area gate; RLS + `WINDOW_MONTHS=24`, `ROW_CAP=5000` announced) | recharts trends, denominators labelled |
| `/reports` · `/reports/[report]` · `/reports/rpoc` | session; each report `canReadAll(def.area)`; RPOC needs **four** areas | 5 report defs + printable 9-section RPOC evidence pack with `gaps[]`/`partial[]`; CSV at `/api/reports/[report]` |
| `/notifications` · `/profile` | session; RLS-scoped | inbox (role-targeted + own); own name only (role deliberately absent — DB-backed) |
| `/admin/users` · `/admin/permissions` · `/admin/organisation` · `/admin/integrations` | hard redirects on missing `canManage` | invites/roles/last-admin guards; the ××× matrix editor; branding (hex-validated accent); API keys/webhooks/SharePoint check |
| `/platform` | hard: `isPlatformAdmin` | cross-tenant provisioning (`provision_organisation` RPC on the caller's session — not the service role), invite first admin, activate; **no delete** |
| `GET /api/v1` + `GET /api/v1/[resource]` | **API key** | 9 read-only resources, explicit column lists (never `*`), JSON/CSV, paged (limit ≤ 500), hand-scoped by `organisation_id` because service role has no RLS |
| `GET /api/cron/reminders` | **Bearer `CRON_SECRET`**, fails closed | the weekly multi-tenant scan (§15) |

### 8.2 Server action conventions

- Shape: `{ error: string | null, ...extras }` — never `throw`, never `redirect` (except `signOut`); end with `revalidatePath(...)`.
- Gate helpers (`requireAdmin`, `requireFleetManager`, `requireSafetyManager`, …) map each action to its permission area; deliberately **ungated actions rely on RLS + `safeErrorMessage(42501)`** (audits, incidents, log maintenance, training uploads, own profile, filing a flight request — whose refusals come from the compliance engines, not an area gate).
- **Separation of duties** ([src/app/(portal)/pilots/record-guards.ts](src/app/(portal)/pilots/record-guards.ts)): nobody certifies/verifies their own records; the refusal `SELF_RECORD_REFUSAL` is reused at 6 sites and must reproduce in future agent drafts.
- Client side: `useTransition` + `sonner` toast on the result; confirm flow via `useConfirm` in [src/components/portal/confirm-dialog.tsx](src/components/portal/confirm-dialog.tsx); page shells = async RSC → `Promise.all([getAccess(), …explicit-column queries])` → `HeroBand` + `MetricTile` + tables.
- `"use server"` files may only export async functions — constants live in `lib/manual-constants.ts`, `lib/slug.ts`, etc.
- `after()` (Next) for must-not-fail side work (SharePoint mirror); `notify()` for the 9 webhook events.

### 8.3 `src/lib` module index (the rules of the product live here)

**Compliance engines (pure, heavily tested):** `readiness.ts` (533) · `declarations.ts` (901.69 matrix, 8 ops) · `compliance.ts` (derived expiry/currency; `DUE_SOON_DAYS=60`, `RECENCY_MONTHS=24`) · `operations.ts` (8 operation types; missing vs lapsed) · `inspection-plans.ts` (three clocks, grounding items) · `risk.ts` (5×5 bands ≥15/≥9/≥4) · `flags.ts` (361; attention flags, 14-day lead) · `todo.ts` · `reminders.ts` (621; pure scanners, thresholds `[60,30,7]` days / `[25,10,5]` hours, dedupe keys) · `weather.ts` (METAR parse) · `select-options.ts`, `review-cycles.ts`, `document-categories.ts`.

**Security/integrations:** `permissions.ts` (`getAccess = cache(...)`) · `access.ts` (client-safe vocabulary) · `api-keys.ts` (`uavops_` prefix, SHA-256 — justified: full-entropy random, no bcrypt cost per request) · `api-auth.ts` · `api-resources.ts` (the 9-resource table: adding an endpoint is data, not code) · `webhooks.ts` (HMAC `timestamp.body`; `isBlockedWebhookHost` blocks loopback/RFC1918/CGNAT/cloud-metadata/.local incl. IPv6 + IPv4-mapped) · `webhook-dispatch.ts` (`dns.resolve4/6` — Workers-ready; 8 s timeout, ≤3 redirects, SSRF re-check per hop) · `throttle.ts` (address keys only; limits are DB-side) · `email.ts` (Resend, optional by design, never throws) · `request-notices.ts` · `sharepoint.ts`/`sharepoint-client.ts` (chunked upload plan, `NEVER_MIRRORED = regulatory, incident_report, roc_a`) · `storage-paths.ts` · `auth-urls.ts` (single site-origin resolution: `NEXT_PUBLIC_SITE_URL` → Vercel host (fallback, warn-once) → localhost) · `branding.ts` (WCAG-safe accent handling) · `action-utils.ts` (`safeErrorMessage` maps 23505/23503/23514/22P02/42501/42P01; hand-rolled validators stay).

**Data/plumbing:** `csv.ts` (**formula-injection guard** — `'` prefix on `= + - @ TAB CR`; BOM+CRLF) · `csv-import.ts` (469; date-format disambiguation, bounded numbers, natural keys, 5,000-row cap) · `import-schemas.ts` (data-not-code schemas for pilots/uavs/batteries/components) · `telemetry.ts` (544; CSV-first — DJI ≥v13 is AES-encrypted, Rust/WASM/MQTT rejected for now; 200,000-row cap; haversine + downsample) · `offline-queue.ts` (IndexedDB `sky-lounge-offline`, `MAX_ATTEMPTS=5`, oldest-first partition) · `processing-task.ts` (public-form validation, `todayInEdmonton()`, data-location checks) · `slug.ts` · `dock.ts` (UI magnification math — yes, tested) · `nav-items.ts` (presentation only — “never the access control”).

**Supabase clients:** `supabase/client.ts` browser; `supabase/server.ts` cookie client (setAll in try/catch for RSC); `supabase/middleware.ts` = `updateSession` — **the whole route gate** (23 tests pin it); `supabase/admin.ts` service-role (throws without `SUPABASE_SECRET_KEY`); `supabase/profile.ts`.

### 8.4 PWA / offline

[public/sw.js](public/sw.js): shell cache `sky-lounge-shell-v1`, precache `/offline /icon.svg /manifest.webmanifest`, network-first navigations with `/offline` fallback, cache-first `_next/static`, **never intercepts `/api/` or `/auth/`**. Offline flight logs queue at the dialog (`!navigator.onLine → enqueue`), flushed by one flusher mounted in the portal layout via `useSyncExternalStore(navigator.onLine, server=true)`. `public/_headers` gives `_next/static` immutable caching (for Cloudflare assets).

### 8.5 White-labelling (per-operator branding) — the function exists; know its edge

The portal is **not single-brand**: every tenant renders as itself inside the portal. The whole feature deliberately funnels through one module and one DB row.

**Where the identity lives:** the `organisations` row — `name`, `legal_name`, `slug` (regex `^[a-z0-9][a-z0-9-]{1,62}$`), `rpoc_number`, `logo_path` (uploaded to the **public** `organisation-logos` bucket), `accent_colour` guarded by the DB check `organisations_accent_is_hex` (a CSS-injection guard — it is a constraint, not a UI nicety), and `front_door` (which operator owns the public landing).

**The single choke point is [src/lib/branding.ts](src/lib/branding.ts)** (9 tests): `safeAccent()` accepts only `/^#[0-9a-fA-F]{6}$/` and falls back to `DEFAULT_ACCENT = #c4e86c` — the tests pin refusals of `"#c4e86c; } body { display:none"` and `url(javascript:alert(1))`; `prefersDarkText()` picks ink by WCAG relative luminance (threshold 0.45); `logoUrl()` maps a storage path to its public URL. **Never set brand colours around this module** — bypassing `safeAccent` or the hex check is a security regression, not a styling choice.

**How it reaches the UI:** `getAccess()` ([src/lib/permissions.ts](src/lib/permissions.ts)) carries `{name, legalName, slug, rpocNumber, logoPath, accentColour}`; [src/app/(portal)/layout.tsx](src/app/(portal)/layout.tsx) injects `--brand-lime` as an inline style **per request** (its comment: it varies per operator and per request, so it cannot live in the stylesheet); Tailwind usage is `bg-brand-lime` / `text-brand-ink` everywhere, resolving to that variable; `side-nav.tsx` renders `OrganisationMark` (logo ≤ `max-h-9 max-w-[10rem]`, falling back to the operator name); printed reports and the RPOC pack sign as `legalName ?? name`.

**Who edits it:** `/admin/organisation` (gated `canManage("users")`) — [actions](src/app/(portal)/admin/organisation/actions.ts) `updateOrganisation` (name, legal name, RPOC number, contact, accent) + `uploadLogo`/`removeLogo` (1 MB, png/jpeg/svg/webp); the screen deliberately cannot activate/deactivate its own operator. New tenants get `legal_name` at provisioning (`provision_organisation` RPC, `/platform`).

**Today's honest limits (white-label is portal-scope, not whole-product):** the public landing and `/tasks/new` carry hard-coded “IGI UAV”/Inline Group copy — the landing **counts** are front-door-scoped but the chrome is not; the PWA manifest (`"Inline Group UAV Operations Portal"`, icon, theme colours) is static; email `From:` is one `REMINDER_FROM_EMAIL` (no per-tenant sender or domain); login-page chrome is static; per-operator subdomains are **deferred by decision** (slugs exist, nothing routes on them — §21). Extending white-label = extend `organisations` + `branding.ts` and thread it through the public surfaces; anything else forks the choke point.

---

## 9. Security model (read this before writing any access logic)

1. **Edge guard:** [src/proxy.ts](src/proxy.ts) → `updateSession`: refresh session, then the decision order: `/api/*` passes through (routes self-authorize — a 307 to HTML would break every machine call) → exact-set exemptions (`/offline /sw.js /manifest.webmanifest /icon.svg`) → `/auth/confirm` → signed-in `/login`+`/` → 307 `/dashboard` → anyone else without a session → 307 `/login`. Anonymous allow-list is **exactly** `/`, `/login`, `/tasks/new`. Both the matcher and the set carry comments describing an earlier image-extension bypass — do not reintroduce it.
2. **Three machine auth mechanisms**, all self-contained in their routes: session cookie (`/api/reports/*`), API key (`/api/v1/*`; validity checked **before** scope so a revoked key is never told its scopes; unknown/revoked/expired all 401), shared secret (cron; **fails closed when `CRON_SECRET` is unset**).
3. **Service-role call sites are the only hand-scoped tenancy** (10 sites in 8 files: read API + authenticator, webhook dispatcher, reminders job, platform pages, public form — and soon `tools/ingest`). New ones need a comment in the style of the existing ones.
4. **Personal data** (DOB, work-authorisation) sits in its own table, its own permission area (default `none` for every role but `system_admin`), and every read goes through the logging RPC.
5. **Anti-lockout:** last active admin can't be demoted/deactivated (app + deferrable constraint trigger); you can't strip `permissions: full` from your own role; `caller_profile_active()` RPC signs out deactivated profiles at layout time.
6. **Abuse control:** DB-side throttle on the public form (only rate-limited surface today; `/api/v1` has no limiter — A-08 adds KV counters + per-tenant token budgets before the agent surface). Turnstile planned for form+login at cutover (P1-5).
7. **CSV/report safety:** formula injection neutralised on output; row caps announced via `X-Report-Truncated` headers and printed notes; `refuse()` exists because a dropped query error once turned a broken view into a “spotless empty register”.
8. **Secrets:** build-time `NEXT_PUBLIC_*` vs runtime `wrangler secret put` vs `alter role … set app.throttle_salt`; the Supabase **DB password was exposed in a chat on 2026-08-17 — rotate before layering new credentials** (P0-6).

---

## 10. Environments & configuration

### 10.1 Local development (Windows-first, but see WSL note)

```bat
copy .env.local.example .env.local      &:: fill Supabase URL + publishable key from the dashboard
npm install
npm run dev                             &:: or dev.cmd (PATH-forcing wrapper)
supabase start                          &:: optional local stack (Studio :54323, API :54321, DB :54322)
supabase db reset                       &:: replays supabase/migrations/ + runs one-off separately? NEVER run one-off/
node tools/architecture-map.mjs         &:: regenerate the code map
```

- Hosted Supabase (the one `.env.local` points at): project ref **`rfwcvidrjwlkgvtwnael`** (name `igi-uav`), Postgres 17 in **AWS us-west-2**, pooler `aws-0-us-west-2.pooler.supabase.com:5432`. CLI link state lives in `supabase/.temp/` (machine-written).
- Local `config.toml` quirks to know: `auto_expose_new_tables` left off (new entities not PostgREST-visible until granted — deliberate); seed lane points at a nonexistent `./seed.sql` (inert); email confirmations off locally (invites); MFA off; pgdelta diff engine enabled.
- Cloudflare local rig: copy `.dev.vars.example` → `.dev.vars` (Worker env — *not* the app's `.env.local`); `npm run preview` boots the built Worker in **workerd** (same code path, but **no CPU/subrequest enforcement** — local timings ≠ CPU-ms); `npm run dev:cron` runs the cron worker locally.
- **Platform note:** the OpenNext scaffolder prints “not fully compatible with Windows; WSL recommended”. Builds/serves fine here so far, but treat Linux/WSL as the reference environment for platform work.
- **Sandbox gotcha (encountered 2026-11-04):** under a confined Windows sandbox, `npm test` dies with `spawn EPERM` inside vite's config bundling — that is the sandbox blocking child-process spawn, *not* a project defect. Run tests in a normal shell (or CI), and remember bracketed paths (`(portal)`, `[report]`) need `-LiteralPath` in PowerShell; `src/lib/storage-paths.ts` reads as “binary” to some tools (literal control chars in its `CONTROL` regex) — view it with `Get-Content -Encoding UTF8`.
- `.claude/launch.json` currently points at `I:\_Sky Lounge\dev.cmd` — **stale; repoint at `I:\_IGI-UAV\dev.cmd`** (one-line fix in the P0 list).

### 10.2 Environment variable surface (names only — values never in git or chat)

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | build-time, every env | **set it before any deploy** — unset ⇒ invite/reset emails fall back to localhost (“looks like an auth bug, is a missing variable”); at Workers cutover make it required-at-build |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | build-time | baked at build; a Worker built with them is wired to the live project |
| `SUPABASE_SECRET_KEY` | runtime secret (Vercel now; `wrangler secret put` later) | 10 service-role call sites fail loudly without it |
| `CRON_SECRET` | runtime secret; **same value on app + cron worker** | route fails closed when unset |
| `REQUEST_THROTTLE_SALT` | runtime secret + `alter role authenticator set app.throttle_salt = '<same>'` | unset ⇒ public-constant fallback hashes (limits still hold, reproducibility risk) |
| `TRUSTED_ADDRESS_HEADERS` | config, default `x-real-ip,cf-connecting-ip` | narrow if the origin is ever reachable without the platform |
| `TRUSTED_PROXY_HOPS` | config; unset = strict shared-bucket behaviour | leave unset on Workers |
| `RESEND_API_KEY` / `REMINDER_FROM_EMAIL` | runtime secret / plain var | optional; reminders still record in-app without them |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `SHAREPOINT_SITE_ID` / `SHAREPOINT_DRIVE_ID` | runtime secrets | mirror off without them; ⚠ the deploy runbook currently omits these five — add at cutover |
| `.dev.vars` (worker local): `NEXTJS_ENV`, `CRON_SECRET`, `APP_ORIGIN`, `SHARDS` | local dev only | sample committed as `.dev.vars.example` |

---

## 11. Commands

| Command | What |
|---|---|
| `npm run dev` / `start` / `build` | Next dev server (:3000) / prod serve / `next build` |
| `npm run lint` | bare `eslint` (flat config; ignores generated dirs explicitly) |
| `npx tsc --noEmit` | app typecheck (`workers/` excluded from this project **on purpose**) |
| `npm run typecheck:workers` | second program: Worker types (`@cloudflare/workers-types`, ES2022 lib, no DOM) |
| `npm test` / `test:watch` / `test:coverage` | Vitest run / watch / v8 coverage |
| `npm run preview` / `deploy` / `upload` | `opennextjs-cloudflare build` then `preview` / `deploy` / `upload` (Cloudflare) |
| `npm run deploy:cron` / `dev:cron` | deploy/serve the cron companion worker (`wrangler -c wrangler.cron.jsonc`) |
| `npm run cf-typegen` | generate `cloudflare-env.d.ts` (not yet run — the file is absent) |
| `supabase start` · `supabase stop` · `supabase db reset` · `supabase db push` · `supabase gen types typescript` | local stack + plain-SQL migration flow + type regeneration |
| `node tools/architecture-map.mjs` | regenerate `docs/architecture-map.html` |
| `node tools/plan-html.mjs` | regenerate `docs/plan.html` — the interactive viewer of this file (search, §-section collapse, TOC scroll-spy); re-run after any plan.md edit |
| `npx.cmd wrangler tail` · `wrangler deployments list` · `wrangler r2 bucket create …` | observe/deploy-infra on Cloudflare (human-run, never from an agent session — login flows hang there) |

---

## 12. CI/CD & deployment

### 12.1 CI today ([.github/workflows/ci.yml](.github/workflows/ci.yml))

`push: [dev, main] + pull_request` → ubuntu, 15-min timeout → `setup-node@v4` **node 24** + npm cache → `npm ci --no-audit --no-fund` → **lint → tsc → typecheck:workers → test → build** (build uses placeholder Supabase env; nothing is fetched at build time; the landing page renders em dashes when counts are unavailable — that behaviour is under test). Header comment names the three correctness loci: pure `src/lib` rules, the generated type contract, and the proxy/action authorisation.
**Status:** file exists but is **untracked** — CI has literally never run. P0-1 turns it on. Planned additions (docs/tech-stack §4): `supabase db reset` + generated-types drift-fail; pgTAP/plain-SQL assertions (throttle under concurrency, composite-FK rejection, cross-tenant reads); later Playwright journeys + retrieval regression lane.

### 12.2 Delivery today (Vercel)

Build-time env baked; weekly cron `vercel.json 0 7 * * 3` → `/api/cron/reminders`; `maxDuration = 60`; secrets in Vercel env (⚠ several still unset — §2 P0-4). `main` is the stable line, `dev` the integration line; deploys per push (Vercel preview + prod hosts).

### 12.3 Delivery target (Cloudflare Workers — decision D-01, assessed 2026-11-02, rig built 2026-11-03)

- **Two Workers:** app `uav-ops-portal` (`wrangler.jsonc`: OpenNext output `.open-next/worker.js`, assets, self-service binding for caching, R2 `NEXT_INC_CACHE_R2_BUCKET` = bucket `uav-ops-portal-opennext-cache` — **not yet created** — `IMAGES` binding ⚠ needs an Images subscription or `images: {unoptimized: true}` at cutover (next/image used in exactly one component), `cpu_ms: 120000` (paid), observability on, **deliberately no `triggers`**); cron `uav-ops-portal-cron` (`wrangler.cron.jsonc`: `0 7 * * 3` UTC = Wed 20:00 NZ, `APP_ORIGIN`, `SHARDS=1`).
- **Why a separate cron worker:** OpenNext's generated entry exports `fetch` only — there is **no `scheduled` handler**, so a cron trigger on the app Worker lands with no receiver (the docs' §4.5 correction; don't re-add `triggers` to the app config).
- **Free-plan reality:** free Worker = **10 ms CPU + 50 subrequests/invocation** ⇒ deployed `*.workers.dev` is a *measurement rig only* (Error 1102s on `/dashboard`, `/reports`, telemetry are expected data, not bugs); the portal needs **Workers Paid $5/mo** (paid floor with Supabase Pro $25/mo). Supabase free pauses after ~7 days idle — a quiet fortnight takes the portal down.
- **Hard limits to design around:** **6 simultaneous outgoing connections per invocation** (dashboard ~15 parallel queries, readiness-loader 10 — P1-4/M-14 collapse fan-outs into RPCs; this is a *correctness* item, not tuning); **128 MB isolate** (20 MB telemetry upload parsing 200k rows is “the most likely production incident after the migration” — stream it or lower caps); weekly cron triggers get a 15-minute CPU allowance (vs 30 s under an hour).
- **Biggest technical risk, documented:** OpenNext builds the Next middleware path on Node runtime and warns *“Node.js middleware support is experimental in cloudflare, use at your own risk”* — the portal's auth gate sits there. It works (local workerd boot: `/` 200, `/dashboard` 307→login, cron 401 fail-closed, image optimization real) but “Cloudflare can host this app” stays a **measured** claim.
- **Cutover in one block (full detail in [docs/cloudflare-deploy-runbook.md](docs/cloudflare-deploy-runbook.md)):** `wrangler login/whoami` → `wrangler r2 bucket create uav-ops-portal-opennext-cache` → set `NEXT_PUBLIC_SITE_URL` + `REQUEST_THROTTLE_SALT` → `opennextjs-cloudflare build && deploy` → `wrangler secret put` (SUPABASE_SECRET_KEY, CRON_SECRET, RESEND_API_KEY, REQUEST_THROTTLE_SALT) → point `APP_ORIGIN` at the `*.terraoi.workers.dev` origin, `deploy -c wrangler.cron.jsonc` + its `CRON_SECRET` → add the origin to Supabase Auth redirect URLs + CORS. **Rollback:** DNS back to Vercel (keep it warm one cycle), keep secrets identical, disable the Cloudflare cron before re-enabling the Vercel cron (no double-reminders). Landmine: building with the real `NEXT_PUBLIC_SUPABASE_*` wires the Worker to the **production database** — the staging window is a surface to close, not a state to live in.

### 12.4 The four mandatory platform fixes — already implemented + tested on this tree (uncommitted)

| Fix | File(s) | Why |
|---|---|---|
| `node:dns lookup` → `resolve4/resolve6` (allSettled; SERVFAIL refused, not treated as empty) | [src/lib/webhook-dispatch.ts](src/lib/webhook-dispatch.ts) + test | `lookup` throws “Not implemented” on Workers — inside try/catch it would have **silently** rejected every webhook |
| Trust `cf-connecting-ip` alongside `x-real-ip`; `TRUSTED_ADDRESS_HEADERS` | [src/lib/throttle.ts](src/lib/throttle.ts) + test | on Cloudflare `x-real-ip` is absent ⇒ every submitter would share one abuse bucket |
| Site-origin single resolution; Vercel host demoted to fallback + warn-once | [src/lib/auth-urls.ts](src/lib/auth-urls.ts) + test (+ duplicated `authCallbackUrl` removed from login actions) | leaving Vercel must not send invites to `uav-lounge.vercel.app` |
| Cron contract kept, comments stop asserting Vercel | route + `workers/cron-reminders.ts` | scheduler change is config, not behaviour |

---

## 13. Branching, commits, releases (as actually practised + where to tighten)

- **Model:** `main` (stable) ← `dev` (integration) ← feature branches (e.g. `cloudflare-prep`); **linear history, no merge commits, fast-forward only**; CI fires on `dev`, `main`, and PRs.
- **Commit style (keep it):** full-sentence, capitalized, **imperative verb first**, ending with a period, phrased as the *effect* not the diff (“Give the product an organisation boundary it can be trusted with.”). Roadmap commits prefix `Phase N: …`. No Conventional-Commits types, no scopes, no trailers. Task ids (`P0-1`, `M-04`, `A-07`) are stable and belong in commit messages.
- **No tags/releases yet.** Recommend: tag at each deploy from `main`; branch per dependency major bump (§4.3).
- **Anti-pattern to stop:** month-long uncommitted tails (§2). The current 77-entry tree is the cautionary example; split it per P0-1 and keep branches committable.
- **Author identity:** commits should be authored `Wei-Inline <329191869+…users.noreply…>`; the “record the author” commit `d059e23` was empty and there is no `.mailmap` — add one if history matters (it's cosmetic; do it in the P0-1 commit series).

---

## 14. Testing & verification strategy

**Today:** 36 test files, **694 tests** (verified green 2026-11-04; note docs disagree: proj-plan says 671, the November docs say 694 — the run says 694). Environment `node` by default; jsdom only via per-file docblock; `server-only` stubbed in config.

**Distribution (bias to know):** the pure rule engines and plumbing dominate — `reminders` 54 · `csv-import` 56 · `flags` 53 · `compliance` 48 · `readiness` 43 · `telemetry` 41 · `sharepoint` 27 · `throttle` 26 · `inspection-plans` 23 · `supabase/middleware` 23 · `api-keys` 21 · `storage-paths` 18 · `declarations` 17 · `weather` 17 · `csv` 16 · `operations` 16 · `webhooks` 16 · `risk` 15 · `offline-queue` 15 …

**Known gaps (accepted, listed so new work closes them):**
1. **Zero browser tests.** Playwright 6–10 journeys proposed: public task submit, sign-in, record a credential, refuse a flight, download a capped report (the compliance behaviour *is* the product).
2. **No live-database lane.** Migrations + RLS *are* the security model; unit tests can't see trigger/throttle/composite-FK/cross-tenant classes of defect — exactly the ones the four-reviewer pass (2026-11-02) found. Proposed: `supabase start` in CI, run migrations, SQL assertions (throttle under concurrency, composite-FK rejection, cross-tenant reads), generated-types drift gate.
3. `actions.ts` files themselves are mostly untested (only the route-handler pairs); no `permissions.ts`/`api-auth.ts` siblings; visual verification never happened (screens didn't render — everything was verified by measurement; human eyes owed over §DEFERRED #15 list).
4. Four built-but-unverified features (§ DEFERRED B): SharePoint mirror, read API/webhooks vs real data, throttle trigger vs live DB, credential/declaration screens vs live DB.

**Definition of done, house standard:** gates green (lint/tsc/test/build) + behaviour pinned by tests + comment updates where invariants changed + migration (if any) follows §7.6 + `revalidatePath` behaviour considered + no new tenancy bypass.

---

## 15. Observability & operations

- **Scheduler contract** ([src/app/api/cron/reminders/route.ts](src/app/api/cron/reminders/route.ts), 557 lines): fail-closed bearer; `?shard=n&shards=k` (validated 2–12, falls back to full run); `CONCURRENCY = 4` (`mapWithConcurrency`); per-tenant failure contained (`scanContained` → run still 200, tenant in `failures[]`); retention prunes run **every shard** (idempotent); response is **counts + opaque org ids, never names or content**; `emailed_at` set only when `dedupeKeysFullyDelivered`. The Cloudflare cron worker calls it **sequentially** (parallel slices would multiply connection pressure), clamps `SHARDS ≤ 20`, treats a missing config as loud-log-not-throw (a throwing `scheduled` retries 3×), and exposes a `fetch` handler for **manual re-runs** (also the recovery path after Supabase free-plan pause).
- **What the weekly scan covers (and doesn't):** scans certificates, training records, documents, maintenance, audits — **not yet** recency records, training completions, type competencies, work-authorisation expiry, or annual effectiveness reviews (COMPLIANCE §7; alert-scan extension is a named next step).
- **Idempotency:** notification `dedupe_key = <kind>:<entity_id>:<due_date>:<threshold_days>` unique ⇒ scans can run repeatedly (and both hosts may share one DB during cutover — disable one cron while testing).
- **Logging/observability posture:** Workers `observability.enabled` (per-route CPU-ms is the whole point of the free-plan rig); `wrangler tail` for live reads; app-side `console.error` on dispatch/query failures with user-facing shapes that hide DB wording; webhook delivery log + prunes; personal-data access log; `agent_runs` (planned) will be “the table an inspector reads to see *how* the portal answered.”
- **Latency (the honest caveat):** NZ users → us-west-2 ≈ **100–170 ms** vs ≈10–25 ms Sydney. Ranking of fixes: (1) DB region to Oceania (L-01: new project + restore backup; in-place move not assumable — and a Privacy-Act-2020/CAA question the Accountable Executive will ask), (2) fewer round trips via RPCs, (3) edge compute — the *smallest* lever. “Doing 3 without 1 and 2 is how you end up with a migration story that mentions Cloudflare and a portal that still feels the same.”
- **Cost floor:** Workers Paid $5/mo + Supabase Pro $25/mo (Supabase **Micro is the practical floor** — Nano's 0.5 GB can't build the HNSW index); embeddings corpus ≈ **$0.03** one-time (bge-m3 via Workers AI); LLM per-run budgets enforced twice (in-code ceilings + AI Gateway spend limits outside our code).
- **On-call realities:** Supabase free plan pauses after ~1 week idle (manual resume + run the cron by hand); Vercel Resend marketplace terms still need human acceptance; Supabase redirect-URL list needs the new origin before any host move.

---

## 16. Phases & roadmap — read this before saying “Phase 3”

**Four “Phase” numbering schemes coexist. Never use a bare “Phase N” in a message or commit; qualify it.**

1. **Parity roadmap Phases 1–5 (delivered history, 2026-08-26):** P1 defensible operational record · P2 projects/components/checklists/airspace+weather · P3 hazard register/authorisations/RPOC pack+safety loop · P4 telemetry + per-cell battery analytics · P5 offline capture + read API/webhooks + SharePoint mirror. All five shipped (Phases 1/4 scoped mainly by their commit prefixes; the roadmap artifact itself is off-repo).
2. **Compliance module roadmap P1–P6** ([docs/sky-lounge-rpas-compliance-plan.md](docs/sky-lounge-rpas-compliance-plan.md) §10): P1 records of truth → P2 company qualification → P3 rules engine + alerts → P4 operations → P5 safety & inspection → P6 hardening. COMPLIANCE.md status: most of P1–P5 built; P6 partially built (offline ✅, regulatory watch ✅, **retention floors ✗, FR localization ✗**).
3. **Onboarding workflow Phases 1–6** (compliance plan §5 — the “Phase 6 blocking rule”: operational release only after 2–5 complete): **not built** beyond the `pilots.onboarding_status` enum.
4. **AI program Phases 0–4** ([docs/expert-agents-plan.md](docs/expert-agents-plan.md) §6): Phase 0 corpus+citation verification (no chat) → Phase 1 read-only UAV expert side panel → Phase 2 drafts + human confirmation → Phase 3 GPR module+expert (order 4.1→4.3→4.6→4.5→4.4→4.7) → Phase 4 cross-domain. All not started.

**proj-plan.md itself runs on TRACKS, not phases** (dependency order, not calendar order; task ids `P0-1 / M-04 / A-07` are stable and referenced in commits):

| Track | Scope | Status (re-scored 2026-11-04) |
|---|---|---|
| **P0** | repo/DB hygiene | partially done (lock ✅ CI file on disk ✅) — commit + migrations + secrets + password rotation still open |
| **P1** | Cloudflare platform (D-01): P1-1 Next bump ✅ done, P1-2 four fixes ✅ code+tests (uncommitted), P1-3 rig ✅ on disk, **P1-4 fan-out collapse ✗**, P1-5 Turnstile ✗ | staging on `*.workers.dev` not yet run for real (R2 bucket, secrets unset) |
| **C0** | certificate-truth cutover (one change: migrate the legacy `pilots.certificate_expires`/`last_recency_activity` pair to the credential-screen source + rewrite reminders/rpoc in the same commit) | not started — blocks anything that talks to an operator |
| **R** | regulatory re-baseline of every `car_reference` (R-01 `car_citations` table → R-02 re-baseline; R-03 marking severity; R-04 BVLOS legs; R-08 aircraft-scoped authorisations) | not started; highest value |
| **M** | data layer M-01…M-18: pgvector+`kb_*`, HNSW+FTS indexes+RRF `search_corpus`, `agent_sessions/messages/runs/drafts`, `gpr_*` five migrations, `agent_settings`, one-round-trip tool RPCs, retention floors | not started (all must sort after `20261101000002`) |
| **K** | corpus ingestion + citation verification | **in-progress**: K-01/K-03 done 2026-11-02 (the regulatory spine §6b); K-02 bucket, K-05 open gaps, K-06 Standard 922 Table 1 remain |
| **A** | shared agent platform (gateway, tools, verifier, drafts, audit) | not started — **no AI/RAG code exists at all** (verified 2026-11-02) |
| **B** | UAV Compliance Expert | not started (gated on A + C0) |
| **G** | GPR module + expert (M-08…M-12, D-03 parallel) | not started |
| **Q** | verification lane (golden sets, CI retrieval, red team) | not started — “not optional” |

**Sequencing rules:** P0 before everything; C0+R-02 before any operator-facing answer; B-02/G-08 not before C0; drafts (A-07) not before the gate rule is proven by a test; K-01/K-03 and G-02 safe to run in parallel with P1/C0. Effort is recorded per task (±50 %) in proj-plan §11 — biggest single items: G-03 (5 d), M-14/A-03 (3–4 d), R-04 (3 d).

---

## 17. Compliance program in brief (the product's spine)

- **Regulatory basis:** CARs SOR/96-433 **Part IX “Remotely Piloted Aircraft Systems”** as restructured by **SOR/2025-70** (registered 2025-03-06; phased commencement **2025-04-01** certificates/RPOC, **2025-11-04** BVLOS/EVLOS/sheltered — the “2025-06-01” in rag-design §6 is unsupported; retrieval filters on `effective_from <= flight_date`, so the date matters). Standards 921/922 (923 DAA and 924 telemetry on watch), TP 15263 / TP 15530 (**re-classified: knowledge requirements, not guidance** — D-15), AC 901-002 Issue 02 (eff. 2025-11-04; App. A ops-manual template, App. B MCM template). Consolidated text: laws-lois SOR-96-433, “current to 2026-09-30” — that instrument is the corpus `as_of`.
- **Currency = recency, not expiry:** a TC Basic/Advanced certificate **does not expire**; recency windows are 24 months (901.56/901.65/901.91). The legacy columns contradict this and are still read by `reminders.ts` (“your certificate expires on…”) and `rpoc.ts` (“Valid to fly”) ⇒ **the portal currently says two opposite things to the same pilot**; C0 is the one-change cutover that fixes it.
- **The citation defect (headline of the 2026-11 review):** `901.02`/`901.03` (registration/marking) point into a **reserved block** — the live rules are **900.13/900.14** (marking is mandatory, AMP fines up to $25,000 corporate; the portal calls marking “advisory” — R-03); `901.04` → 900.15(1); `901.89(1)(c)` and `901.92(2)` don't exist; `Standard 921.07` attribution for the 80 % pass mark is wrong (it's the L1C flight review; the pass mark is TC's exam page); `NPA 2026-005` was not found at all. Dead cites sit in exactly 4 code sites (`readiness.ts:406,417`; `readiness-loader.ts:192`; defaults in applied migration `20260903000001:195-294`) + the 8 `declaration_requirements` seeds + the `regulatory_watch` NPA row. Track R + M-15/M-16 fix this by **data + new migration** (applied migrations are never edited) against the `car_citations` authority table (§18 tools §M-15).
- **BVLOS is three legs:** L1C certificate (901.90) + **RPOC** (901.214) + **model declaration** under 901.194 against Standard 922 Table 1 — the portal's single generic row and its “901.69 = manufacturer declares” gloss are both wrong (901.69 is a pilot-side prohibition) → M-17/R-04/K-06.
- **Retention floors (D-16):** 12 months most operator records; **24 months** registration-number + maintenance/mandatory-action (901.223(2)); declaration-verification records 2 years past the later of end-of-manufacture/notice (901.201); `agent_runs` inherits ≥24 months. Today's flat 12-month maintenance retention **under-shoots** (M-18).
- **Privacy:** DOB + work-authorisation behind `personal_data` (default `none`; every read logged); anonymous incident reporting preserves anonymity through the webhook payload; throttle hashes pruned at 30 days; data location (Oregon today) is a NZ Privacy Act 2020 IPP question for the Accountable Executive (L-01).
- **Open regulatory questions for the owner** (COMPLIANCE §11 / proj-plan §14): L1C today or RPOC held for later BVLOS? Any medium RPA >25 kg? Who signs pilot authorisations? Minimum supervised flights before release? Plus K-05 gaps: Standard 921's published location, the 2026-06-17 amending instrument, per-provision AMP amounts, unread 901.48–901.54/901.97–901.174/903.04+ — with the rule: **no `authority='standard'` chunk ingested from a page we could not open.**

---

## 18. The AI agent program — the implementation build

**Status (verified 2026-11-04): design complete, zero code.** No `ai`, `@ai-sdk/*` or `zod` in [package.json](package.json); `kb_`/`agent_`/`gpr_` appear only in planning docs. Nothing below is speculative — every item is a task id from [proj-plan.md](proj-plan.md) §11 or a schema from [docs/rag-design.md](docs/rag-design.md) / [docs/expert-agents-plan.md](docs/expert-agents-plan.md). Build it in the order §18.8–18.9 gives.

Two operators'-experts — **UAV Compliance** and **GPR** — inside the portal, answering from a **versioned corpus (pgvector+FTS hybrid)** plus the tenant's own records via **allow-listed, typed, read-only, permission-checked one-round-trip tools** (`readiness_preview`, `declaration_coverage`, `credential_state`, `training_state`, `competency_state`, `run_report` capped, `rpoc_pack_status`, `upcoming_lapses`, `search_corpus`), composing structured answers `{answer, claims[]→chunk/record, unknowns[] required, handoff}`, verified mechanically (every requirement claim must bind to a retrieved chunk that substantiates it; failing claims are **dropped, not softened**, and logged; no citations + no unknowns ⇒ refuse). Refusal is a first-class output.

**§18.1 · The five boundaries that must never blur (§5 of proj-plan):** (1) the gate is authoritative — the agent shows the gate's verdict beside its own and **never feeds it**; (2) **the agent never writes a row** — it writes `agent_drafts`; a human confirms through the existing actions, which re-check permission and the separation-of-duties refusals; (3) retrieval is filtered by **RLS, not app code** (`search_corpus` invoker-by-omission; `kb_*` writes service-role only); (4) **corpus authority is data, not tone** (`law/standard/knowledge_requirements/advisory_circular/regulatory_change/company_manual/vendor_manual/client_spec/theory_reference/unverified`; a vendor manual may support a capability claim, **never** a requirement; `unverified` chunks may only surface as “we could not verify this”); (5) **every model call goes through the gateway** — no provider SDK inside a screen; tests never call a provider (`ai/test` mocks + MSW).

**§18.2 · The answer pipeline (every expert call takes this shape)** — from [docs/expert-agents-plan.md](docs/expert-agents-plan.md) §1, as amended by D-07/D-22:

```
question
  → intent + domain classifier            (uav | gpr | mixed | out-of-scope; cheap tier)
  → hybrid retrieval over the domain corpus (pgvector ∪ websearch_to_tsquery, RRF, rerank,
                                            authority + effective_on filters)
  → scoped tool calls over tenant data    (allow-listed, typed, read-only, ONE round trip each,
                                          in-request under the caller's session — D-11/D-22)
  → composed answer                       (AI SDK 7 Output.object; claim → citation → record id)
  → mechanical verifier pass              (different tier than the generator — D-12)
  → human handoff                         (proposed action via agent_drafts, never an applied one)
```
Two standing behaviours: **currency check** — a chunk with `effective_from` later than the flight date, or superseded, is flagged before display; **visible partiality** — every answer shows which records the caller could not see (“a partial answer is visibly partial”). The whole route is gated by `AGENT_ALLOWED_ORGS` + per-tenant `agent_settings` (D-09), not by a feature-flag system.

**§18.3 · Model gateway — `src/lib/ai/llm.ts` (A-01/A-02; D-02/D-17–D-20).** One provider-agnostic interface; callers name **task classes** (`route/extract/embed-query/rerank/compose/verify/draft`), never model names.

| Tier | Provider | Notes |
|---|---|---|
| T0 | LAN model (`iq3_s`, Ollama-style OpenAI-compatible endpoint) reached via **Cloudflare Tunnel + Zero Trust Access service token** (worker → tunnel → LAN box; service bindings do not help) | opportunistic only; if `cloudflared` is down the gateway rotates to T1 silently; needs a health dashboard + restart policy before anyone calls it infrastructure (R risk); embeddings reproducibility is pinned by `embedding_model`/`embedding_dims` (D-08), not by hoping the box is up |
| T1 | DeepSeek direct | `json_object` only ⇒ **validate-and-repair** wrapper, not strict schema |
| T2/T3 | OpenRouter (further tiers) | pass through **Cloudflare AI Gateway** |

Hard mechanics, all decided (proj-plan §7.1/§7.7): **serialize outbound LLM calls inside a run** (a streaming generation holds one of the **six simultaneous connections** for its whole life; `env.AI` embeddings/rerank consume none — that is why they live there); **first-token deadline** on every generation (`AbortSignal.timeout` or `cf-aig-request-timeout`, measured to first byte) + bounded retries (`cf-aig-max-attempts` ≤5) before rotating a tier; **budget enforced twice** — in-code per-run ceilings (≤2 retrievals/domain, ≤12 chunks, ≤6 tool calls, token/wall-clock caps, recorded in `agent_runs`) *and* AI Gateway **spend limits / budget-limit routing nodes** outside our code. AI Gateway explicitly does **not** help with: caching (exact-match SHA-256 ⇒ hit rate ≈ 0 with per-query context — savings come from provider prompt caching on a byte-stable prefix, D-20) and cost truth (figures are token estimates; reconcile `agent_runs.cost_estimate` against Gateway analytics and OpenRouter `usage.cost`). Use **Dynamic Routing** (`dynamic/<route>`), not the deprecated header-driven Universal fallback path. Embeddings/rerank: Workers AI `env.AI` — bge-m3 (1024-dim, D-06) + bge-reranker-base. **Tests never call a provider:** `MockLanguageModelV4`/`MockEmbeddingModelV4`/`mockValues` from `ai/test` (they can exercise the rotation policy itself), MSW v3 for outbound fetch, recorded fixtures; a live LAN-model call is a manual in-LAN smoke job, never CI.

**§18.4 · Database migrations to write (M-01…M-14; all sort after `20261101000002`, all follow §7.6 house rules):**

| Id | File | Content (exact from proj-plan §7/M-table) |
|---|---|---|
| M-01 | `…_pgvector_and_kb_core.sql` | **first `create extension`** (pgvector, schema `extensions`); `kb_documents` / `kb_chunks` exactly as [docs/rag-design.md](docs/rag-design.md) §2 (source_url, `effective_from`, `superseded_by`, `jurisdiction`, `authority` enum, heading_path, `body_tsv` generated) **plus** `embedding_model`, `embedding_dims` (D-08) and `verify_state` check — the citation problem made structural |
| M-02 | `…_kb_indexes.sql` | HNSW cosine `(m=16, ef_construction=64)` — `vector` caps at 2,000 dims, which is why 1024 (D-06) is right; GIN on `body_tsv`; `(domain, authority, effective_from)` composite; `_org_idx`. Index build needs more RAM than Supabase Nano’s 0.5 GB — **Micro is the practical floor** |
| M-03 | `…_kb_rls.sql` | `kb_chunks_read`: `organisation_id is null or owns_row(organisation_id)` (public corpus rows carry null org); **no user-facing write policy** — ingest is service-role only; grant `select` to `authenticated` only |
| M-04 | `…_kb_search_rpc.sql` | `search_corpus(p_domain, p_query, p_authorities text[], p_effective_on date, p_k int)` — hybrid pgvector ∪ `websearch_to_tsquery`, **RRF in SQL**, invoker-by-omission so RLS applies; **sets `hnsw.iterative_scan = strict_order` + per-tenant `hnsw.max_scan_tuples`** (D-21 — without it, HNSW under an RLS filter silently under-returns); returns citation/authority/effective_from/heading_path/body + score parts |
| M-05 | `…_agent_audit.sql` | `agent_sessions`, `agent_messages`, **`agent_runs`** (question, domain, tier ladder + provider + model per call, prompt/completion tokens, cost estimate, retrieved chunk ids, every tool call + row counts, claims kept and claims dropped with reasons, refusal flag, user, org, duration). Append-only: `revoke update, delete` + blocking triggers; retention floor ≥2 y. “The table an inspector reads to see *how* the portal answered” |
| M-06 | `…_agent_drafts.sql` | `kind`, `prefill jsonb`, `basis jsonb` (chunk ids + record ids), status `proposed/confirmed/discarded/expired`, `confirmed_by/at`, `expires_at`. **Deliberately no FK into any operational table** — a draft must not become a constraint |
| M-07 | `…_permission_areas.sql` | extend `access_area` enum: **`gpr`, `commercial`, `corpus`** + defaults (all `none` except `system_admin`/`uav_admin`); expect the `src/lib/access.ts` compile error (§19 S1) |
| M-08–M-12 | `…_gpr_*.sql` ×5 | the 13-table GPR schema in the delivery order (registry/maintenance/calibration → jobs/lines/datasets/processing_runs → picks/anomalies/deliverables → qc_checks/nonconformances **with the release-block as a trigger** → rate_cards/quotes/quote_lines under `commercial`) |
| M-13 | `…_agent_settings.sql` | per-tenant `agent_settings` (`enabled`, `allowed_domains`, `allowed_tools text[]`, `daily_token_budget`, `max_answer_tier`) + defaults table (the D-09 no-flag-system pattern) |
| M-14 | `…_agent_tools_rpc.sql` | the one-round-trip read RPCs the tools wrap (D-11): `agent_readiness_pack(…)`, `declaration_coverage(…)`, `credential_state(…)`, `training_state(…)`, `competency_state(…)`, `rpoc_pack_status()`, `upcoming_lapses(days)` — invoker, caps inherited. **Depends on C0** (record truth) and doubles as the P1-4 fan-out collapse — build once |

Compliance-side migrations M-15…M-18 (`car_citations` authority table, data-only citation re-baseline, declaration-model split, retention floors) are §17 / proj-plan Track R — the agent build **inherits** M-15: no requirement claim may cite anything that doesn’t resolve there.

**§18.5 · Tool layer (the allow-list the agent may call).** Nine tools today (`readiness_preview(pilot_ids, uav_id, flight_date, characteristics)`, `declaration_coverage(uav_id?)`, `credential_state(pilot_id)`, `training_state(pilot_id)`, `competency_state(pilot_id, uav_id)`, `run_report(report_id)` reusing the capped catalogue + truncation flags, `rpoc_pack_status()`, `upcoming_lapses(days)`, `search_corpus(…)`), plus the GPR set in Track G. Each wrapper: `getAccess()` + area check, one RPC round trip, RLS under the **caller’s session** (D-22: a Queue consumer has no JWT → `current_org_id()` null → the agent would answer “no records” with total confidence). Queues carry only session-free phases (rerank/compose/verify) over payloads already fetched, **re-validated by id** before they reach the prompt. If a queued phase ever needs more reads, its RPC must be `security definer` taking `p_organisation_id` + `p_requesting_user_id`, re-checking `role_permissions` inside, revoked from `authenticated`, granted to `service_role` only — the reminders-job/`/api/v1` pattern, and “not a public RPC”. `/api/agent/run` is proxy-exempt by construction ⇒ it **self-authenticates fail-closed**, copied from the cron route’s contract. **A-08:** it is the most expensive endpoint in the product, so KV-backed per-user/per-tenant counters + `agent_settings.daily_token_budget` are enforced **before any model call** (today nothing but the public intake form is rate-limited at all).

**§18.6 · Structured answer, verifier, drafts (A-05/A-07).** Contract (rag-design §5): `{answer, claims[] (each: chunk_id + citation + authority, or record {table,id}), unknowns[] (required), handoff{action, prefill}}`, validated with **zod — the one sanctioned use in this repo** (the hand-rolled `action-utils.ts` validators stay). Verifier is mechanical: every claim not marked `unverified` must name a chunk that was **actually retrieved** and whose text substantiates it; failing claims are **dropped, not softened**, and the drop is logged; no citations + no unknowns ⇒ refuse outright; verifier tier ≠ generator tier (D-12). Prompt-injection posture: retrieved text is delimited untrusted data, never concatenated into the system turn; the model’s only capabilities are the read tools and the draft object. Drafts (Phase 2) prefill **existing forms** and go through the existing actions — same permission checks, same `record-guards.ts` refusals — and acceptance is proven by test: **no write path the agent can complete alone.**

**§18.7 · Task ledger (ids stable; deps/effort/acceptance from proj-plan §11 — effort ±50 %):**

| Id | Build | Depends on | Days | Acceptance |
|---|---|---|---|---|
| A-01 | Tunnel+Access to `iq3_s`; gateway with tier ladder, budgets, circuit breaker, stub provider for tests | P1-3 | 3 | T0→T1→T2 failover exercised on purpose; CI never touches a real provider |
| A-02 | AI Gateway routes for T1/T2 + spend limits + first-byte timeout + bounded retries + analytics | A-01 | 1 | cost per answer agrees between `agent_runs` and Gateway analytics; account ceiling holds **with our counter deliberately broken** |
| A-03 | tool layer + M-14 RPCs | M-05, C0 | 3–4 | every tool call logged with row counts; `run_report` cap enforced |
| A-04 | `search_corpus` + RRF + rerank + date/authority filters wired to gateway | A-01, M-04 | 2 | a flight in 2024 is never answered with a rule that commenced in 2025 |
| A-05 | structured answer + zod + verifier + refusal path + cross-tier verify | A-04 | 3 | ≥95 % of requirement claims bound to a retrieved chunk; 0 ungrounded “the rule requires” |
| A-06 | `agent_runs` audit surface + `/corpus` admin page + read-only side panel | M-05, M-06 | 3 | an inspector can see how the portal answered a given question |
| A-07 | drafts: prefill → confirm through existing actions | M-06, B-02 | 3 | no write path the agent can complete alone; SoD refusals reproduce |
| A-08 | agent endpoint limiter (KV counters + daily_token_budget, pre-model) | A-01 | 1–2 | second run past budget refused with **no provider call and no cost** |
| B-01 | UAV corpus load (CARs, Standards, TP/AC, operator manual) + “could not verify 901.29” phrasing | K-02, K-03 | 2 | expert flags dead cites instead of repeating them |
| B-02 | UAV record tools wired | A-03 | 2 | 50 realistic questions pass the bar |
| B-03 | side panel on `/flights`, `/pilots/<pilot>`, `/fleet/declarations`, `/reports` | A-06 | 2 | **gate verdict always displayed beside the agent’s** |
| G-01 | `gpr_*` registry+maintenance+calibration schema+screens | M-08 | 4 | calibration state visible per unit |
| G-02 | GPR corpus (vendor manuals, client specs, theory) — independent of G-01 | K-02 | 2 | capability claims answerable with a page citation |
| G-03 | jobs/lines/datasets/processing-runs **lineage** schema+screens | M-09 | 5 | “what processing was applied to this line, in what order, with what parameters” answerable |
| G-04 | QC plan + non-conformance register + release-blocking trigger | M-11 | 3 | release with an open critical NC refused **by the database** |
| G-05 | GPR admin (crew cert, allocation, licence/calibration expiry) | G-01 | 3 | — |
| G-06 | deliverables + report drafting vs tenant template, unsupported-claim listing | M-10 | 4 | draft claims without records are listed, not printed |
| G-07 | rate cards, quotes, comparable-job actuals (`commercial` gating) | M-12 | 4 | take-off priced from the tenant’s own card, with record ids |
| G-08 | GPR expert on the shared platform (corpus-only first) | A-05, G-02 | 3 | corpus answers cite `vendor_manual`/`theory_reference`, **never state a requirement** |
| X-01 | cross-domain: one question, two experts, one answer sheet | B-03, G-08 | 3 | both citation sets labelled, neither blended |
| K-02 | `tools/ingest` CLI: parse → chunk by citation → embed → upsert with `source_hash` diffing (CARs Part IX first) | M-01, M-13 | 3 | a few thousand chunks, cost logged, **re-run is a no-op** |
| Q-01 | golden sets (60/domain, `should_cite`/`must_refuse`/`must_not_say`) + retrieval-only CI lane | M-04 | 2 | the lane runs on **every migration** |

**§18.8 · Delivery phases (exit criteria are the point):** **Phase 0** — corpus + citations, no chat: load CARs/Standards/TP/AC/vendor into `kb_*` with authority and effective dates; *acceptance: every `car_reference` in the schema is confirmed against a chunk or explicitly marked unverified* (K-03 verdicts already make this mechanical). **Phase 1** — read-only UAV expert side panel (no drafts); *acceptance: 50 realistic questions, ≥95 % of requirement claims bound to a chunk, zero ungrounded “the rule requires”, every tool call in `agent_runs`.* **Phase 2** — drafts + human confirmation; *acceptance: no agent-completable write path; separation-of-duties refusals reproduce in drafts.* **Phase 3** — GPR module built in order **4.1 → 4.3 → 4.6 → 4.5 → 4.4 → 4.7**, expert arrives only once records exist; corpus-only until then (the D-03 survivability rule). **Phase 4** — cross-domain X-01. Standing evaluation: two scorers (automated claim-binding/refusal/citation-validity + monthly human review of 20 runs per domain), quarterly red team (injected vendor manual, cross-tenant probes, bait questions, honest-“unknown” answers), and direction-of-travel metrics: **a wrong confident answer is weighted far above a missing one.**

**§18.9 · GPR expert specifics worth knowing before building G-anything:** *lineage is the product* (processing-run stages recorded before any analysis can be trusted); release blocked by trigger on open critical non-conformance; **estimates are the most sensitive data** (separate `commercial` area; show last three comparable jobs with record ids); raw SEG-Y never round-trips through a server action (Storage now, R2 later per D-10, short-lived signed URLs); signal processing itself is out of scope for the first pass — **the metadata schema comes first**.

---

## 19. Agent skills — playbooks for working in this repo

The repeatable procedures an AI agent (or new dev) will need. Follow the house shape; the codebase comments will thank you or a reviewer will reject you.

**S1 · Add a migration:** new file `2026XXXXXX_topic.sql` (sorts after `20261101000002`) → follow §7.6 (idempotent, explicit grants + revoke for definers, `organisation_id not null default current_org_id()` + composite FKs + `<table>_id_org_key` + `_org_idx`, policies = `owns_row AND can_*('area')`, `comment on` the why) → `supabase db reset` locally → regenerate `database.types.ts` → if it adds an enum value, split files → if it adds an `access_area`, expect the type error in `src/lib/access.ts` (fix labels/order too — that compile error is the wiring).

**S2 · Add a screen (feature module):** `src/app/(portal)/<area>/page.tsx` async RSC (await `getAccess()` + explicit-column queries; hard `redirect("/dashboard")` only for genuinely sensitive areas, else render + pass `canManage/canCreate` flags down) · `actions.ts` `"use server"` with a `require<X>Manager()` gate unless deliberately RLS-only, result shape `{error}`, `revalidatePath` at the end · client tables/dialogs in `src/components/portal/<area>/` using the toast+`useTransition` pattern and `OptionSelect` for every fixed-choice select · register nav in `src/lib/nav-items.ts` with its `manages:` key.

**S3 · Add a server action:** re-check permission server-side (“hiding a button was never the access control”); never set `organisation_id`; use `safeErrorMessage` for DB errors; if the action records anything about the acting person, route through `record-guards.ts` self-record refusals; emit `notify(event, …)` if the webhook catalogue should know.

**S4 · Add a report/CSV:** extend [src/lib/report-defs.ts](src/lib/report-defs.ts) with columns + its `area`; query in `reports/queries.ts` under `REPORT_ROW_CAP` with truncation announced (headers + printed note); CSV route needs no new code; add a page test for the pure export (`truncationNote` pattern).

**S5 · Add a webhook event:** extend the DB enum (two-file pattern) → `src/lib/webhooks.ts` event list → call `notify()` → SSRF rules (§9.6) already apply — never bypass `webhookAddressAllowed`.

**S6 · Add storage:** new bucket only with a storage policy using `storage_path_owns` + area case; paths via `storage-paths.ts` **only**; keep restricted categories out of mirrors (`NEVER_MIRRORED`).

**S7 · Change auth/tenancy/RLS:** treat as a security change — write the failing cross-tenant test first; check `keep_one_user_manager`-style lockout guards; verify the proxy table in `middleware.test.ts` still pins the exemptions; a new service-role call site needs the comment + admin.ts import + hand-scope, and must be added to §9.3's list here.

**S8 · Work the Cloudflare track:** read [docs/cloudflare-migration.md](docs/cloudflare-migration.md) §4.4/§4.5 and the runbook first; P1-4 = collapse `dashboard-data.ts`/`readiness-loader.ts`/reminders fan-out into RPCs (M-14 RPCs double as the agent tools — build once); human runs any `wrangler login`-family command; check bundle size with `wrangler deploy --dry-run`; WSL is the reference environment.

**S9 · Write regulatory-facing copy:** never print an unverified citation as a requirement; label what each number counts (the analytics-denominator decision); the standing disclaimer travels with every compliance statement.

**S10 · Keep the map honest:** after structural work, `node tools/architecture-map.mjs` and commit the regenerated `docs/architecture-map.html`.

---

## 20. Risks (proj-plan R-01…R-15, condensed — names matter more than prose)

Corpus cited as if it were advice · retrieval poisoning via vendor manuals · **automation complacency** (a crew that stops reading the gate is a worse operation than no agent — hence boundary #1) · local model becoming invisible infrastructure (tunnel health, restart policy, second path, or it's not infrastructure) · cost runaway on long evidence-pack reads · scope creep into advising clients (the portal answers **its own operator**; client output stays a human-reviewed deliverable) · D-03 widening surface before the platform is proven · platform move colliding with the agent build · Workers limits discovered mid-build · the agent inheriting a wrong record · **R-11 the citation spine is dead numbering** · **R-12 the design docs themselves contain unsourced claims** · R-13 cheapest tier = least available · R-14 retrieval quietly getting thinner (the CI retrieval lane exists for this) · R-15 cost is state-dependent, so a per-run token cap isn't enough. ⚠ id collision: `R-nn` means both Track-R tasks and risks — always qualify.

---

## 21. Fix list & open decisions (small, but do them)

**Cheap fixes (P0-1 commit series):** repoint `.claude/launch.json` at `I:\_IGI-UAV\dev.cmd` · rewrite `README.md` (still create-next-app boilerplate — point it at this file) · move `research-llm-gateway-workers-2026-11-02.md` under `docs/` · dedupe the `.gitignore` duplicate lines (`.env*`, `.vercel`) · add `.mailmap` if author identity matters · run `npm run cf-typegen` once.

**Decisions needed (owner):** DB region move now vs after cutover (L-01; privacy angle) · Images subscription vs `unoptimized: true` at cutover · Renovate/Dependabot on/off · `allow-scripts` approval for `esbuild`/`unrs-resolver` · per-tenant token budget number (a monthly figure the ceiling belongs to) · GPR kit in service (GSSI/MALÅ/Sensors & Software/RaMal — decides which manuals to ingest first) · where the LAN model runs and whether a Tunnel is acceptable · who signs pilot authorisations.

**Deferred-by-decision (don't re-litigate without the owner):** subscription billing · self-serve sign-up · per-operator subdomains (slugs exist; nothing routes on them — the fix for per-operator front doors).

---

## 22. Glossary

**AMP** Administrative Monetary Penalties · **CARs** Canadian Aviation Regulations (SOR/96-433); **Part IX** = RPAS since SOR/2025-70 · **CRFS** Consolidated Regulations and Statutory Instruments (laws-lois source of truth) · **GPR** ground-penetrating radar · **L1C** Level 1 Complex operations (BVLOS-capable certificate class, 901.87+) · **MCM** maintenance control manual (901.221) · **METAR** aviation weather observation · **NPA** Notice of Proposed Amendment · **OpenNext** the Next-on-Workers adapter · **PIPEDA** Canadian federal privacy law (the model the personal-data design follows) · **PRM** person responsible for maintenance · **RPAS/RPAS-UAS** remotely piloted aircraft systems · **RPOC** RPAS Operations Certificate (Div XII, 901.213–901.223) · **RRF** Reciprocal Rank Fusion · **SEG-Y** seismic/GPR raw trace format · **SFOC-RPAS** Special Flight Operations Certificate for RPAS (Subpart 3, still a live instrument) · **sharded scan** the `?shard=n&shards=k` idempotent job pattern · **SSRF** server-side request forgery (the webhook guard's subject) · **TC** Transport Canada · **three clocks** hours/cycles/calendar per inspection-plan item · **TP 15263 / TP 15530** knowledge requirements for Basic/Advanced / Level 1 Complex pilots · **workerd** the local Worker runtime · **VO** visual observer.

---

## 23. Document map & staleness register

| Doc | Authoritative for | Stale bits spotted (2026-11-04) |
|---|---|---|
| [proj-plan.md](proj-plan.md) | tracks, decision log, roadmap, next-three | header says branch `dev` (it's `cloudflare-prep`); Next 16.3.1/React 19.2.8 (now 16.4.4/19.3.1); “671 tests” (now 694); 52 migrations (now 54); “27+36 dirty” (now 77); P0-2/P1-1 partly done; **the file itself is untracked** |
| [DEFERRED.md](DEFERRED.md) | the backlog | header says “27 August 2026” but body runs to 2026-11-02; items #20/#21 already done; body is otherwise accurate — re-verify items 10–12 after P0-3 |
| [COMPLIANCE.md](COMPLIANCE.md) | module spec-vs-shipped | header “3 September 2026”, body cites 2026-11-01; §7 alert-scan list is current |
| [docs/tech-stack.md](docs/tech-stack.md) | keep/add/don't-touch audit | written pre-D-01: “Vercel keep” superseded by D-01; `generateObject`/`voyage-3.5` superseded by D-19/D-17 — keep as the audit trail |
| [docs/rag-design.md](docs/rag-design.md) | retrieval schema/query design | §6's “SOR/2025-70 commenced 2025-06-01” is **unsupported** (use 2025-04-01/2025-11-04); “security invoker function” phrasing → house shape is invoker-by-omission + revoke/grant (contradiction #10) |
| [docs/expert-agents-plan.md](docs/expert-agents-plan.md) | expert scope, delivery order, guardrails | queuing sentence (“Vercel Workflow/Inngest/QStash”) superseded by D-07 |
| [docs/cloudflare-migration.md](docs/cloudflare-migration.md) | platform assessment + §4.4 fixes + free-plan matrix | “32 views/58 functions” counts statements (§12 #11 — use audit numbers); §11/§12 “done” = done-uncommitted |
| [docs/cloudflare-deploy-runbook.md](docs/cloudflare-deploy-runbook.md) | cutover commands | omits the five SharePoint/Azure vars + `REMINDER_FROM_EMAIL` on the Worker secret list — add at cutover |
| [docs/dependency-status.md](docs/dependency-status.md) | 2026-11-02 upgrade pass + advisories | accurate as a point-in-time record |
| [docs/sky-lounge-rpas-compliance-plan.md](docs/sky-lounge-rpas-compliance-plan.md) | the regulatory spec (v1.0) | its §10 phases are P1–P6 (not the parity roadmap's); L1C pass-mark attribution superseded by K-01 |
| [README.md](README.md) | — | untouched create-next-app boilerplate; rewrite owed (§21) |

**Stale-header rule for the team:** when you change a doc's content, update its header date in the same commit — three of the project's confusion costs trace to drifted headers.

---

## 24. Maintaining this file

- Update §2 whenever a gate result, branch state, or migration status changes (it carries a verification date for a reason).
- New decision → `proj-plan.md` decision log first; §6.1 condenses it afterwards.
- New phase-shaped work → name it by its track/id, and update §16.
- This file is a normal file: it belongs in git, gets reviewed, and a stale §2 is a bug — report it.

*Change log: 2026-11-04 — created from a full-repo analysis (4 parallel deep-dive layers + independently re-run gates: 694/36 tests green, tsc clean, lint clean; branch/worktree state as recorded). Same day: §18 expanded from a condensed design summary into the full agent **implementation build** (§18.2–18.9: pipeline, gateway, M-01…M-14 migration ledger, tool layer, A/B/G/X/K/Q task ledger with deps/effort/acceptance, phase exit criteria), and §8.5 added documenting the **white-labelling function** (what ships, the `branding.ts` choke point, and its current limits). Same day: `tools/plan-html.mjs` added, rendering this file to the interactive `docs/plan.html`.*
