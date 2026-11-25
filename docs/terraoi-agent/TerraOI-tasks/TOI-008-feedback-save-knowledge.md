# TOI-008 T-302 feedback buttons, Save as knowledge, reviewer queue

Source: [T-302](../../tasks/T-302-feedback-save-knowledge.md), plan §7.4, §6.2, rulings #73/#39/#21/#102. Status: **VERIFY** (local evidence complete; staging + supervisor review of the protected migration owed).

## Built
| Layer | Files |
|---|---|
| SQL (protected) | `supabase/migrations/20261125110000_chat_feedback.sql`: `chat_feedback` (one row per user per run, RLS own-read, no direct writes), `rate_answer_v1`, `list_submission_collections_v1` (audience picker), `list_knowledge_submissions_v1` (reviewer queue / own submissions); `001` allow-list +3 |
| pgTAP | `supabase/tests/database/085_chat_feedback.test.sql` (22) |
| Server | `src/platform/chat/feedback.ts` (+test 10): rating, then for Incorrect / Suggest correction a #102 pilot eval draft built from the **stored** question and class (max of question and run); `submission-collections.ts`; `src/platform/knowledge/submission-queue.ts` |
| Routes | `POST /chat/feedback`, `GET /chat/collections` (`src/app/(tenant)/chat/…`); page `/knowledge/submissions` |
| UI | `src/components/chat/feedback.tsx` (+test 4) under every delivered answer; `src/components/knowledge/submission-review.tsx` (+test 4) |
| Generated | `database.types.ts` regenerated |

## Acceptance mapping
| Packet item | Evidence |
|---|---|
| rating writes one row keyed to run, never mutates answer; correction text goes to the submission draft | 085 #4-7; feedback.test.tsx #1-2 |
| save form shows cited sources and requires confirming the audience | feedback.test.tsx #3 (submit disabled until collection chosen **and** confirmed; cited version ids + class floor sent) |
| second rating updates the one row | 085 #5-6 |
| other tenant sees no rating/submission; suspended cannot rate | 085 #13-15, #18, #22 |
| Site A-only answer cannot be saved by non-member; author never an approver; class never lowered | picker hides Site A from non-members (085 #16-17); `submit_employee_knowledge_v1` re-checks readability and class (T-302b, pgTAP 087); author has no controls (submission-review.test #2) and SQL refuses (087) |
| revoked source / removed membership → refused, not saved; forged run → refused; instruction-shaped text stored as data; empty/oversized → validation | 087 (submit re-auth of cited versions); 085 #8, #10-13; feedback.test.ts 42501 + 422 table |

## Notes
- `user_may_review_knowledge` (T-213) counts `knowledge.write` as reviewer; the seeded contributor (a2) therefore sees a reviewer queue limited to readable collections. Kept as T-213 defined it.
- The #102 draft trusts nothing from the browser: question/expert/class are read with the caller's token from `chat_get_run_v1` + `chat_load_conversation_v1`.
