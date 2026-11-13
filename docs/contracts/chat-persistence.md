# Chat persistence

Owner: lane 1 (T-104) · Migration: [`20261113020000_chat_persistence.sql`](../../supabase/migrations/20261113020000_chat_persistence.sql) ·
Tests: [`035_chat_persistence.test.sql`](../../supabase/tests/database/035_chat_persistence.test.sql) ·
Code: [`src/platform/chat/`](../../src/platform/chat/) · Plan §9.1, §9.4, §6.2 · Functions F17, F22–F24

Shape lives in [`chat.ts`](../../src/contracts/chat.ts) and [`answer.ts`](../../src/contracts/answer.ts).
This file records what a shape cannot say: who may write these rows, in what order, and what must be
re-checked at the moment an answer becomes durable. It is the persistence half of
[chat-protocol.md](chat-protocol.md), not a replacement for it.

## The four tables and who writes them

`conversations`, `messages`, `agent_runs`, `agent_run_evidence`. Every write goes through one of the
seven `chat_*_v1` RPCs this migration creates; `authenticated` holds **no** INSERT/UPDATE/DELETE on any
of the four, so there is no path that skips the checks (FAQ-0004). Each RPC takes
`p_organisation_id` as its first argument and opens with
`perform public.set_tenant_scope(p_organisation_id);` (FAQ-0011, #163): one PostgREST request is one
transaction, so the scope and the work are always in the same one, and nothing carries between calls.
The caller in TypeScript is [`store.ts`](../../src/platform/chat/store.ts), which cannot pass
`p_organisation_id` (compile error) and passes no actor at all — the actor is `auth.uid()` off the
signed-in user's own bearer.

There is deliberately **no user id in any chat request**. A conversation is created under the caller
and read back only by its creator; a run is read back only by the employee who requested it. Another
tenant, a second user in the same tenant, a suspended member and a project non-member each get a
refusal, not an empty result (035 tests 54-68): "no rows" and "not allowed" are different answers, and
collapsing them is how a tenancy bug reads as a quiet page.

## `chat_complete_run_v1` is the delivery gate

One call writes the run's answer, its dependency rows and the assistant history row, in one
transaction, or writes nothing at all. Before it writes, it:

1. re-reads every cited `source_version_id` **inside the current tenant** and refuses one it cannot
   make readable with `source_version_is_readable` — 42501, no dependency row (F24, §9.4; 035 46-48);
2. recomputes `data_class` as the highest among the cited sources, the class the caller declared, and
   the class the run started with (§6.2) — the stored class is the **database's**, not the caller's, and
   a caller cannot under-declare its way out of clearance (035 27-28, 41-42);
3. records each dependency row's own class from `source_versions`, so a later permission change can be
   traced to the exact source that caused it (what T-213/T-214 need);
4. refuses a completed run being rewritten, and refuses a second `complete_run` for the same run.

An answer frame may only be delivered once that write succeeded. `run-chat.ts` marks each frame
`persisted`, and `stream.ts` refuses to encode a frame that carries claims without it — so "no factual
token before the answer is verified and persisted" (F22) is a property of the transport, not a promise
about one call path.

`refused` and `unavailable` are persisted and audited like any other outcome. A run whose write was
refused is not delivered; what the employee sees instead is the expert's own template sentence with no
claims, and the run stays `running` for the stale-run sweep (T-214), which is stated rather than hidden.

## What must never be in these rows

No column and no answer-JSON key holding an object key, a signed URL, a storage bucket, a provider name
or a model id (#10, plan §4.4). `chat_answer_json_guard` rejects a stored answer whose JSON carries a
key matching that shape, `store.ts` validates every read against the `Answer` contract, and 035 asserts
both the guard and the absence of grant- or storage-shaped column names. A citation is a
`source_version_id` plus a quote and a span; opening the document is a separate, re-authorized call
(T-203).

`policy_revision` on `agent_runs` is the revision read at authorization time, stored with the run, so a
later "was this answer produced under the policy we think?" question has an answer (§9.4).

## Reads

`chat_load_conversation_v1` returns a conversation and its whole history to its owner, and
`chat_list_conversations_v1` returns the caller's own conversations newest-first. This is the server
state the surface rebuilds from after a reload or a disconnect; the transcript a browser posts is never
history (F17). Reading one's own history is not gated on the `chat.ask` permission area — withdrawing
the right to ask must not hide what was already answered. There is no admin view of other employees'
conversations: plan §13.1 is its own packet.

## Deliberately absent in T-104

`answer_run_outcomes` (T-214), the §13.1 admin surface, feedback and draft columns, and any expert
registry table (T-102c's `expert_grants`, T-113's `expert_versions`). Until those exist,
[`experts.ts`](../../src/platform/chat/experts.ts) holds one **provisional, in-code** `ExpertDefinition`
labelled `unevaluated` behind an `ExpertCatalog` seam — it is not a released expert and must be deleted
when the tables land.
