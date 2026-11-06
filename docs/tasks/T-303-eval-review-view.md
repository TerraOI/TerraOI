# T-303 Eval review view for the UAV and GPR leads (plan §14.1 step 3)

Lane: 1 · Week: 3 · Protected: no · Depends on: T-102 (a–d open as #30/#50/#52/#57; only e's test-only pgTAP #59 is merged), T-103 (unclaimed), T-312 (same week: the eval tables, `eval_cases`/`eval_reviews` and the F34 drafts must merge first) · Status: ready
Plan refs: §14.1 (steps 1 and 3), §6.1 (Evaluation group), §15.0 ("Eval review view for UAV/GPR leads"), §18.3 (named reviewers still open), §16; F34/F35 boundary (harness is [T-312](./T-312-eval-harness.md))

## Goal
The Company1 UAV lead and GPR lead sign in on their tenant host and see **only the candidate eval
cases their own authorization allows them to see**, each with its question, expected answer points,
expected source version and locator, and case type. They approve, edit or reject; the reviewer and the
time are recorded server-side, and nothing unapproved can enter a scored run. This is the human half of
TOI-ADR-17: agents draft, domain experts approve, and the pilot entry thresholds depend on it.

## Owns (may edit)
- `src/app/(tenant)/evals/`, `src/components/evals/` (case list, case detail, approve/edit/reject
  controls, the "why this case" panel showing the cited source locator)
- `src/components/tenant-shell/` (one nav entry, visible only to a member holding the review permission)
- `src/components/evals/*.test.tsx`
- no migration: the tables and the scoped RPCs are [T-312](./T-312-eval-harness.md)'s protected work

## Must not edit
`src/platform/evals/` and `evals/` (Lane 2 owns the harness and the approved fixture export),
`src/contracts/`, merged migrations, `supabase/seed.sql` (the review permission area is a decision, not a
data change this packet may make — see Contract); nothing in Lane 2 paths
([COORDINATION.md §2](../../docs/COORDINATION.md)).

## Contract
Reads and decides through the Lane 2 RPCs over `eval_cases` and `eval_reviews` as named in plan §6.1
(org, expert, question, expected answer points, expected source versions, origin
`agent_drafted | expert_written | pilot`; reviewer, decision, edits). The reviewer identity comes from
`TenantContext` ([`tenant-context.ts`](../../src/contracts/tenant-context.ts)), never from the page body
(AGENTS.md §4.1). A case is listed only when its expected source version passes the same read predicate
as retrieval, because §14.1 step 1 drafts only from collections the reviewing expert may see;
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md) governs that source's
state, and a revoked source makes its case invalid. §14.1 step 3 is the rule the UI must enforce:
approve, edit or reject, with reviewer and time recorded.
**Decision owed before claiming:** no packet owns who counts as an eligible reviewer. `seed.sql` seeds
only `chat.ask`, `knowledge.read`, `projects.read`, `knowledge.admin`, `members.admin` and
`projects.admin` permission areas, so an `evals.review` area is a scope decision for the supervisor, and
plan §18.3 still lists "Named UAV and GPR evaluation reviewers" as open (§20.8 makes that a human step).
This packet assumes a permission area named by the supervisor and adds no grant of its own.

## Acceptance tests (write first)
- [ ] positive: `src/components/evals/case-review.test.tsx` — a lead sees a drafted case with question,
      expected answer points, expected source version and locator, and case type, and approving records
      the reviewer and the time from the session
- [ ] positive: an **edit** returns the case to a pending decision rather than approving the old text, and
      the approved set is what Lane 2's export writes to `evals/<expert>/`
- [ ] negative: a company1 lead never sees a company2 case, and a case id from another tenant returns no
      row and no existence signal
- [ ] negative: a case whose expected source is a Site A `client_confidential` version is hidden from a
      reviewer outside Site A and shown to a member of it; approving can never attach a source version
      the reviewer may not read
- [ ] negative: a `suspended` membership (`left@company1.test`) sees and decides nothing, and a member
      without the review permission gets no nav entry and a refusal from the RPC
- [ ] negative: only `agent_drafted` cases appear as drafts, and a case drafted from a collection the
      reviewer cannot see is not listed even when its id is guessed
- [ ] failure: approving a case whose expected source has been revoked (T-213) is refused; a second
      decision on the same case is refused or recorded as a conflict, never silently overwritten
- [ ] failure: a decision posted with a forged reviewer, an unknown case type or an answer-point list
      that names no source is a validation error and leaves the case in its previous state

## Done evidence
`pnpm verify`; staging: as the seeded Company1 lead, approve 10 drafted cases and reject 2, edit one and
show it back in pending, then show the same case ids on the company2 host return nothing and that
`evals/<expert>/` contains only approved cases. The **count** evidence for §14.1's pilot-entry thresholds
(≥40 approved per expert, ≥10 must-refuse/clarify, ≥5 cross-tenant/project bait) is T-315's row.

## Out of scope
The harness, scoring and the CI/nightly runs (T-312), drafting cases (F34, Lane 2, and T-315's staging
run), authoring cases from domain knowledge in the browser beyond approve/edit/reject, dashboards and
alerting (T-405), naming the reviewers and granting their accounts (plan §20.8 human-only), and any
cross-expert coordinator (deferred after M1, §15.0).
