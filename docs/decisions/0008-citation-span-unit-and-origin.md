# ADR-0008 A citation span is UTF-16 code units into the chunk body, and only the platform writes one

Status: **accepted** — this records the supervisor's decision on [#95](https://github.com/TerraOI/TerraOI/issues/95) (2026-11-09). The implementation lands in the PR that carries this file: `src/contracts/answer.ts`, `src/platform/gateway/verify-binding.ts`, `src/platform/agents/compose.ts` and their tests.
Plan refs: §9.3 step 1 (verify before display), F21 (verbatim quote check), F22 (run audit); §8.2 (retrieval returns rows, not display markup)
Deciders: supervisor (#95), Lane 2 (implementation) · Date: 2026-11-09

## Context

`EvidenceSpan` (`src/contracts/answer.ts:28-36`) carried two numbers with **no unit and no origin**. "Character offset" has two honest answers in this stack: JavaScript counts UTF-16 code units, Postgres `char_length` counts characters, and a non-BMP character (an emoji, a rare CJK ideograph) is one of each and two of the other. A span produced on one axis and sliced on the other does not raise — it returns a *nearby* window of text, and the highlight and the verbatim check drift apart silently. #80 merged the chunker and embedding gate and stores no spans, so the ambiguity was still latent when #95 was filed.

The origin was worse. `compose.ts:176-178` told the model to cite "a chunkId **and a character span from that pack**". A pack (`evidenceText`, `compose.ts:157-164`) is several chunks concatenated into one prompt string. A span counted there belongs to no stored row at all, and the model cannot know the pack's byte layout anyway. Meanwhile `verify-binding.ts:59-66` checked `chunk.text.slice(startChar, endChar) === quotedText` — so the only thing that could catch a pack-space span was a quote that happened to differ.

The failure had already been found once in review: the compose test fake computed body offsets itself (`compose.test.ts:74-84`), which made the suite prove the mechanism while production had none.

## Decision

**1. Origin.** A span counts from the start of that chunk version's `knowledge_chunks.body_text`. Never from a rendered evidence pack, a prompt, or a citation display.

**2. Author.** The model never authors one. A citation is a `chunkId` plus the **exact `quotedText`** and nothing else; the compose candidate schema has no span field. Pass 1 (`verify-binding.ts`) locates that quote in the chunk body with an exact, unnormalized `indexOf`, and fills the span itself: `{ startChar: at, endChar: at + quotedText.length }`. **First occurrence wins** — when a quote appears twice either location shows the same text, so the stored span and the highlight agree either way. If the quote is not found, the reason is `quote_not_verbatim`, exactly as before.

**3. Unit: UTF-16 code units** — what JavaScript `.length` and `.slice()` count. Every M1 producer and consumer of a span is JavaScript in the Worker (pass 1, compose, display), so a missed conversion helper cannot exist. Code points (Postgres-style characters) were rejected: they need a helper at every `.slice()`, and a missed helper is this bug.

**4. SQL returns text, never offsets.** `search_corpus_v1` (T-114) and `exact_lookup_v1` (T-216) return the matched text; they do not compute `startChar`/`endChar`. If a future SQL consumer needs an offset, that is a new ADR, not a detail.

**5. Budgets are unchanged.** The chunker measures with `.length` (UTF-16 units), which is never fewer than Postgres characters, so its cap against `char_length(body_text) <= 100000` (`knowledge_core.sql:249`) errs on the safe side.

## Consequences

- `ChunkEvidence.quotedText` becomes **required**. A citation with a locator and no quote is no longer expressible in an `Answer`, because the quote is now the thing being verified. `span` stays in the contract as a platform-filled field, so stored answers and the display keep a locator.
- `span_out_of_range` leaves the `BindingRejectReason` taxonomy: with the span derived, a bound reference is inside the chunk by construction, and a reason no code path can choose is audit noise — the same rule the supervisor applied to the refusal vocabulary in [#97](https://github.com/TerraOI/TerraOI/issues/97).
- The compose prompt now forbids an offset and says plainly that a quote the platform cannot find verbatim is discarded.
- **Tests that pin it**, per #95: a chunk holding a non-BMP character with a quote crossing it (the derived span slices back to the quote, and the stated offsets differ from the Postgres character count by exactly the surrogate pair); an ambiguous quote binding at its first occurrence; and a two-chunk pack where the model quotes from the **second** chunk — the span is measured inside that chunk's own body, not at the pack offset. The fake that computed body offsets is gone.
- `span_out_of_range`'s old test cases are rewritten, not deleted: a quote that sits elsewhere in the chunk now **binds** where it actually is, which is a behaviour change a reviewer must be able to see.
- **For the eval case files (T-312/T-315):** `docs/contracts/eval-case-format.md` line 101 called the span "a character span"; it now says UTF-16 code units, and line 105's "`quotedText` (optional)" note changes, because an approved case that carries expected citations must carry the quote it expects — a locator without a quote cannot be replayed. Committed drafts keep `expectedEvidence: []` (#102), so nothing in the repository changes today; the harness must not invent a quote when it binds.

## Alternatives considered

- **Postgres characters / Unicode code points** for the unit. Rejected: every consumer is JavaScript, and this unit requires a conversion helper at every call site.
- **Let the model keep citing spans**, validating them in pass 1. Rejected: it is unverifiable by construction (the model sees a rendered pack), and a wrong span that happens to slice to the same length is invisible.
- **Drop `span` entirely** and highlight by re-searching the quote at display time. Rejected: F22 wants the run to record what it showed, and a re-search can find a different occurrence after a re-index.

## Open, on purpose

Whether an *evidence row* returned by retrieval should carry the text it matched plus a stability marker is T-114's shape question; this ADR fixes only what a span means once it exists. Recorded on #95 rather than decided here.
