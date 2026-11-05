# T-213 Review queue, publication policy, revoke and derived-output invalidation

Lane: 2 · Week: 2 · Protected: yes (`supabase/migrations/`) · Depends on: T-111, T-112, T-113, T-114 · Status: ready
Plan refs: §7.2 steps 7–9, §7.5 (revocation within 60 s), §6.2, §16 (tenant/source ACL row); F13, F14, F27

## Goal
Knowledge becomes publishable under policy instead of automatically: versions that need a human wait in
a review queue, publication activates a complete version atomically, and a revoke stops new retrieval
within 60 seconds and marks every derived answer, summary and cache entry for revalidation — without
ever letting a stale job resurrect the source.

## Owns (may edit)
- `src/platform/knowledge/` (publication policy, review queue, publish, revoke, invalidation)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_review_publish.sql`: collection publication-policy
  columns, the review-queue table and `answer_source_dependencies` for derived-output invalidation —
  timestamp agreed in the daily sync; migrations are protected, merged migrations are never edited
- `supabase/tests/database/050_review_publish.test.sql`, `src/platform/knowledge/*.test.ts`
- `src/app/api/knowledge/review/` as a thin Lane 2 handler, PR labeled `cross-lane`; the queue **page**
  is Lane 1 (`src/components/knowledge/`) under T-202/T-302

## Must not edit
`src/contracts/`, merged migrations, `src/platform/chat/` and `src/platform/notifications/` (Lane 1
consumes the events this packet emits), the search SQL of T-114 beyond the state filters this
migration owns

## Contract
F13 `publishKnowledgeVersion` → `publish_knowledge_version_v1`; F14 `revokeSource` → `revoke_source_v1`;
`review_decision_v1` (approve or reject, with actor and reason). The state set is fixed in
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md):
`awaiting_review → published`, plus `superseded / revoked → deleting → deleted`.
[`Answer.dataClass`](../../src/contracts/answer.ts) and
[`maxDataClass`](../../src/contracts/data-class.ts) keep derived rows at the highest class, and the
search RPC of [T-114](./T-114-search-corpus.md) sees only database state. Whether a collection may
require an **independent** reviewer (uploader ≠ approver) is a data-policy decision: ask with
`needs-supervisor` before encoding it.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/050_review_publish.test.sql` — an approving reviewer switches
      the active pointer in one transaction, the prior version becomes `superseded`, and
      `search_corpus_v1` returns the new version only
- [ ] positive: a low-risk internal note auto-publishes where the collection policy allows, while a
      `requirement`-authority SOP or operational correction stays in `awaiting_review`
- [ ] negative: same file — a company1 reviewer cannot act on a company2 version, and a member without
      the review permission is refused rather than quietly downgraded
- [ ] negative: after `revoke_source_v1` commits the same search returns zero rows immediately (no
      re-index), citations and history re-reads for that source are refused, and an in-flight or
      retrying job cannot republish it
- [ ] negative: revoke writes one `answer_source_dependencies` row per affected derived output, and each
      derived row keeps the **highest** data class it inherited before the revoke
- [ ] failure: a duplicate review decision or duplicate outbox event is a no-op; publishing a version
      whose embedding is incomplete is refused; revoking during `extracting` aborts the job

## Done evidence
`pnpm db:test`, `pnpm verify`; staging: publish one Company1 PDF through the queue, ask the expert and
get a cited answer, revoke it, then re-run the search **and** re-open the old citation within 60 seconds
and show both refused, with the invalidation rows pasted.

## Out of scope
Reviewer UI polish (T-202/T-302), retention and legal hold, export purge (no exports in M1, §20.5),
connector deletion handling, revalidation **jobs** for saved answers (plan §15.0 "Deferred after M1").
