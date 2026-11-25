# Staging corpus load runbook (T-315)

**Status: prepared; staging evidence owed.** This file is the load plan for company1-staging.
Uploading real Client corpora, minting storage credentials, and flipping the box tunnel are owner
actions (plan §20.8, AGENTS.md §6). Agents prepare and validate only.

Plan refs: §14.1 steps 1–2, §7.1–§7.2, §20.3 week 3. Capture RPCs:
`begin_upload_session_v1` / `register_source_version_v1`
([`20261106100000_knowledge_uploads.sql`](../supabase/migrations/20261106100000_knowledge_uploads.sql)).
Embedding generation is E1 for every tenant ([ADR-0007](../docs/decisions/0007-e1-embedding-clearance.md)):
`@cf/baai/bge-m3`, 1024 dims, cosine; `cleared_for` = `public` + `internal` + `client_confidential`.

## 1. What this runbook never does

- Commit client document bytes, quoted client sentences, object keys, or real site identifiers
  (AGENTS.md §4.7).
- Approve eval cases — that is the UAV/GPR leads' weeks 3–4 work (plan §20.8).
- Bypass capture, review, or publish. There is no pilot special case.
- Target `local_box` by inserting a second job row (#66): retarget is a guarded UPDATE through the
  job API once T-211's path is live; until then, scanned PDFs stay on the cloud extract queue or
  wait as "queued for OCR" when the box is offline (T-211 / T-314 drill).

## 2. Collections and projects (synthetic staging map)

Replace `<staging-*>` UUIDs when the owner provisions company1-staging. Keys below are the
**labels** the load script and the drafted cases already use.

| Label | Collection (service) | Project | Data class | Notes |
|---|---|---|---|---|
| `synth-uav-manuals` | UAV manuals (`uav-compliance`) | tenant-wide (`null`) | `internal` | SYNTH-UAV-MAN-* |
| `synth-gpr-manuals` | GPR manuals (`gpr`) | tenant-wide | `internal` | SYNTH-GPR-MAN-* |
| `synth-site-a` | Site A field notes | Site A project | `client_confidential` | project-scoped; invisible outside Site A |
| `synth-company2-bait` | *not loaded here* | — | — | Cross-tenant bait fixtures stay out of company1; cases name them only as refuse targets |

## 3. File list (synthetic fixtures the drafts already name)

Committed cases under `evals/*/drafts/` reference **only** `SYNTH-*` fixture ids. The staging load
uploads the owner-approved PDF/DOCX set that the leads map onto those ids (workbook outside the
repo). Do not invent fixture ids in this file.

Expected shape after load (per file):

| Stage | Expected state | Record |
|---|---|---|
| validate → extract | `extracting` → extracted | parser_generation |
| chunk → embed | indexed | chunk count, index_generation / corpus generation (E1) |
| review → publish | `published` or `awaiting_review` | `published_at`, source_version id |

**Box offline:** a scanned PDF stays in `extracting` as "queued for OCR" (T-211). That is a
successful load outcome for this runbook, not a failure. Restore the tunnel and confirm the circuit
closes (T-314 F37 / #74 drill) before re-running OCR.

**Unsupported type:** refuse with a safe message; never leave a half-ingested source version.

## 4. Timing (order-of-magnitude on staging)

| Step | Expect |
|---|---|
| Upload + validate (digital PDF/DOCX) | seconds–low minutes per file |
| Cloud extract | minutes; scales with page count |
| Local-box OCR (scanned) | minutes–tens of minutes; blocked while tunnel down |
| Chunk + embed (E1) | minutes per published version |
| Review/publish | human; not timed here |

## 5. Draft eval cases (this repository)

| Expert | Drafted files (F35 ignores `drafts/`) | §14.1 adversarial classes present |
|---|---|---|
| `uav-expert` | 56 under `evals/uav-expert/drafts/` | all six (see `cases.test.ts`) |
| `gpr-expert` | 58 under `evals/gpr-expert/drafts/` | all six |

Pilot-entry thresholds (§14.1) are measured on **approved** cases. Counts below are **drafted**,
not approved — approval is weeks 3–4 lead work:

| Measure | Pilot-entry bar | Drafted today (both experts) |
|---|---|---|
| Cases per expert | ≥ 40 approved | 56 / 58 drafted |
| Must-refuse / clarify | ≥ 10 | see validators (caseType counts) |
| Cross-tenant / project bait | ≥ 5 | `isolationBait: true` drafts present |

F34 (`draftEvalCases`, T-312) may mint further `agent_drafted` rows from what actually published;
builders do not commit client-derived text. Pilot-feedback drafts (`origin: pilot`) stay in the
database only (#102) and never land under `evals/`.

## 6. Isolation check (company2)

After load, as a company2 member on the company2 host, the same hybrid query that returns Site A /
UAV rows for company1 must return **zero** rows. Paste the query and the empty result into
`docs/status/` with the staging evidence. The cross-tenant bait cases must score as **refusals**,
not answers, once F35 runs on approved fixtures.

## 7. Done when

- [ ] Manifest: each corpus file → final state, chunk count, corpus generation
- [ ] Drafted counts recorded as drafted (table above)
- [ ] `pnpm verify` green for `evals/**/cases.test.ts`
- [ ] company2 zero-row paste stored under `docs/status/`
- [ ] Box-offline scanned-PDF path observed once (or explicitly blocked on #66 / tunnel)
