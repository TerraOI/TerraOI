# T-401 Run the M1 subset of the §16 verification matrix, and fix what fails

Lane: shared — this packet **must** carry the `cross-lane` label (its fixes land in both lanes) · Week: 4 · Protected: yes (`supabase/migrations/`, `src/platform/gateway/`, `src/contracts/` — only where a row it runs turns out to be broken) · Depends on: every §20.3 week-1…week-3 packet whose deliverable sits in plan §15.0's "In M1" column, **merged on `main`** ([COORDINATION.md §1](../COORDINATION.md), step 2). As of 2026-11-12 that list still has holes: T-104, T-113's SQL half, T-114, T-211, T-212, T-213, T-214, T-215, T-216, T-301, T-302/T-302b, T-304, T-311, T-312, T-313, T-314 · Status: ready — **do not claim before week 4 opens**; a run against a half-built tree produces evidence nobody should act on
Plan refs: §20.5 (the M1 subset), §16 (the full matrix), §15.2 (what M1-PILOT must prove), §17.2 (staging procedure), §17.3 (evidence discipline); F01–F40 as rows, not as new code

## Goal

§16 is a list of scenarios, not a list of tests that exist. This packet walks the §20.5 subset **row by row against a deployed staging environment**, records for each row the artifact that proves it (a CI job, a pgTAP assertion count, a loopback test name, a staging capture), and fixes the rows that turn out to have no test at all. Its output is a table a human can sign: **§20.5 has 12 areas; M1-PILOT cannot be signed without a line per area.**

## Owns (may edit)

- This packet's checklist table (below), filled in on the branch — the checklist lives **here**, not in a new folder, so `pnpm check:structure` has nothing new to learn.
- The week-4 rows of `docs/status/YYYY-Www.md` ([§17.3](../plan/TerraOI-plan-v1.3.md), labels Observed / Reported / Planned / In progress).
- One-line fixes in either lane **only** when the row is a missing assertion in a file the discovering lane already owns; anything bigger goes to an issue and the owning packet fixes it ([FAQ-0007](../FAQ.md)).

## Must not edit

