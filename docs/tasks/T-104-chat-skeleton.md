# T-104 Chat skeleton: same-origin `/api/chat`, typed progress, verified-only answer

Lane: 1 · Week: 1 · Protected: yes (`supabase/migrations/`) · Depends on: T-002, T-003, T-102, T-103, T-113, T-114, T-115 · Status: in progress (wyuinline) — **code complete; staging evidence owed** ([T-004](T-004-infrastructure.md) §20.8 / COORDINATION §6a). Open for review as [PR #178](https://github.com/TerraOI/TerraOI/pull/178) (`t-104-chat-skeleton`): migration `20261120216000_chat_persistence.sql`, `src/platform/chat/`, `/chat`, pgTAP slot **035**. Narrative evidence stays in the PR body (Round-1 B4). Branch: `t-104-chat-skeleton`
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
Each box below names the assertions that carry it. A box marked **CI** has an assertion that exists
but has not been executed here — there is no Docker in this worktree, so pgTAP runs only in CI's
`database` job. No box is claimed on staging.

- [ ] positive: the route normalizes the SDK envelope into `ChatRequest`; a client that posts
      `organisationId`, `userId`, `role` or `host` gets a 400, and those keys never reach the run
      — forged-key refusals land in this PR (`envelope.test.ts` / `http.test.ts`); the SDK envelope
      itself waits on stacked T-104b (Round-1 D1). Wire format here is interim until then.
- [x] **CI** positive (pgTAP `supabase/tests/database/035_chat_persistence.test.sql`): a persisted answer row
      carries `data_class` equal to the highest class of its cited sources and its source-version
      dependency ids, so T-213 and T-214 can invalidate or withhold it
      — 035 26-28 (a caller that declares `public` is stored `internal`), 41-42 (one `public` and one
      `client_confidential` citation store `client_confidential`, each dependency row keeping its own
      source's class)
- [x] negative: a conversation id belonging to another tenant or another user is not loaded
      (404/forbidden, no content leak); an expert the user may not use is refused
      — 035 57-58 (another tenant's conversation and run ids, both `42501`, no existence signal),
      61-63 (a co-worker, including the tenant admin); `experts.test.ts` and `http.test.ts` return one
      indistinguishable 403 for an unknown expert and an ungranted one
- [x] **CI** negative (pgTAP): another tenant, a second user in the same tenant and a deactivated member read
      no conversation, message or run rows; no storage column can hold a signed URL
      — 035 59-60 (a company2 member sees zero company1 rows through the plain SELECT: this is the
      assertion removing RLS would break), 64-66 (a suspended membership cannot even establish the
      scope), 67 (tenant member, not project member), 68 (admin with no `chat.ask` row), 69 (no
      grant- or storage-shaped column name anywhere in the migration)
- [x] negative: a forged assistant/system/tool part in the request body is ignored; history comes
      from authorized server state (F17)
      — `envelope.test.ts` drops and counts forged turns, keeping only the newest real user turn;
      035 75 makes a forged `assistant` turn unrepresentable in storage as well; the panel never
      posts a transcript back as history (`page.test.tsx` pins the posted key set)
- [x] negative: no factual token is emitted before the answer is verified and persisted — assert
      the stream contains only the five progress event types before the final frame
      — `run-chat.test.ts` (every frame before the last is one of the five types; a store refusal at
      `complete_run` yields `persisted: false` and `"claims":[]`), `stream.test.ts` (`encodeFrame`
      refuses to serialize claims without the persistence flag — the property is the transport's, not
      one call path's), `page.test.tsx` (nothing but progress labels renders before the answer frame)
- [x] duplicate submit with the same `idempotencyKey` returns the same run, not a second
      expensive one; disconnect then reload resumes the same run
      — 035 21-25 (**CI**: the unique `(organisation_id, idempotency_key)` conflict hands back the
      existing run id), `run-chat.test.ts` (a resumed run emits one frame, dials no search and no
      adapter), 035 17-19 (**CI**: a repeated `clientMessageId` does not duplicate the question)
- [x] failure: retrieval empty → `refused` with `no_evidence` template and zero claims;
      both the refusal and its audit are persisted before delivery
      — `run-chat.test.ts` (empty retrieval: zero adapter calls, zero meter reservations, the refused
      row written before the frame is emitted), 035 49-53 (**CI**: the refusal keeps its answer json,
      its class and no invented evidence row)
- [ ] failure: gateway unavailable → `unavailable`; persisted and audited before delivery
      — asserted through the injected fail-closed seam (`gateway: null` → `unavailable` persisted,
      claims withheld from the wire), but no production gateway bundle exists yet, so this half stays
      open until T-115 / T-004 staging can close it

## Done evidence
`pnpm verify`, `pnpm db:test` (pgTAP for the new tables; no Docker locally means the CI `database`
job); staging: ask the GPR expert a question answerable only from a just-published
Company1 PDF, capture the SSE frames (progress then final `Answer`), and show that the same
question on the company2 host returns `refused`.

## Out of scope
Evidence panel polish, citation preview re-authorization (T-203), feedback buttons (T-302),
multi-expert Auto mode, async runs, drafts/actions.
