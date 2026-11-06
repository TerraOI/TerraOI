# T-301 TerraOI forms: two seeded templates, submissions become knowledge

Lane: 1 · Week: 3 · Protected: yes (`supabase/migrations/`) · Depends on: T-111, T-112 (a merged as #32; b open as #54), T-102 (a–d open as #30/#50/#52/#57; only e's test-only pgTAP #59 is merged), T-103 (unclaimed), T-113 (unclaimed) · Status: ready
Gated by decisions: [#51](https://github.com/TerraOI/TerraOI/issues/51) (write surface), [#39](https://github.com/TerraOI/TerraOI/issues/39) (publish permission), [#64](https://github.com/TerraOI/TerraOI/issues/64) (no packet owns the outbound email/notifications transport a published submission notifies through)
Plan refs: §7.6, §6.1 (Forms group), §6.2, §16 (Forms/OCR row), §15.0 ("2–3 seeded forms"), §20.3; F33 (over the capture/publish path of [T-112](./T-112-uploads-extract.md) and [T-113](./T-113-chunk-embed-publish.md))

## Goal
An employee opens a **platform-seeded form** in the tenant shell — a UAV pre-flight checklist and a
GPR field log at minimum — fills it against one exact template version, and submitting creates an
immutable `form_submission` plus a `source_version` in the knowledge pipeline: structured values with
a rendered text representation for retrieval, field values citable as `form_field` evidence,
publication following the collection's review policy, corrections linked as new versions. Forms reuse
the knowledge pipeline; they do not become a second data system (TOI-ADR-16).

## Owns (may edit)
- `src/platform/forms/` (template resolution, server-side validation against the exact version,
  submission, rendered text, correction linking), `src/app/(tenant)/forms/`, `src/components/forms/`
- one migration `supabase/migrations/YYYYMMDDHHMMSS_forms.sql`: `form_templates`, `form_submissions`
  and the scoped RPCs (`save_form_draft_v1`, `submit_form_v1`) — timestamp agreed in the daily sync;
  migrations are protected and merged migrations are never edited
- `supabase/tests/database/080_forms.test.sql`, `src/platform/forms/*.test.ts`
- `supabase/seed.sql`: the 2–3 synthetic platform templates (additive, in the same PR as the migration)

## Must not edit
`src/contracts/` — [`FormTemplate`](../../src/contracts/form-template.ts) already exists from T-002 and
any change to it needs an ADR ([COORDINATION.md §2](../../docs/COORDINATION.md)); merged migrations;
`src/platform/knowledge/` (Lane 2 owns knowledge writes — this packet calls the capture RPC, never the
table, [FAQ-0004](../../docs/FAQ.md)); `src/app/api/knowledge/` (Lane 2,
[FAQ-0005](../../docs/FAQ.md)); `src/platform/chat/`; `brand/`

## Contract
F33 `submitForm` implements the merged
[`FormTemplate`](../../src/contracts/form-template.ts): `scope platform|tenant`, a JSON Schema object at
the root, whitelisted [`FormFieldUiHint`](../../src/contracts/form-template.ts) keys,
`containsUnsafeFormContent` rejecting scripts/CSS/remote URLs, and `isIngestibleInM1` on the class
(§12.4: `restricted` is never ingested). A submission yields the `form_field` variant of
[`EvidenceRef`](../../src/contracts/answer.ts) — `submissionId`, `fieldPath`, `templateVersion` — which
is why the validated template version is stored with the row and never re-resolved from the newest one.
Class comes from the template's default collection and never goes down (§6.2). Rules:
[docs/contracts/knowledge-and-jobs.md](../../docs/contracts/knowledge-and-jobs.md).
**Assumed, decision owed (#51):** a form submission writes `body_text` at capture, which is #51's
option 1 (write-once at capture for text-like payloads). The supervisor owes that ruling before this
packet is claimed; if the answer differs, the rendered-text step, its RPC and its grants change.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/080_forms.test.sql` — `submit_form_v1` writes exactly one
      `form_submission`, one `source_version` carrying structured values plus the rendered text, and
      one outbox event in the same transaction; the stored template version is the one validated
- [ ] positive: `src/platform/forms/seeded-templates.test.ts` — at least two platform templates parse
      against the contract, bound to the seeded service keys (`uav-compliance`, `gpr`), at least one per
      expert as §7.6 requires, each to a collection the pilot may publish into
- [ ] positive: drafts stay private to their author, and a correction creates a new submission linked to
      the old one — nothing is edited in place (§7.6 step 4)
- [ ] negative: same pgTAP file — a company1 submission naming a company2 template or collection id is
      refused by the composite FK (`23503`), never silently re-pointed, and a company2 member sees no
      company1 draft or submission row
- [ ] negative: a template bound to a `client_confidential` Site A collection refuses a submitter who is
      not a Site A member (the T-214 predicate), and a `suspended` membership creates no draft and no
      submission
- [ ] negative: a template with a script key, a `data:`/`https:` value, a CSS key or a `$ref` is refused
      at write; a value set with unknown keys or an over-long answer fails validation and produces no
      source version
- [ ] failure: the template is retired or re-versioned mid-draft → the server refuses and names the
      version it validated rather than re-validating against the new one (§16 Forms/OCR row)
- [ ] failure: a replayed submit with the same idempotency key produces one submission; a collection whose
      policy requires review leaves the version in `awaiting_review`, never published

## Done evidence
`pnpm verify`; `pnpm db:test` for the new RPCs (the CI `database` job on a machine without Docker);
staging: `field2@company1.test` fills the UAV pre-flight template, a chat answer cites one field, a
correction creates a linked version, and the same template id on the company2 host creates nothing.

## Out of scope
Form-designer UI and tenant-authored template flows (plan §15.0: form designer deferred after M1),
conditional logic beyond JSON Schema, TOI-07/TOI-10 operational truth (a submission is not operational
truth until those modules define authority, §7.6), printed forms and exports (§20.5 excludes them from
M1), publish notifications (F27, T-213).
