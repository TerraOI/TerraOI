# T-203 Chat UX: expert picker, evidence panel, citation open, history

Lane: 1 · Week: 2 · Protected: no · Depends on: T-103, T-104, T-114, T-115 · Status: ready
Plan refs: §9.1, §9.3, §4.4, §6.2, §8.2, §16 (chat and white-label rows); F17, F23, F24, F29 (picker half)

## Goal
An employee chooses from **only their permitted** experts, reads an evidence panel showing locators,
freshness, unknowns and limitations, opens a citation through a freshly re-authorized short-lived URL,
and resumes their own conversation history — the same surface working in a mobile drawer without
leaking anything a later access change has taken away.

## Owns (may edit)
- `src/app/(tenant)/chat/`, `src/app/api/evidence/` (the citation access route, F24),
  `src/platform/chat/` (history loading, conversation listing)
- `src/components/chat/`, `src/components/citations/`, `src/components/tenant-shell/` (nav collapse)
- `src/platform/chat/*.test.ts`, `src/components/chat/*.test.ts`

## Must not edit
`src/contracts/` (answer, evidence and progress shapes are fixed by T-002),
`src/platform/retrieval/` (T-114), `src/platform/gateway/` (T-115/T-215),
`src/platform/knowledge/` (Lane 2 owns source state)

## Contract
[`ChatRequest`, `ProgressEvent`](../../src/contracts/chat.ts) and
[`Answer`, `Claim`, `EvidenceRef`](../../src/contracts/answer.ts);
[`OpaqueId`](../../src/contracts/keys.ts) is the only evidence reference a client may hold. F24
`openCitation` re-authorizes, then mints a fresh short-lived object URL — an `Answer` cannot represent
a URL, so nothing durable is stored (plan §4.4). F17 history comes from authorized server state.
Protocol: [docs/contracts/chat-protocol.md](../../docs/contracts/chat-protocol.md).

## Acceptance tests (write first)
- [ ] positive: `src/platform/chat/conversation-list.test.ts` — history lists only the signed-in user's
      own conversations on this host; a second user on the same tenant sees none of them (§6.2)
- [ ] positive: `src/app/api/evidence/[id]/route.test.ts` — opening citation [1] re-checks source
      access and returns a short-lived URL, and the persisted answer row stores **no** URL or object key
- [ ] negative: same files — a conversation id from another tenant or another user returns a 404 with no
      content; an expert outside `TenantContext.permittedServiceKeys` is never listed and a forged
      `expertKey` is refused
- [ ] negative: a citation whose source was revoked (T-213) or whose project membership was removed
      (T-214) is refused when opened: the answer text stays, the evidence link does not
- [ ] negative: `searching` with `retrievalMode: lexical_only` is shown as reduced search quality and
      `tier_changed` shows chain-position wording only — no provider name or record id reaches the DOM
- [ ] failure: an expired or already-consumed evidence URL, a forged evidence id, and an attachment still
      in `processing` each produce a safe state; the answer never claims an unread attachment was read

## Done evidence
`pnpm verify`; staging: on `company1-staging.terraoi.app` open a cited answer at a phone viewport
(drawer plus collapsed nav), open a citation on a published PDF and capture the fresh URL, then show
the same evidence id requested as a company2 user returns nothing.

## Out of scope
Feedback buttons and "Save as knowledge" (T-302), drafts and actions, exports and printed reports,
forms (T-301), Auto multi-expert orchestration beyond the picker (T-311), async runs (deferred).
