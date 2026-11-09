# T-302b Knowledge submissions: table, routes and promotion (F15 data path)

Lane: 2 · Week: 3 · Protected: yes (`supabase/migrations/`, `src/app/api/knowledge/`, `src/contracts/`) · Depends on: T-213 · Status: ready
Plan refs: §6.1 (line 329), §6.2, §7.4, §9 route table, §11 F15; FAQ-0005; decided in [#73](https://github.com/TerraOI/TerraOI/issues/73)

## Goal
"Save as knowledge" creates a **submission**, never a source. A reviewer who is not the author
approves or rejects it, and an approved submission is promoted through the normal source pipeline, so
there is one write path into the corpus. [T-302](./T-302-feedback-save-knowledge.md) (Lane 1) builds
the screens and calls these routes.

## Owns (may edit)
- one migration for `knowledge_submissions`
- `src/app/api/knowledge/submissions/` (`POST /api/knowledge/submissions`,
  `POST /api/knowledge/submissions/:id/review`)
- the submission payload contract in `src/contracts/`, with its ADR
- `supabase/tests/database/087_knowledge_submissions.test.sql` ([COORDINATION.md §6b](../COORDINATION.md))

## Must not edit
`src/components/`, `src/app/` outside `api/knowledge/submissions/`; merged migrations; T-213's
review functions (call them).

## Contract
- `knowledge_submissions`: proposed text, provenance (the run and the cited source versions),
  audience, author, reviewer, expiry/review date, state `submitted → approved | rejected | withdrawn`,
  and `data_class`.
- **Data class** is the highest among its inputs: the answer's cited sources and the conversation
  context (§6.2; AGENTS.md §4.4). It can be raised, never lowered, and the target collection must
  clear it.
- **Who may submit:** an active member who can read the target collection (a proposal; it does not
  need `knowledge.write`, [#39](https://github.com/TerraOI/TerraOI/issues/39)).
- **Who may approve:** an eligible reviewer for that collection who is **not the author**
  (separation of duties; [#8](https://github.com/TerraOI/TerraOI/issues/8)).
- **On approval:** a `knowledge_sources` row of kind `note` plus a source version, which then follows
  the normal pipeline and publication policy (T-213). A promoted answer is never counted as independent
  corroboration of the sources it cited (§7.4).

## Acceptance tests (write first)
- [ ] positive: a member submits; a non-author reviewer approves; a `note` source version is created
      and enters the pipeline
- [ ] negative: RLS — another tenant, another project, a deactivated member
- [ ] negative: the author cannot approve their own submission
- [ ] negative: a submission's class is never lower than its inputs, and a collection that does not
      clear it is refused
- [ ] privileges ([#60](https://github.com/TerraOI/TerraOI/issues/60)): functions revoked and granted
      by name
- [ ] failure: a duplicate review request does not create a second source

## Done evidence
`pnpm verify`; the CI `database` job green with `087_knowledge_submissions.test.sql`; loopback route
tests (COORDINATION.md §6a).

## Out of scope
The screens (T-302); ratings (T-302); eval drafts from feedback (T-312, [#102](https://github.com/TerraOI/TerraOI/issues/102)).
