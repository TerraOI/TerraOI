# ADR-0009 A refusal names its sentence: four templates, and the key that records which one ran

Status: **accepted** — this records the supervisor's decision on [#97](https://github.com/TerraOI/TerraOI/issues/97), restated on [#137](https://github.com/TerraOI/TerraOI/issues/137) (2026-11-09), with key↔status coherence ruled on [#151](https://github.com/TerraOI/TerraOI/pull/151) (2026-11-18). The implementation lands in the PR that carries this file: `src/contracts/expert-definition.ts`, `src/contracts/answer.ts`, `src/platform/agents/compose.ts` and their tests.
Plan refs: §9.3 (nothing unverified reaches the employee), §12.1 (the answer contract, withheld `requirement` claims), §14.1 (eval scoring), F20/F22 (run audit)
Deciders: supervisor (#97, #137, #151 B1) · Lane 2 (implementation) · Date: 2026-11-10

## Context

An expert definition states its refusal copy in `refusalTemplates`, and `composeAnswer` has been filling `Answer.summary` from it in three places. With three keys — `no_evidence`, `out_of_scope`, `unavailable` — two of those places were telling the employee something false:

- An **empty evidence pack** never reaches a model (`compose.ts`: zero calls, zero reservations). "I could not find that in the documents you can access" is true there.
- A run where the pack **was** handed to the composer and nothing survived — pass 1 rejected every citation, the verifier found every claim unsupported, or no eligible verifier could stand behind the only claim — chose the *same* sentence. That was review finding **B4 on #56/#58**: the employee is told the documents are empty when the platform had documents and could not defend what it built from them. It also degrades trust in the true case, which is the one the platform needs the employee to believe.
- Nothing recorded *which* sentence ran. `Answer.summary` is prose an expert release may reword between versions, so an eval case, an audit replay, or a support conversation cannot compare refusals: they would be matching strings authored by someone else in another release.

The vocabulary was also uneven across the codebase: early expert work and the T-311 packet (line 39) speak of three templates, and `#97`'s ruling names four. Plan §5.2 still lists three keys — supervisor will edit the plan; this ADR's Consequences note the drift.

## Decision

**1. Four templates, all required.** `refusalTemplates` is a `strictObject`, so an expert release that omits one fails to parse. `insufficient_support` is the new one:

| key | what it asserts | who selects it |
|---|---|---|
| `no_evidence` | nothing authorized was found for this question | `composeAnswer`, on an **empty evidence pack** — the only path in M1 that may say it |
| `insufficient_support` | documents were found; what was built from them did not hold up | `composeAnswer`, when a **non-empty pack** yields no claim that survives: pass-1 rejection, verifier drops, every claim withheld for want of an eligible verifier, or **the composer returned no claims** |
| `out_of_scope` | the question is not what this service answers | **nothing in this PR.** Selectors: T-311's `routeExpert`, and T-104's project-filter / service rejection (`chat-protocol.md`); compose never decides what a service answers, so it never chooses this key |
| `unavailable` | the platform could not produce an answer right now | `composeAnswer`, whenever the gateway yields no valid structured answer (no cleared provider, deadline, budget authority closed, output the schema rejected) |

**2. The rule those four exist to serve: every refusal sentence a user sees is true for the code path that chose it.** A refusal is a claim about the platform's state — *found nothing*, *found something and could not defend it*, *not my job*, *could not run* — and picking the wrong one is a false statement to an employee, which §9.3 treats as a defect, not wording. Where two causes share a truth class they may share a key (a pass-1 rejection and a verifier rejection are both "no claim survived"); they may never share a key across truth classes.

**3. `Answer.refusalKey` records which one ran.** An optional field on `Answer` (`src/contracts/answer.ts`), an enum over exactly the four template keys, **paired with `status` in both directions**:

- `status: refused | unavailable` → `refusalKey` **required**. An unnamed refusal cannot be replayed, audited, or scored.
- `status: answered | partial` → `refusalKey` **forbidden**. No refusal sentence was shown; recording one would describe text nobody saw.

Because `Answer` is a `strictObject` and the pairing is a `superRefine`, a producer cannot construct an `Answer` that violates it: `compose.ts` parses every answer it returns, so a refusal path that forgets its key throws at the point of construction rather than shipping a silent field. The four pairings are pinned by contract tests in `src/contracts/answer.test.ts` — including matching on the rule's own message, because before the field existed the parser rejected `refusalKey` as an *unrecognized key* and a loose matcher would have passed the forbidden-pairing test vacuously.

**4. Key↔status coherence is enforced in the contract** (#97, #137 item 4, #151 B1 ruling):

| `refusalKey` | required `status` |
|---|---|
| `no_evidence` | `refused` |
| `insufficient_support` | `refused` |
| `out_of_scope` | `refused` |
| `unavailable` | `unavailable` |

The key chooses the sentence, not the status. A pair outside this table can never match a T-312 eval expectation. `RefusalKey` is a closed enum, so a new key already needs an ADR and a contract change — the new pairing goes in that ADR. The fixed `superRefine` message is `refusalKey does not match status`.

**5. Copy rules** (#97). T-311 writes its strings against these:

- **`insufficient_support`** never says "not found" and never reveals what was withheld or why (no titles, no counts, nothing restricted). Example: "I found related material but could not verify an answer from it."
- **`out_of_scope`** never names a service or expert the tenant lacks.

## Consequences

- `compose.ts` gains one import (`type RefusalKey`) and one selection point; the old line `summary: status === "refused" ? no_evidence : composed.parsed.summary` — the B4 defect — is gone, and the file says so at the site.
- **Every refusal test that already existed still exists.** The capped-pack test (`compose.test.ts`, "the evidence pack is capped…") keeps its `refused` assertion and gains the sentence and key it must now use; the two `unavailable` tests that assert the copy now also assert the key; the withheld-`requirement` tests gain `expect(answer.refusalKey).toBeUndefined()`, which is the rule doing work: a withheld claim makes a *degraded answer*, not a refusal. Four new compose cases name the three causes explicitly, and one asserts that across all three refusal shapes `out_of_scope` is never chosen.
- `answer.test.ts`'s "refused and unavailable answers may carry no claims" test was **edited, not deleted**: its `refused`/`unavailable` rows now carry a key. The claim rule it pins is unchanged. Four wrong key↔status pairings are rejected on the coherence message.
- **T-311 (expert definitions) is blocked on this by design**: both experts must state `insufficient_support`. The packet already names four templates; its line 39 still says "three", which the definition PR should correct as it lands. Supervisor owns fixing plan §5.2 (still three keys) and that T-311 line.
- **T-312 (eval harness) scores it.** `expectedRefusalKey` and the `docs/contracts/eval-case-format.md` fixes are the supervisor's ruling on #137 and belong to ADR-0010 — deliberately **not** in this PR, so the contract change and the eval format change are reviewable separately. T-312 compares against `Answer.refusalKey`, which is why this field is a key and not a sentence.
- **T-104 (chat skeleton) owns the router's `out_of_scope` selection**, and its copy must never name a service the tenant lacks (#97). #178 must add `insufficient_support` to its provisional expert, add `refusalKey` to `refusedAnswer()`, and persist the key with the answer row. Until then the template is required and unreferenced by any selector — visible in `compose.test.ts`'s "nothing in compose selects out_of_scope".
- The **gateway's** own `UNAVAILABLE_MESSAGE` (`src/platform/gateway/call.ts:30`) is a different string for a different surface (progress/telemetry), and stays what it is. An `unavailable` answer's visible text is the *expert's* template, chosen by compose.
- No migration and no data change: **no answer row is stored anywhere on `main`**, so requiring the key on a refusal strands nothing. When F22 answer persistence lands, the key is written with the row.
- Employee-visible text remains a fixed sentence from the expert release either way; nothing here exposes a provider, model, or the reason the gateway failed (§§9.3) — the refusal tests still run the leak check.

## Alternatives considered

- **Derive the key from `status` alone** and store nothing. Rejected: `refused` covers three different truths, and the whole finding is that they are not interchangeable.
- **Let `summary` be the record** and compare prose in evals. Rejected: an expert release may reword its copy, and a reword would then look like a behaviour change in the eval score.
- **Leave key↔status coherence open in the contract** (former decision 4). Rejected on #151: #97 already pins the table; a future producer needing a new key already needs an ADR; fail at construction rather than ship a field nobody can trust.
- **Add `insufficient_support` as optional** so existing expert definitions keep parsing. Rejected by the ruling: a template an expert never states is a refusal path with no honest sentence, and `strictObject` is what forces the copy to exist.

## Open, on purpose

Whether `Answer.unknowns` on a refused run should be composer text at all (today it is) is a §9.3 wording question — tracked as [#210](https://github.com/TerraOI/TerraOI/issues/210) rather than decided here. Compose tests assert only that unknowns are present on an `insufficient_support` refusal, not the composer prose.
