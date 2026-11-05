# T-104 Chat skeleton: same-origin `/api/chat`, typed progress, verified-only answer

Lane: 1 · Week: 1 · Protected: no · Depends on: T-102, T-103, T-113, T-114, T-115 · Status: ready
Plan refs: §9.1–§9.4, §10.1; F17, F23 (and the client half of F21/F22)

## Goal
An employee picks an expert, asks a question on the tenant origin, sees typed progress events, and
receives only a **verified, audited** answer with citations — the walking-skeleton end of the loop.

## Owns (may edit)
- `src/app/(tenant)/chat/`, `src/app/api/chat/route.ts`, `src/platform/chat/`, `src/components/chat/`,
  `src/components/citations/`
- `src/platform/chat/*.test.ts`

## Must not edit
`src/platform/gateway/` (T-115), `src/platform/retrieval/` (T-114), `src/contracts/` (the request,
progress and answer shapes are already fixed by T-002)

## Contract
[`ChatRequest`, `ProgressEvent`](../../src/contracts/chat.ts) and
[`Answer`](../../src/contracts/answer.ts); the stream rules are in
[docs/contracts/chat-protocol.md](../../docs/contracts/chat-protocol.md).

## Acceptance tests (write first)
- [ ] positive: the route normalizes the SDK envelope into `ChatRequest`; a client that posts
      `organisationId`, `userId`, `role` or `host` gets a 400, and those keys never reach the run
- [ ] negative: a conversation id belonging to another tenant or another user is not loaded
      (404/forbidden, no content leak); an expert the user may not use is refused
- [ ] negative: a forged assistant/system/tool part in the request body is ignored; history comes
      from authorized server state (F17)
- [ ] negative: no factual token is emitted before the answer is verified and persisted — assert
      the stream contains only the five progress event types before the final frame
- [ ] duplicate submit with the same `idempotencyKey` returns the same run, not a second
      expensive one; disconnect then reload resumes the same run
- [ ] failure: retrieval empty → `refused` with `no_evidence` template and zero claims;
      gateway unavailable → `unavailable`; both are persisted and audited before delivery

## Done evidence
`pnpm verify`; staging: ask the GPR expert a question answerable only from a just-published
Company1 PDF, capture the SSE frames (progress then final `Answer`), and show that the same
question on the company2 host returns `refused`.

## Out of scope
Evidence panel polish, citation preview re-authorization (T-203), feedback buttons (T-302),
multi-expert Auto mode, async runs, drafts/actions.
