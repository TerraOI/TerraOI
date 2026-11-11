# T-213 Review queue, publication policy, revoke and derived-output invalidation

Lane: 2 · Week: 2 · Protected: yes (`supabase/migrations/`, `src/app/api/knowledge/`) · Depends on: T-104, T-111, T-112, T-113, T-114 · Status: ready
Plan refs: §7.2 steps 7–9, §7.5 (revocation within 60 s), §6.2, §16 (tenant/source ACL row); F13, F14, F27

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Reclass** ([#21](https://github.com/TerraOI/TerraOI/issues/21)): `review_reclass_v1` raises a collection and every descendant below the new class in one transaction with one audit row; pgTAP for the cascade, never-below-collection, refused `restricted` and tenant-wide `client_confidential` raises, another tenant refused, and E2 vector removal.
- **`policy_revision`** ([#98](https://github.com/TerraOI/TerraOI/issues/98)): attach T-202's `bump_policy_revision()` to publish and revoke; assert the move in `050`.
- **Tenant scope** ([#163](https://github.com/TerraOI/TerraOI/issues/163), FAQ-0011): every tenant-scoped RPC this packet adds takes `p_organisation_id uuid` **first** and begins with `perform public.set_tenant_scope(p_organisation_id);`, so it is `volatile`. Its TypeScript caller goes through `withTenantRpc` (T-101c). pgTAP pins the signature, the volatility, and a refusal for an organisation the caller is not a member of.

## Goal
Knowledge becomes publishable under policy instead of automatically: versions that need a human wait in
a review queue, an independent reviewer can be required and checked against who actually uploaded the
source, publication activates a complete version atomically, and a revoke stops new retrieval within
60 seconds and marks every derived answer, summary and cache entry for revalidation.

## Owns (may edit)
- `src/platform/knowledge/` (publication policy, review queue, publish, revoke, invalidation)
- `src/app/api/knowledge/review/` — Lane 2 owns this route folder ([FAQ-0005](../../docs/FAQ.md)), so
  this is ordinary Lane 2 work; the queue **page** is Lane 1 (`src/components/knowledge/`, T-202/T-302)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_review_publish.sql`: collection publication-policy
  columns including `review_independent`, and the review-queue table — timestamp agreed in the daily
  sync; migrations are protected, merged migrations are never edited
- `supabase/tests/database/050_review_publish.test.sql`, `src/platform/knowledge/*.test.ts`

## Must not edit
`src/contracts/`, merged migrations, `src/platform/chat/` and the chat tables created by
[T-104](./T-104-chat-skeleton.md) (Lane 1 consumes the events this packet emits), the search SQL of
T-114 beyond the state filters this migration owns

## Contract
F13 `publishKnowledgeVersion` → `publish_knowledge_version_v1`; F14 `revokeSource` → `revoke_source_v1`;
`review_decision_v1` (approve or reject, actor and reason). The state set is fixed in
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md):
`awaiting_review → published`, plus `superseded / revoked → deleting → deleted`.
**Independence, per #8:** `review_independent` defaults to on for `client_confidential` collections and
for requirement/authority sources, and the RPC compares the reviewer against the **server-set
`uploaded_by`** written by `register_source_version_v1` (#13(1)), never a client-supplied author.
Derived-output invalidation reads the `data_class` and source-version dependency ids T-104 stores
([`maxDataClass`](../../src/contracts/data-class.ts)), keeping each derived row at its inherited class.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/050_review_publish.test.sql` — an approving reviewer switches
      the active pointer in one transaction, the prior version becomes `superseded`, and
      `search_corpus_v1` returns the new version only
- [ ] positive: a low-risk internal note auto-publishes where the collection policy allows, while a
      `requirement`-authority SOP or operational correction stays in `awaiting_review`
- [ ] negative: with `review_independent` on, the uploader's own `review_decision_v1` is refused, and so
      is a company1 reviewer acting on a company2 version or a member lacking the review permission
- [ ] negative: after `revoke_source_v1` commits the same search returns zero rows immediately (no
      re-index), citations and history re-reads for that source are refused, and an in-flight or
      retrying job cannot republish it
- [ ] negative: each affected derived row (T-104's messages/answers and their dependency ids) is marked
      for revalidation and keeps the **highest** data class it inherited before the revoke
- [ ] failure: a duplicate review decision or duplicate outbox event is a no-op; publishing a version
      whose embedding is incomplete is refused; revoking during `extracting` aborts the job

## Done evidence
`pnpm db:test` (CI `database` job where the machine has no Docker), `pnpm verify`; staging: publish one
synthetic Company1 PDF through the queue, ask the expert and get a cited answer, revoke it, then re-run
the search **and** re-open the old citation within 60 seconds and show both refused.

## Out of scope
Reviewer UI polish (T-202/T-302), retention and legal hold, export purge (no exports in M1, §20.5),
connector deletion handling, revalidation **jobs** for saved answers (plan §15.0 "Deferred after M1").