Any acceptance box in another packet (only the claimant or the supervisor edits those). `evals/**` fixtures (that is T-312/T-315/T-402's). Any merged migration. `wrangler.jsonc`, `.github/`, `AGENTS.md`, `docs/plan/`, `docs/decisions/` — protected; a row that needs one becomes a supervisor PR.

## Contract

Nothing new. This packet **consumes** [src/contracts/](../../src/contracts/) and [docs/contracts/](../contracts/) as written, and runs against the §20.5 subset only. Two plan rows that look in scope are **not**, per the supervisor's rulings: Export leakage (§20.5, no exports in M1) and connector scenarios (§20.5 → TOI-08).

## The §20.5 subset, and what already proves each area

| §16 area (M1 subset) | On `main` today (2026-11-12) | What this packet still has to produce |
|---|---|---|
| Host/session — all scenarios | `tenancy/host.test.ts`, `page-host.test.ts`, `resolve-tenant-context.test.ts`, `src/proxy.loopback.test.ts`; pgTAP `010` (46) | The rows no unit test can reach: **multi-tenant concurrent tabs** and **preview alias bypass** on staging; the **forged internal header** row depends on the runtime half of [ADR-0006](../decisions/0006-page-host-via-proxy-header.md), which is owed |
| Database — all scenarios | pgTAP 000 (2), 001 (39), 010 (46), 011 (18), 014 (44), 020 (79), 030 (37), 040 (63) — **8 files / 328 assertions**, all in CI's `database` job | "Empty replay and realistic upgrade" has never been run anywhere (no Docker on either builder machine). **`src/contracts/database.types.ts` has never been committed**, so §16's "generated types" scenario has *no* control — CI prints "no generated types committed yet", a notice that has been false since T-003 merged. Closing this is a prerequisite, not a finding |
| Tenant/source ACLs — incl. project restrictions and derived history/citation leakage | read predicates in `knowledge_core.sql:434-502`; RLS + negative tests in `020` | The project-restriction half (`060`, T-214) and the derived-history half (T-104/T-214) do not exist yet. This row is the one M1-PILOT most depends on |
| White-label — login/chat/errors/favicon/metadata/manifest/email in 3 modes, mobile, contrast | `components/auth/brand-modes.test.tsx` (7) and the brand rules in `platform/branding/` | chat + email + manifest + metadata rows need T-204 and T-105; screenshots (T-131) still owed |
| Ingestion — oversized/misidentified/corrupt/malicious documents, OCR failure, duplicate/out-of-order events, stale job, index switch | capture path: `object-validator`, `pdf-text-extract`, pgTAP `040`; **every upload route answers 503** because `src/platform/knowledge/upload-adapters.ts:19` is a deliberate `null` | Everything that needs a real object: the storage path, the extractor loop, lease expiry, and the **stale-job / index-switch** rows (T-211, T-212, T-113) |
| Retrieval — exact IDs/provision numbers, semantic, incompatible embeddings, filtered recall, historical intervals, conflicting authorities, insufficient coverage, **legitimate empty versus backend failure** | `retrieval/embeddings.ts` (the clearance/dimension gate); hybrid RPC open as [#160](https://github.com/TerraOI/TerraOI/pull/160)/[#162](https://github.com/TerraOI/TerraOI/pull/162), not merged | All of it, plus the **Recall@10 number** the scorer in #162 can only produce against a real database |
| Chat — forged history/tool parts, cross-tenant conversation ids, duplicate submit, cancel/disconnect/reload, progress without candidate leakage, audit failure, provider timeout | contracts and `agents/compose.ts` only | T-104/T-203 own the code; this packet runs the rows and must not accept a pass that was never persisted-and-audited first (§9.3) |
| Budget/provider — simultaneous requests near ceiling, ambiguous billing, retry/fallback, failed ledger | the gateway's **seam**: `MeterPort`, reserve-before-call, fail-closed `budget_authority_unavailable`, reconcile incl. ambiguous (`gateway/call.ts`) — the only implementation is the test meter | A real authority (T-313, T-116) or the row is marked **not covered** |
| Model chain — box offline/slow/garbage, allowance exhausted, 429 storm, `client_confidential` never reaching DeepSeek/OpenRouter, `restricted` + box offline → `unavailable`, verifier ≠ composer, embedding route down → labelled lexical lane, circuit open/close | the strongest-covered area: `call.test.ts` (clearance, chain walking, metering), `route.test.ts`, `verify-binding.test.ts`, `claude-adapter.test.ts` (10 tests on a real socket), `provider-boundary.test.ts` | the **box-offline drill** ([#74](https://github.com/TerraOI/TerraOI/issues/74) → T-314), the staging external-mock probe, and the two-provider gap (DeepSeek/OpenRouter adapters) |
| Forms/OCR — invalid values vs template version, template changed mid-draft, low-confidence scan, lease expiry, duplicate completion, revoked source aborts an in-flight job | nothing | T-301 + T-211; this row is entirely ahead of us |
| Operations — provisioning, suspension, restore to an isolated environment, index rollback | nothing (`scripts/provision-tenant.mjs` absent) | T-304 + the §17.2 restore rehearsal, which is a human step |
| Domain / Actions | **excluded** (§20.5) | — |

## Acceptance tests (write first)

- [ ] a filled table above in this packet, with one artifact id per M1 row (CI job id, pgTAP file + count, loopback test name, or a staging capture) — **no row says "passed" on unit evidence alone** ([COORDINATION §6a](../COORDINATION.md))
- [ ] `pg_dump` of a fresh staging database matches the merged migrations in filename order, run on a disposable copy ("empty replay and realistic upgrade"), pasted in the week-4 register
- [ ] `pnpm db:types` output committed and CI's generated-types drift step **actually runs** for the first time (FAQ-0009: never take types from a run whose pgTAP failed)
- [ ] every §16 Chat row is exercised at the HTTP boundary through a loopback harness, not in-process ([COORDINATION §6a](../COORDINATION.md): `listen(0)`, closed in `afterAll`)
- [ ] for each of the 12 areas: either an artifact, or a row that says **not covered** and names the packet that would cover it. A silent blank is a finding
- [ ] any row this packet fixes has a test that failed first (AGENTS §5.2)

## Done evidence

`pnpm verify`; the CI `database` job id with its `All tests successful. Files=N, Tests=M` line; `pnpm cf:preview` or the staging deployment id for each staging row; this packet's table pasted into `docs/status/2026-W49.md` with Observed/Reported labels. A row whose staging step cannot run stays **owed** and names the T-004 §20.8 human step that unblocks it — the gate does not move because a builder machine lacks Docker.

## Out of scope

Threshold tuning (plan T-403, whose packet does not exist yet) — this packet reports numbers, it does not chase them. Adversarial construction is [T-402](./T-402-red-team-pass.md). Connectors, exports, drafts/actions, domain modules (§15.0 deferred column). Production environment work (§20.8).

## Assumed, decision owed

- **Who may call this packet "run"** — §15.2 makes the M1 subset part of the supervisor's sign-off, so a builder marking a row "passed" is a claim, not a gate. This packet proposes: builder pastes artifacts, supervisor writes the verdict.
- **`database.types.ts` needs a decision before week 4**, not during it: no builder machine can regenerate it (no Docker; [#122](https://github.com/TerraOI/TerraOI/issues/122) closed with the FAQ-0009 artifact route). If the artifact route stays the only one, §16's "generated types" scenario is pinned to a CI-side check that has never run.
