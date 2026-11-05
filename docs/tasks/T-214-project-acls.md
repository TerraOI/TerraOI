# T-214 Project-scoped ACLs through retrieval, citations and history

Lane: 2 · Week: 2 · Protected: yes (`supabase/migrations/`) · Depends on: T-111, T-114, T-213, T-104 · Status: ready
Plan refs: §6.2 (read predicate, derived outputs), §8.2, §16 (tenant/source ACL row), §20.4 item 5; F08, F16, F17, F24

## Goal
Project is a real information boundary, not a label: one access decision decides what retrieval
returns, what a citation will open and what conversation history may show, so removing someone from a
project (or deactivating them) stops their access to Site A's sources in all three paths at once.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_project_acl.sql`: `source_acl_bindings`,
  collection/project audience enforcement and the `authorize_source_access_v1` RPC — timestamp agreed
  in the daily sync; migrations are protected and merged migrations are never edited
- `src/platform/retrieval/` (project predicates, the shared decision client), `src/platform/knowledge/acl.ts`
- `supabase/tests/database/060_project_acl.test.sql`, `src/platform/retrieval/*.test.ts`

## Must not edit
`src/contracts/`, merged migrations, `src/platform/chat/` and the Lane 1 half of `src/app/` — Lane 1
calls this packet's decision function, so request a change through
[COORDINATION.md §2](../../docs/COORDINATION.md) rather than editing it here; `src/platform/gateway/`

## Contract
`search_corpus_v1(p_organisation_id, p_service_keys, p_project_id, p_collection_ids, p_query_text,
p_query_embedding, p_embedding_index_id, p_effective_on, p_authority_filters, p_limit)` from
[T-114](./T-114-search-corpus.md), including plan §8.2's rule that an invalid project is an **error**
and never a silently dropped filter that widens the search. F08 `authorizeSourceAccess` is implemented
once as `authorize_source_access_v1(uuid)` and reused by citation access (F24, called from
[T-203](./T-203-chat-ux.md)) and history loading (F17), on top of `set_tenant_scope(uuid)`,
`is_active_member(uuid)` and `is_project_member(uuid)` from the merged tenancy migration
`supabase/migrations/20261105060000_tenancy_core.sql` (lands with T-003).

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/060_project_acl.test.sql` — a Site A member retrieves the
      project-restricted chunk; a company1 member outside Site A gets zero rows for the same query
- [ ] negative: same file — a company2 member never sees the row whatever ids they pass, and a member
      whose project membership was removed sees it in no lane on their next request
- [ ] negative: passing another tenant's or a nonexistent `p_project_id` raises; a `p_collection_ids`
      value the caller may not read narrows to nothing and never widens the search
- [ ] negative: a `client_confidential` collection without a project cannot be created or published, and
      a source shared into two projects stays invisible to a member of neither
- [ ] negative: citation and history call the same function — evidence for a project the user no longer
      belongs to is withheld from a saved answer instead of the answer being quietly rewritten
- [ ] failure: archiving a project stops returning its sources; a `policyRevision` bump mid-run
      (membership removed while the run is in flight) re-checks before delivery and withholds; a cached
      or already-embedded result for a de-projected source is refused

## Done evidence
`pnpm db:test`, `pnpm verify`; staging: publish a `client_confidential` Site A document, answer a
question about it as a Site A member, remove that member from Site A, then show retrieval, the open
citation and the saved conversation all refuse within one request.

## Out of scope
Groups and richer ABAC, connector ACL mapping and tombstones (deferred after M1), a per-source ACL
editor UI, export and printed-report leakage (no exports in M1, §20.5), retention and hold policy.
