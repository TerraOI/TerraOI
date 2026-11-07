# T-302 Feedback buttons, "Save as knowledge" (F15) and the reviewer queue UI

Lane: 1 · Week: 3 · Protected: yes (`supabase/migrations/` — the feedback rows only, see Contract) · Depends on: T-111, T-104 (unclaimed), T-202, T-203, T-213 · Status: ready
Gated by decisions: [#41](https://github.com/TerraOI/TerraOI/issues/41) (`create_collection_v1` has no owner), [#39](https://github.com/TerraOI/TerraOI/issues/39) (who may publish, hence who may approve), [#21](https://github.com/TerraOI/TerraOI/issues/21) (whether a data-class raise cascades to derived rows)
Plan refs: §7.4, §6.1 (Employee knowledge capture), §6.2, §15.0 ("Feedback buttons + Save as knowledge"),
§16 (Tenant/source ACL row); F15 (the review decision itself is [T-213](./T-213-review-publish-revoke.md)'s F13/F14)

## Goal
Every delivered answer carries **Useful**, **Incorrect**, **Suggest correction** and **Save as
knowledge**. Ratings are evaluation signals and never rewrite the stored answer. A save opens a
submission holding the proposed text, the provenance of the answer it came from, and an audience the
employee confirms; a reviewer approves or rejects it under the collection's policy and it becomes a
normal versioned source. Chat text never becomes company fact by itself (§7.4).

## Owns (may edit)
- `src/components/chat/` (the four controls, their disabled/failed states), `src/components/knowledge/`
  (submission list and the review queue page), `src/app/(tenant)/knowledge/submissions/`
- `src/platform/chat/` (feedback read/write calls over [T-104](./T-104-chat-skeleton.md)'s tables)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_chat_feedback.sql` for the rating rows only —
  `(run_id, user, kind, correction_text?)`, one rating per user per run, under RLS; timestamp agreed in
  the daily sync; merged migrations are never edited
- `supabase/tests/database/085_chat_feedback.test.sql`, `src/components/chat/feedback.test.tsx`,
  `src/components/knowledge/submission-review.test.tsx`

## Must not edit
`src/platform/knowledge/` and `src/app/api/knowledge/` (Lane 2 owns knowledge writes and its route
folders, [FAQ-0005](../../docs/FAQ.md)); `src/contracts/`; merged migrations; the chat tables T-104
creates beyond adding this packet's own feedback table. Ask for anything outside this list through
[COORDINATION.md §2](../../docs/COORDINATION.md) rather than editing it.

## Contract
F15 `submitEmployeeKnowledge` per plan §11: user correction/note + explicit audience and provenance,
submission/review lifecycle, and the rule that chat text never automatically becomes company fact.
`knowledge_submissions` fields come from §6.1; the text inherits the **highest** data class of the
answer it cites ([`maxDataClass`](../../src/contracts/data-class.ts), §6.2) and can be raised by a
reviewer but never lowered. Approval reuses T-213's `review_decision_v1` and the publication rules in
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md); independence is
compared against the server-set author, never a client-supplied one (#8).
**Split assumed, decision owed:** §20.2 assigns F15 to Lane 2 while §20.3 lists T-302 in the Lane 1
column, and no packet lists `knowledge_submissions` or its RPC in "Owns" — the same class of gap as
[#41](https://github.com/TerraOI/TerraOI/issues/41). This packet assumes Lane 1 owns the pages and the
rating rows and **calls** a Lane 2 `submit_employee_knowledge_v1`, and it needs the supervisor to
confirm that split (and answer #39, who may publish, and #21, whether a class raise cascades). Nothing
here writes a knowledge table. Identity into Postgres is settled: #37 closed with option (b), the opaque
session plus the user's own access token, so a submission is written as the user, under RLS.

## Acceptance tests (write first)
- [ ] positive: `src/components/chat/feedback.test.tsx` — a rating on a delivered answer writes one row keyed
      to the `run_id` and never mutates the answer, and "Suggest correction" carries its text into the
      submission draft rather than into the answer
- [ ] positive: `src/components/knowledge/submission-review.test.tsx` — the save form shows the answer's cited
      sources and requires the employee to confirm the audience before submitting
- [ ] positive: `supabase/tests/database/085_chat_feedback.test.sql` — a second rating from the same user for
      the same run updates that one row rather than adding a second signal
- [ ] negative: same file — another tenant sees no rating or submission row, a company2 user cannot name a
      company1 collection as the audience (composite FK `23503`), and a `suspended` membership
      (`left@company1.test`) can neither rate, save nor review
- [ ] negative: a member of neither project cannot save an answer whose evidence is Site A-only; the reviewer of
      a `client_confidential` submission must belong to the bound project; the author never appears as an
      eligible approver of their own submission; a save cannot widen an audience or lower a class, and the
      stored class equals the highest class of the answer's dependencies even when a "public" collection is
      picked
- [ ] failure: saving after the cited source was revoked (T-213) or project membership was removed (T-214) is
      refused with a re-read, not saved with a broken citation; a forged `run_id` from another conversation is
      refused; instruction-shaped correction text is stored as data and never obeyed (§4.8); an empty or
      oversized submission is a validation error with no partial write

## Done evidence
`pnpm verify`; `pnpm db:test` for the rating table (CI `database` job here); staging: rate one answer
three ways, save it as knowledge into a Site A collection, approve it as a different reviewer, then show
the same submission id requested on the company2 host returns nothing and the author cannot approve it.

## Out of scope
The `knowledge_submissions` table and its RPC unless the supervisor assigns them here (Contract above),
notification subscriptions (F27, later), saved-answer revalidation jobs (plan §15.0 deferred), turning
"Incorrect"/"Suggest correction" into eval cases (T-312/T-315), review-queue polish beyond the list,
and any training use of tenant data (§7.4: none by default).
