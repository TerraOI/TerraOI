# ADR-0013 Knowledge submission request payload (F15)

Status: **proposed** (lands with T-302b PR-2) · Date: 2026-11-23 · Deciders: Lane 2 (implementation); supervisor on merge of protected `src/contracts/`
Plan refs: §6.1 (line 329), §6.2, §7.4, §9 route table (lines 581–582), §11 F15; [#73](https://github.com/TerraOI/TerraOI/issues/73)

## Context

T-302b owns the F15 data path: a "Save as knowledge" action creates a `knowledge_submissions` row, never a source. Lane 1 (T-302) builds the screens and must POST a bounded JSON body to Lane 2's routes. Without a shared Zod contract, the UI and the route can drift on field names, data-class rules, or provenance shape — and a client-supplied organisation id would violate AGENTS.md §4.1.

The SQL half (`submit_employee_knowledge_v1` / `review_knowledge_submission_v1`) already decides class as `max(context, cited versions)` and refuses a collection that does not clear it. The HTTP body must therefore carry the **conversation context class** and cited version ids, not a final `data_class` the client chose.

## Decision

1. **`src/contracts/knowledge-submission.ts`** defines:
   - `KnowledgeSubmissionKind` — `note | answer | correction`
   - `CreateKnowledgeSubmissionRequest` — `collectionId`, `kind`, `proposedText`, `contextDataClass` (ingestible M1 classes only), optional `citedSourceVersionIds`, optional opaque `agentRunId`, optional `reviewBy`
   - `ReviewKnowledgeSubmissionRequest` — `decision: approve | reject`, optional `reason`
2. **No `organisationId` on either body.** Tenant comes only from `TenantContext` via `withTenantRpc`.
3. **No client-chosen final `dataClass`.** The server computes the inherited class; `contextDataClass` is an input to that computation, not the stored label.
4. **`agentRunId` is opaque** until T-104 / #178 lands `agent_runs`; it is provenance only and never authorization.

## Consequences

- Route handlers parse with these schemas before calling the RPC client.
- T-302 imports the same schemas for form validation.
- A later chat-run FK is additive (migration + optional contract field tightening), not a rename.

## Alternatives considered

- Let the client send `dataClass` directly — rejected: it can understate inherited class (§6.2).
- Omit `contextDataClass` and require at least one citation — rejected: a note with no citations still needs a conversation class floor.
