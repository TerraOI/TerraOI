# T-104 Chat skeleton: same-origin `/api/chat`, typed progress, verified-only answer

Lane: 1 · Week: 1 · Protected: yes (`supabase/migrations/`) · Depends on: T-002, T-003, T-102, T-103, T-113, T-114, T-115 · Status: ready
Plan refs: §9.1–§9.4, §6.1–§6.2, §10.1; F17, F22, F23 (and the client half of F21)

## Goal
An employee picks an expert, asks a question on the tenant origin, sees typed progress events, and
receives only a **verified, audited** answer with citations — the walking-skeleton end of the loop,
with the run persisted under RLS rather than kept in memory.

## Owns (may edit)
- `src/app/(tenant)/chat/`, `src/app/api/chat/route.ts`, `src/platform/chat/`, `src/components/chat/`,
  `src/components/citations/`
- `src/platform/chat/*.test.ts`, `supabase/tests/database/035_chat_persistence.test.sql`
- one migration `supabase/migrations/YYYYMMDDHHMMSS_chat_persistence.sql` (timestamp agreed in the
  daily sync; migrations are protected) creating `conversations`, `messages`, `agent_runs` and the
  answer↔evidence dependency rows: each stores `data_class` as the **highest** class among its
  dependencies (`maxDataClass`), the source-version ids it was built from, conversations private to
  their creator by default, and **no** column holding a signed URL or object key (#10)

## Must not edit
`src/platform/gateway/` (T-115), `src/platform/retrieval/` (T-114), `src/contracts/` (the request,
progress and answer shapes are already fixed by T-002), the merged migrations

## Contract
[`ChatRequest`, `ProgressEvent`](../../src/contracts/chat.ts) and
[`Answer`](../../src/contracts/answer.ts); the stream rules are in
[docs/contracts/chat-protocol.md](../../docs/contracts/chat-protocol.md). Persistence follows
[FAQ-0004](../../docs/FAQ.md): these tables are written only by scoped RPCs this packet owns, and
`Answer.dataClass` is stored, not recomputed at read time.

## Acceptance tests (write first)
- [ ] positive: the route normalizes the SDK envelope into `ChatRequest`; a client that posts
      `organisationId`, `userId`, `role` or `host` gets a 400, and those keys never reach the run
- [ ] positive (pgTAP `supabase/tests/database/035_chat_persistence.test.sql`): a persisted answer row
      carries `data_class` equal to the highest class of its cited sources and its source-version
      dependency ids, so T-213 and T-214 can invalidate or withhold it
- [ ] negative: a conversation id belonging to another tenant or another user is not loaded
      (404/forbidden, no content leak); an expert the user may not use is refused
- [ ] negative (pgTAP): another tenant, a second user in the same tenant and a deactivated member read
      no conversation, message or run rows; no storage column can hold a signed URL
- [ ] negative: a forged assistant/system/tool part in the request body is ignored; history comes
      from authorized server state (F17)
- [ ] negative: no factual token is emitted before the answer is verified and persisted — assert
      the stream contains only the five progress event types before the final frame
- [ ] duplicate submit with the same `idempotencyKey` returns the same run, not a second
      expensive one; disconnect then reload resumes the same run
- [ ] failure: retrieval empty → `refused` with `no_evidence` template and zero claims;
      gateway unavailable → `unavailable`; both are persisted and audited before delivery

## Done evidence
`pnpm verify`, `pnpm db:test` (pgTAP for the new tables; no Docker locally means the CI `database`
job); staging: ask the GPR expert a question answerable only from a just-published
Company1 PDF, capture the SSE frames (progress then final `Answer`), and show that the same
question on the company2 host returns `refused`.

## Out of scope
Evidence panel polish, citation preview re-authorization (T-203), feedback buttons (T-302),
multi-expert Auto mode, async runs, drafts/actions.
