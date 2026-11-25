# TerraOI requirement coverage and task status

Baseline taken 2026-11-25 on `origin/main` = `a0a6b3c` plus the 75 open PRs (27 stack tips). Classification is from code present and checks executed here, not from packet claims. "main" = merged; "PR" = only in an open PR (integrated on `terraoi/build`); evidence column says what was run.

## Baseline checks (executed)

| Tree | lint | typecheck | unit | pgTAP (shim) | build |
|---|---|---|---|---|---|
| `origin/main` a0a6b3c | pass | pass | 104 files / 1473 pass | 20 files / 1160 pass | Turbopack: env-blocked (fonts DNS) |
| `terraoi/build` (main + 75 PRs + fixes) | pass | pass | 186 files / 2074 pass | 34 files / 1664 pass | webpack + font mock: compiles, 45 routes (type step skipped, Q-04) |

## Packet coverage (plan §20.3)

| Packet | Plan | Code state | Class | Remaining (agent-actionable unless marked OWNER) |
|---|---|---|---|---|
| T-000..T-003, T-005 | §20.3 wk0 | main | done | — |
| T-004 infrastructure | §20.8 | — | BLOCKED (OWNER) | staging/prod accounts, DNS, secrets (Q-06) |
| T-101/T-101c host resolver, withTenantRpc | F01/F03 | main | partial | staging evidence (OWNER) |
| T-102/T-201 sign-in, password, Entra | F02 §4.2 | main (T-201 PR-2 #186 closed unmerged) | partial | invite claim / reset revocation / issuer allow-list (#186 scope) re-open; staging |
| T-103/T-204 shell + brand modes | F04 | main | partial | staging visual evidence |
| T-104 chat skeleton | F23 | PR #178 | partial | merge; staging |
| T-105 email transport | F28 | main | partial | provider secret (OWNER) |
| T-111/T-111b knowledge schema, collection admin | F08 | main | done | — |
| T-112 uploads/extract | F09/F10 | main + PR #223 | partial | merge #223; storage bucket on staging |
| T-113 chunk/embed/publish | F12/F13 | PRs #219/#282/#285 | partial | merge; real embed port (OWNER key); TOI-013 |
| T-114 search_corpus | F16 | main | done (code) | staging recall |
| T-115/T-116 gateway, provider config | F31/F38 | main | done (code) | provider keys (OWNER) |
| T-202 tenant admin | F06 | main + PRs #226..#237 | partial | merge stack |
| T-203 chat UX | F17/F23/F24 | `terraoi/build` (TOI-007) | partial | picker (Q-11), citation open (Q-10), staging |
| T-211 OCR worker | F32 | main + PRs #225..#283 | partial | merge; local box (OWNER) |
| T-212 DOCX/XLSX | F10 | PR #224 | partial | merge |
| T-213 review/publish/revoke | F13/F14 | PRs #267/#268/#271/#280 | partial | merge; review UI is in T-302 |
| T-214 project ACLs | F08 | PR #272 | partial | merge |
| T-215 verifier pass 2 | §12.1 | PRs #245/#246/#284 | partial | merge |
| T-216 condense + exact lookup | F30 | PRs #247/#258/#266 | partial | merge |
| T-301 forms | F33 | main + PR #220 | partial | merge |
| T-302 feedback + save-as-knowledge UI | F15 | `terraoi/build` (TOI-008) | partial | staging evidence |
| T-303 eval review view | §14.1 | `terraoi/build` (TOI-006) | partial | staging evidence; nav entry (Q-08) |
| T-304 kill switches, provisioning | F05 | main | done (code) | drill on staging |
| T-311 experts, routeExpert | F29 | PRs #221/#239/#279/#290 | partial | merge |
| T-312 eval harness | F34–F36 | PRs #222..#288 | partial | merge; nightly needs staging |
| T-313 budgets, run audit | F19/F22 | PRs #255..#278 | partial | merge; BUDGET_DB Hyperdrive (OWNER) |
| T-314 DeepSeek/OpenRouter, health | F37 | PRs #248..#276 | partial | merge; keys (OWNER) |
| T-315 staging corpora + cases | §14.1 | PR #252 (validators) | partial / BLOCKED (OWNER) | Company1 corpora + reviewers |
| T-401 M1 subset run | §20.5 | — | partial | **TOI-010** local half; staging half OWNER |
| T-402 red-team | §20.3 | `terraoi/build` (TOI-009) | partial | staging legs; R-1..R-3 fixes (Lane 2) |
| T-403 tune to thresholds | §14.1 | — | BLOCKED | needs approved cases + corpus (OWNER) |
| T-404 production readiness | §17.2 | PR #191 | partial | production half OWNER |
| T-405 dashboards/alerts | §17.1 | PR #192 | partial | panels need provider consoles (OWNER) |
| T-406 pilot onboarding | §20.3 | main (runbooks) | partial | inviting real users (OWNER) |

## Agent tasks

| ID | Task | Source | Status | Evidence |
|---|---|---|---|---|
| TOI-001 | Integrate all 75 open PRs on `terraoi/build`, resolve conflicts | §20.1, COORDINATION §3 | DONE | checks table above |
| TOI-002 | Re-timestamp 3 colliding migrations | COORDINATION §3 | DONE (on branch) | pgTAP 1664 pass; Q-03 |
| TOI-003 | Fix cross-PR test break (async `runExpertEval` vs F34 draft test) | T-312 | DONE | unit 2074 pass |
| TOI-004 | Regenerate `database.types.ts` for the integrated schema | FAQ-0009 | DONE | generator byte-identical on main; typecheck pass |
| TOI-005 | Docker-free pgTAP + typegen harness in `scripts/db-shim/` | §16 Database row | DONE | run.sh reproduces 1664 pass; gentypes byte-identical |
| TOI-006 | T-303 eval review view | T-303, §14.1 | VERIFY | [TOI-006](TerraOI-tasks/TOI-006-eval-review-view.md): pgTAP 091 30/30, unit +34; staging + supervisor review owed |
| TOI-007 | T-203 chat UX (picker, evidence panel, citation open, history) | T-203 | VERIFY (partial) | [TOI-007](TerraOI-tasks/TOI-007-chat-ux.md): history/resume + evidence panel done; picker BLOCKED Q-11, citation open BLOCKED Q-10 |
| TOI-008 | T-302 feedback controls + submission/review UI | T-302 | VERIFY | [TOI-008](TerraOI-tasks/TOI-008-feedback-save-knowledge.md): pgTAP 085 22/22, unit +18; staging owed |
| TOI-009 | T-402 agent-side red-team bait tests | T-402 | VERIFY (local legs) | [TOI-009](TerraOI-tasks/TOI-009-red-team.md): pgTAP 110 22 pass + findings R-1/R-2 as todo; staging legs owed |
| TOI-010 | T-401 local M1-subset evidence run | T-401, §20.5 | PENDING | — |
| TOI-011 | Push `terraoi/build`, open draft PR, comment collisions on PRs | user brief | BLOCKED | GitHub integration is read-only (403 on create_branch; comment tool denied); `git push` has no credential — Q-07. Delivered as bundle + patches in session outputs |
| TOI-013 | Check T-113 auto-publish against T-213 publication policy | §7.2, Q-05 | PENDING | — |
