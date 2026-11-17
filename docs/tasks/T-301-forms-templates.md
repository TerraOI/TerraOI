# T-301 TerraOI forms: two seeded templates, submissions become knowledge

Lane: 1 · Week: 3 · Protected: yes (`supabase/migrations/`) · Depends on: T-111 (merged), T-112 (a and b merged as #32/#54), T-102 (code halves a–d merged as #30/#50/#52/#57; staging evidence owed), T-103 (the brand validation half merged as #119; brand rows #150 and the shell #173 open), T-113 (the chunker and embedding gate merged as #80; publish is not on `main`) · Status: in progress (wyuinline) — claimed 2026-11-17 by the pushed branch `t-301-forms-sql`, opened as a draft PR the same day. PR-1 is the SQL slice only (`form_templates`, `form_submissions`, the two scoped RPCs, pgTAP slot `080` already reserved here, seeds): it consumes only merged work — T-111 #12, T-112 #32/#54/#78, T-101c #167 — and writes no shell UI (T-103) and no publish worker (T-113), and pgTAP sets its own tenant scope with `set_tenant_scope`, so it does not wait on the app session layer either. Two listed dependencies are only **partly** merged and that is the whole §1.2 argument: T-103 has just its brand-validation half (#119; #150 and #173 still open) and T-113 just the chunker and embedding gate (#80; no `036_chunk_publish` migration on `main`). Asking rather than assuming: [#196](https://github.com/TerraOI/TerraOI/issues/196) (is a slice claimable when its dependencies are partly merged; precedent T-111b #157, merged 2026-11-13 while T-104 and T-113 were in the same state). Data-model question: [#195](https://github.com/TerraOI/TerraOI/issues/195).
Gated by decisions: all three closed with rulings, checked 2026-11-17 — [#51](https://github.com/TerraOI/TerraOI/issues/51) option 1 (extracted `body_text` is written at capture for text-like payloads, which is what this packet already assumes), [#39](https://github.com/TerraOI/TerraOI/issues/39) the merged capture predicate stands and a seeded `contributor` role is wanted (still absent from `supabase/seed.sql`, so a form submitter with `knowledge.write` is built in-transaction in pgTAP), [#64](https://github.com/TerraOI/TerraOI/issues/64) option 2 — the app sends email, transport owned by T-105 (open as #139), so no notification ships in this SQL slice.
Plan refs: §7.6, §6.1 (Forms group), §6.2, §16 (Forms/OCR row), §15.0 ("2–3 seeded forms"), §20.3; F33 over [T-112](./T-112-uploads-extract.md)/[T-113](./T-113-chunk-embed-publish.md)'s capture and publish path

## Goal
An employee opens a **platform-seeded form** in the tenant shell — a UAV pre-flight checklist and a GPR
field log at minimum — fills it against one exact template version, and submitting creates an immutable
`form_submission` plus a `source_version` in the knowledge pipeline: structured values with a rendered
text representation, field values citable as `form_field` evidence, publication under the collection's
review policy, corrections linked as new versions. Forms reuse the knowledge pipeline (TOI-ADR-16).

## Owns (may edit)
- `src/platform/forms/` (template resolution, validation against the exact version, submission, rendered
  text, correction linking), `src/app/(tenant)/forms/`, `src/components/forms/`
- one migration `supabase/migrations/YYYYMMDDHHMMSS_forms.sql`: `form_templates`, `form_submissions` and
  the scoped RPCs (`save_form_draft_v1`, `submit_form_v1`) — timestamp agreed in the daily sync
- `supabase/tests/database/080_forms.test.sql`, `src/platform/forms/*.test.ts`, and the 2–3 synthetic
  platform templates added to `supabase/seed.sql` in the same PR as that migration

## Must not edit
`src/contracts/` — [`FormTemplate`](../../src/contracts/form-template.ts) is merged from T-002 and any
change needs an ADR ([COORDINATION.md §2](../../docs/COORDINATION.md)); merged migrations;
`src/platform/knowledge/` and `src/app/api/knowledge/` (Lane 2 owns knowledge writes and its route folders,
[FAQ-0004](../../docs/FAQ.md), [FAQ-0005](../../docs/FAQ.md)) — this packet calls the capture RPCs, never a
knowledge table; `src/platform/chat/`; `brand/`.

## Contract
F33 `submitForm` implements the merged
[`FormTemplate`](../../src/contracts/form-template.ts): `scope platform|tenant`, a JSON Schema object at
the root, whitelisted `FormFieldUiHint` keys, `containsUnsafeFormContent` rejecting scripts, CSS and remote
URLs, and `isIngestibleInM1` on the class (§12.4: `restricted` is never ingested). A submission yields the
`form_field` variant of [`EvidenceRef`](../../src/contracts/answer.ts) — `submissionId`, `fieldPath`,
`templateVersion` — which is why the validated version is stored on the row and never re-resolved from the
newest one. Class comes from the template's default collection and never goes down (§6.2), and publish
permission is the merged `user_may_publish_into(uuid)` predicate
([`20261106100000_knowledge_uploads.sql:167`](../../supabase/migrations/20261106100000_knowledge_uploads.sql)).
Rules: [docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md).
**Assumed, decision owed:** a submission writes `body_text` at capture, which is #51's option 1
(write-once at capture for text-like payloads); if the supervisor rules otherwise, the rendered-text step,
its RPC and its grants change before this packet is claimed.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/080_forms.test.sql` — `submit_form_v1` writes exactly one
      submission, one `source_version` with structured values plus rendered text, and one outbox event in one
      transaction, and the stored template version is the one validated
- [ ] positive: `src/platform/forms/seeded-templates.test.ts` — at least two templates parse, one per seeded
      service key (`uav-compliance`, `gpr`) as §7.6 requires, each bound to a publishable collection
- [ ] positive: drafts are private to their author, and a correction creates a linked new submission instead
      of an in-place edit (§7.6 step 4)
- [ ] negative: same pgTAP file — a company1 submission naming a company2 template or collection is refused
      by the composite FK (`23503`) and a company2 member sees no company1 row; a `client_confidential` Site A
      template refuses a submitter outside Site A (T-214's predicate), and a `suspended` membership creates no
      draft and no submission
- [ ] negative: a template with a script key, a `data:`/`https:` value, a CSS key or a `$ref` is refused at
      write; unknown or oversized values fail validation and create no source version
- [ ] failure: the template is retired or re-versioned mid-draft → refusal naming the version validated,
      never a silent re-validation against the new one (§16 Forms/OCR row); a replayed submit is one
      submission; a collection whose policy requires review lands in `awaiting_review`, never published

## Done evidence
`pnpm verify`; `pnpm db:test` (CI `database` job — no Docker here); staging: `field2@company1.test` fills
the UAV pre-flight template, a chat answer cites one field, a correction creates a linked version, and the
same template id on the company2 host creates nothing.

## Out of scope
Form-designer UI and tenant-authored template flows (§15.0 defers the designer), conditional logic beyond
JSON Schema, TOI-07/TOI-10 operational truth (§7.6: a submission is not operational truth until those
modules define authority), printed forms and exports (§20.5 excludes them from M1), publish notifications
(F27, and #64 owns the transport).
