# TOI-009 T-402 red-team pass (local legs)

Source: [T-402](../../tasks/T-402-red-team-pass.md), plan §16 (Host/session, Tenant/source ACLs, Chat, Ingestion), §6.2, §9.3, §14.1 step 2. Status: **VERIFY (local legs)** — staging legs need T-004 (owner).

## New evidence: `supabase/tests/database/110_red_team_bait.test.sql` (24 assertions, 22 pass + 2 recorded findings as pgTAP `todo`)
Run against the composed tree (main + 75 PRs + agent work), PG16 shim.

| Packet box | Assertions | Result |
|---|---|---|
| cross-tenant bait | 1-4: zero evidence rows, no company1 text/id on the diagnostics row, foreign org id → 28000 on hybrid and exact lanes | pass |
| cross-project bait | 5-6: Site A client_confidential note never retrieved outside Site A, retrieved inside | pass |
| membership revoked mid-session | 11-18: suspension bumps policy revision; history list, transcript, rating, submissions, retrieval all refuse (28000); direct SELECT empty | pass |
| direct RPC abuse | 7-10: anon executes none; subject-less authenticated → 28000; capture and review-queue calls naming another tenant → 28000 | pass |
| object and credential handling | 19-20: provider/route/health/policy/budget/model-chain tables unreadable; no public column shaped for a URL capability/secret | pass |
| | 21: **R-1** `embedding_indexes.provider_key/model` readable by members under scope | finding (todo) |
| | 22: **R-2** `ingestion_jobs.lease_token` readable by members under scope | finding (todo) |
| instructions inside documents | 23-24: bait chunk returned verbatim as data, nothing written | pass (model side below) |

## Already covered elsewhere (cited, not duplicated)
| Box | Where |
|---|---|
| forged chat history / identity fields | `src/platform/chat/envelope.test.ts` (assistant/system/tool turns dropped, organisationId/userId/role/host refused) and `http.test.ts` |
| spoofed routing headers | `src/proxy.test.ts`, `src/proxy.loopback.test.ts` (forged `x-toi-routed-host` overwritten on the wire) |
| injected instructions reaching the model | compose prompt fences evidence as data (`compose.ts` composeMessages); a forged `[evidence n] chunkId=…` header inside a chunk cannot bind, because pass 1 only accepts a quote found verbatim in the cited, retrieved chunk (`verify-binding.test.ts` 152-178) — **R-3** (low) |
| duplicate submit / idempotency | `035_chat_persistence` (same idempotency key → same run), `095` budgets reservations |

## Not run here
Staging captures (every box's HTTP-over-real-host leg), the box-offline drill and the #92 zero-request listeners on uncleared providers against a deployed Worker — need T-004.
