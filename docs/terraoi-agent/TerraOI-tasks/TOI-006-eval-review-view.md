# TOI-006 T-303 eval review view

Source: [T-303](../../tasks/T-303-eval-review-view.md), plan §14.1 step 3, §6.2, rulings #82/#102. Status: **VERIFY** (code + local evidence complete; staging evidence and supervisor review of the protected migration owed).

## What was built
| Layer | Files |
|---|---|
| SQL (new migration, protected path) | `supabase/migrations/20261125100000_eval_review_queue.sql`: `list_eval_review_queue_v1`, `get_eval_review_case_v1`, `decide_eval_case_v1`; RLS policy on `eval_cases` re-created with the source-audience predicate; `review_eval_case_v1` delegates to the same rules |
| pgTAP | `supabase/tests/database/091_eval_review_queue.test.sql` (30 assertions); `001` allow-list +4 |
| Client | `src/platform/evals/review-queue.ts` (+ test, 12) |
| Request boundary | `src/platform/evals/review-service.ts`, `review-adapters.ts` (+ test, 13); `admin-service.ts` now exports `resolveAuthenticatedContext`/`originAllowed`, `admin-adapters.ts` exports `resolvePostgrestBase` |
| UI | `src/app/(tenant)/evals/page.tsx`, `[caseId]/page.tsx`, `decide/route.ts`; `src/components/evals/{case-list,case-review,labels}.tsx` (+ test, 9) |
| Generated | `src/contracts/database.types.ts` regenerated |

## Acceptance mapping
| Packet item | Evidence |
|---|---|
| lead sees question, answer points, source version + locator, case type; approval records reviewer + time server-side | 091 #12-13; case-review.test "shows…", "approves with … only" |
| edit returns case to pending | 091 #15-16; case-review.test "an edit sends only the changed fields" |
| approved set is what export writes | unchanged T-312 export reads `status='approved'` (090) |
| company1 lead never sees company2 case; foreign id → no row, no existence signal | 091 #27-28; review-queue.test "returns null"; review-service.test "answers missing" |
| Site A client_confidential case hidden outside Site A, shown to member; cannot attach unreadable version | 091 #4-9, #20, #22 |
| suspended sees nothing; no permission → refusal | 091 #29-30; review-service.test "suspended" |
| revoked source → approval refused | 091 #24-26 |
| second decision → conflict, never overwrite | 091 #11, #14; review-service.test 409 |
| forged reviewer / unknown case type / answer points naming no source → validation, case unchanged | 091 #17-21; review-service.test 422 cases |
| guard spot-check (§20.4 item 2) | removing the visibility clause or the validity check turns 091 #4-6/#24 red (run 2026-11-25) |

## Open / owed
- No shell nav entry: the shell shows no nav links for anyone today and has no permission data; `/evals` is reachable by URL. Adding one needs the layout to resolve membership permissions (Lane 1 decision) — backlog Q-08.
- "only agent_drafted cases appear as drafts" conflicts with ruling #102 (show `pilot` drafts); the ruling was applied.
- Staging done-evidence (approve 10 / reject 2 on company1-staging) needs T-004 (owner).
