# Chat protocol

Schemas: [`chat.ts`](../../src/contracts/chat.ts), [`answer.ts`](../../src/contracts/answer.ts) ·
Plan §9.2–§9.4, §10.1, §12.1 · Functions F17, F21–F24, F29

## Request

`ChatRequest` is TerraOI's **logical** contract. The route normalizes the pinned AI SDK envelope
into it, then validates. It has no organization, user, role, host or data-class field: those come
from the verified session and host only. `idempotencyKey` identifies the logical run, so a retry
or a reconnect reuses it and a deliberate new question gets a fresh one (plan §9.2).

`projectId` is a **filter, not a grant** (issue #16 N5). The route must reject a value that is not
in `TenantContext.permittedProjectIds` before any retrieval runs — as `out_of_scope` or the
generic no-access response, never by disclosing that the project exists (§8.2). A missing
`projectId` means "the projects this employee may see in this service", which the server computes
from the same context; the client never sends a list. Checking it is not optional: the retrieval
lane trusts the context, not the request.

Client-forged assistant/system/tool turns are rejected because `message` is a strict single-user
object; history is reloaded from authorized server state (F17), never from the transcript.

## Progress, then a verified answer

`ProgressEvent` is a discriminated union over `routing | searching | reading_records | verifying
| tier_changed`. Nothing in it can carry factual text, SQL, record ids or provider names:

| Event | What an employee may learn | Guard |
|---|---|---|
| `routing` | which expert is suggested and how confident the suggestion is (F29) | below threshold → the UI asks the employee to choose; an explicit pick always wins |
| `searching` | search started, and `retrieval_mode: lexical_only` when the pinned embedding route is down (§8.1) | degraded quality is stated, not hidden |
| `reading_records` | which tool keys ran | keys only, so hidden records are not disclosed (§8.2) |
| `verifying` | the answer is being checked (§12.1 pass 1 and 2) | — |
| `tier_changed` | "using a backup model; this may take longer", with chain positions | provider names are tenant-admin detail (§9.3); `reason` is the closed `TierChangeReason` enum (`provider_unavailable`, `quota_exhausted`, `clearance`, `capability_tier`, `composing_model`, `output_rejected`, `deadline`), so no free text can leak a provider, model or internal error (issue #16 N5) |

Unverified candidate text never reaches the browser (AGENTS.md §4.5, TOI-ADR-07). The final
`Answer` is persisted with audit and usage **before** delivery (F22); a client disconnect does not
prove a provider call was cancelled or unbilled.

## Answer and evidence

`Answer` requires `unknowns` and a `dataClass` (the highest class among the answer's
dependencies, §6.2). Rules the schema enforces:

- a `source_fact`, `requirement` or `record_fact` claim needs at least one `EvidenceRef`;
- an `inference` with no evidence must state a `limitations` entry, and is labeled;
- `status: answered` needs at least one **non-inference claim that carries evidence**; an answer made
  only of inferences, however many, is `partial` at best (issue #16 N2). `refused`, `partial` and
  `unavailable` may have none;
- evidence rows are typed (`chunk` with source version + chunk + span, `record` with tool call +
  record version + observed-at, `form_field` with submission + field path + template version);
  spans are ordered, and a URL or signed object reference cannot be represented.

Citation access is a separate call (F24): `GET /api/evidence/:id` re-authorizes and mints a fresh
short-lived URL. An answer never stores one (plan §4.4).

Verification states are recorded per claim: deterministic binding
(`binding_passed` / `binding_failed`) then semantic entailment
(`supported` / `partial` / `unsupported` / `contradicted`) from a different model at or above the
expert's `minVerifierTier` (§12.1). With no eligible verifier, `requirement` claims are withheld
and the answer is returned `partial` with the limitation shown.
