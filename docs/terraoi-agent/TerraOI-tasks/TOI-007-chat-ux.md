# TOI-007 T-203 chat UX (history, resume, evidence panel)

Source: [T-203](../../tasks/T-203-chat-ux.md), plan §9.1, §8.1, §12.1; F17/F24. Status: **partial** — slices 1 and 3 done (VERIFY), expert picker and citation open BLOCKED.

## Done (on `terraoi/build`)
| Slice | Files | Evidence |
|---|---|---|
| History list + resume (F17) | `src/platform/chat/conversation-list.ts` (+test 5), `transcript.ts`, `src/app/(tenant)/chat/history.tsx`, `page.tsx` (`/chat?c=<id>`), `chat-panel.tsx` (`initial`) | own list only (SQL: pgTAP 035); foreign / malformed / absent id → one sentence; withheld run keeps text, drops evidence — `chat-ux.test.tsx` |
| Evidence panel | `chat-panel.tsx` `AnswerBlock`, `chat.module.css` | numbered citations with span locators, `asOf` freshness, unknowns + conflicts + limitations + truncation; `lexical_only` labelled reduced search quality; `tier_changed` chain wording only; DOM test asserts no provider name or run id |
| Mobile | `.layout` collapses to one column ≤720px; history is a `<details>` drawer | CSS only; no visual run here |

Checks: `vitest src/app/(tenant)/chat src/platform/chat` 126 pass; typecheck, lint pass. One existing assertion in `page.test.tsx` updated: the lexical-only `searching` label now states reduced quality (packet requirement).

## Blocked
- **Expert picker** — production `NOT_WIRED_CATALOG` (ruling #83 / Round-1 B5) and `findExpert` knows only `PROVISIONAL_EXPERTS`; a picker fed from `list_authorized_experts_v1` would offer keys the run refuses. Needs the T-311 registry wired into `run-chat` (definitions with model chains via a privileged read, prompt bodies) — backlog Q-11.
- **Citation open (F24, `/api/evidence/[id]`)** — ADR-0011 makes `workers/object-signing.ts` the only URL minter (service role, extraction deployment) and `workers/import-boundary.test.ts` forbids another; Storage read RLS admits only the uploader's open session. A reader-facing signer is an architecture decision — backlog Q-10.
