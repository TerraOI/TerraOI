# Eval case files: layout, shape, provenance, lifecycle

Schemas: [`answer.ts`](../../src/contracts/answer.ts), [`data-class.ts`](../../src/contracts/data-class.ts),
[`keys.ts`](../../src/contracts/keys.ts) · Plan §14.1, §6.1 (Evaluation group, line 336), §11 F34–F36 ·
Lane 2 owns [`evals/`](../REPO-STRUCTURE.md) · **No `EvalCase` schema exists in `src/contracts/` yet**:
the shape below is prose until the request in [Needs a contract](#needs-a-contract) lands.

This file records the rules a case-file layout cannot express by itself: which directory a case may sit
in, what binds it to a document a reviewer is allowed to read, what text may ever be committed, and what
changes when a lead approves it. Plan §14.1 owns the workflow; TOI-ADR-17 owns the principle (agents
draft, domain experts approve).

## 1. Where the files live

| Path | Holds | Read by |
|---|---|---|
| `evals/<expert-key>/drafts/<case_id>.json` | F34 output: candidate cases, `agent_drafted`, undecided | The review view and nothing that scores |
| `evals/<expert-key>/<case_id>.json` | **Approved** fixtures, one per case | F35 (`runExpertEval`) |

- One case per file. The file name stem equals `caseId`. A file whose `caseId` disagrees with its name, or
  whose `expertKey` disagrees with its folder, is invalid.
- **F35 never reads `drafts/`.** Plan §14.1 step 3: "Only approved cases enter `evals/<expert>/` fixtures
  (F35 ignores unapproved ones)". Placement in the tree *is* the approval state; `status` records the same
  fact so a moved file cannot pass as approved.
- Moving a file from `drafts/` to the expert folder is the **export** step of an approval, done by the
  harness side (T-312 in the week-3 packet set, PR #72) after the review view records the decision. A
  human moving a file by hand, with no recorded reviewer and time, is not an approval.
- Other synthetic fixture folders are named by packets already on `main`:
  [`evals/retrieval/`](../tasks/T-114-search-corpus.md) (T-114, T-212, T-216) and
  [`evals/verification/`](../tasks/T-215-verifier-pass2.md) (T-215). They follow the same provenance rule
  in §4 below and are not eval *cases*.

## 2. File shape

UTF-8 JSON, one object per case, no BOM, LF-normalized, two-space indent, trailing newline. Every key
listed here is required; **unknown keys are an error** (the same convention as `z.strictObject` in
`src/contracts/`). `"status": "drafted"` files carry `null` for both approval fields.

| Field | Type | Draft | Notes |
|---|---|---|---|
| `schemaVersion` | integer | required | `1` for the shape in this file |
| `caseId` | string | required | unique across the whole `evals/` tree; matches the file name |
| `expertKey` | string | required | `ExpertKey` shape, `keys.ts:19-20`; matches the folder name (see **Blank 1**) |
| `status` | `"drafted"` \| `"approved"` | required | file-lifecycle marker; `drafts/` files must say `drafted` |
| `origin` | `"agent_drafted"` \| `"expert_written"` \| `"pilot"` | required | plan §6.1 line 336 (F34 marks every draft `agent_drafted`) |
| `caseType` | see [Enums](#enums) | required | plan §14.1 step 1 |
| `question` | string, non-empty | required | what is asked, in the employee's terms |
| `expectedAnswerPoints` | string[] | required, ≥ 1 | what a correct answer must contain; **not** a quotation (see §4) |
| `expectedClaimTypes` | `ClaimType[]` | required, unique | the claim types the answer is expected to make |
| `expectedAnswerStatus` | `Answer.status` value | required | what F35 compares the run's `Answer.status` against |
| `citationRequired` | boolean | required | must be `false` when `expectedAnswerStatus` is `refused` or `unavailable` |
| `dataClass` | `DataClass` | required | the highest class among the case's dependencies (§4) |
| `projectScope` | string \| null | required | draft: a synthetic project key; approved: the project the bound source belongs to, `null` for tenant-wide |
| `forbiddenClaims` | string[] | required (may be empty) | claims that make the answer wrong even if the sources support them |
| `isolationBait` | boolean | required | `true` only for a cross-tenant or project-restricted case |
| `adversarialClass` | one of six \| null | required | plan §14.1 step 2 |
| `expectedSource` | string | required in a draft | human review aid only: synthetic fixture ids plus page/section/sheet text |
| `expectedFixtures` | string[] | required in a draft | every `SYNTH-…` id named by `expectedSource`, derived mechanically, no inventing |
| `expectedEvidence` | [locator](#3-the-locator-rule) entries | `[]` in a draft | required, ≥ 1, when `citationRequired` is `true` |
| `approvedBy` | string (opaque id) \| null | **null** | reviewer identity from `TenantContext`, never an email or display name (AGENTS.md §4.1) |
| `approvedAt` | ISO-8601 datetime \| null | **null** | recorded server-side at approval, plan §14.1 step 3 |
| `draftedBy` | string | required | who drafted it (`agent (T-315 draft)` for this batch) |
| `draftedOn` | `YYYY-MM-DD` | required | drafting date, for provenance only |

### Enums

The three enums that already exist are copied **verbatim** from the merged contracts, with the line they
come from. Do not rename, shorten or extend them here; a new value needs an ADR.

| Field | Allowed values | Source |
|---|---|---|
| `expectedClaimTypes[]` | `source_fact`, `requirement`, `record_fact`, `inference` | [`answer.ts:14`](../../src/contracts/answer.ts) |
| `expectedAnswerStatus` | `answered`, `partial`, `refused`, `unavailable` | [`answer.ts:101`](../../src/contracts/answer.ts) |
| `dataClass` | `public`, `internal`, `client_confidential`, `restricted` | [`data-class.ts:8`](../../src/contracts/data-class.ts) |
| `caseType` | `answerable`, `needs_clarification`, `must_refuse`, `out_of_scope` | plan §14.1 step 1 — **no schema in `src/contracts/` yet** |
| `adversarialClass` | `cross_tenant_bait`, `project_restricted`, `poisoned_instruction_in_document`, `missing_source`, `provider_outage_mid_run`, `ambiguous_follow_up` | plan §14.1 step 2 lists the six in prose; these identifiers come from the drafting workbook and are **not yet contracted** |

`VerificationStatus` (`unverified`, `binding_passed`, `binding_failed`, `supported`, `partial`,
`unsupported`, `contradicted` — [`answer.ts:17-25`](../../src/contracts/answer.ts)) is deliberately **not**
a field of a case file. It describes what a run produced, and belongs to F35's per-case result
(plan §6.1's `eval_results`, "per case score, failure class"). Whether a case should also state an
*expected* verification status per claim type is T-312's scoring decision, not a reason to add a field now.

## 3. The locator rule

`expectedSource` is a **review aid**: page, section and sheet-cell strings exist so a lead can find the
passage. They are never a citation and F35 must not score against them.

An **approved** case is bound to what the platform can prove. Each entry of `expectedEvidence` must be
expressible as the `chunk` member of `EvidenceRef`
([`answer.ts:29-44, 62-67`](../../src/contracts/answer.ts)):

| Key | Type | Rule |
|---|---|---|
| `kind` | `"chunk"` | the only member a document-eval case can use; `record` and `form_field` belong to other evidence classes |
| `sourceVersionId` | UUID | a **published** source version the reviewing expert is authorized to read; a revoked version makes the case invalid (plan §14.1, T-213) |
| `chunkId` | `OpaqueId` | `^[A-Za-z0-9_-]{1,128}$` ([`keys.ts:45`](../../src/contracts/keys.ts)) |
| `span.startChar` / `span.endChar` | non-negative integers | `endChar >= startChar`; a character span inside that chunk version, the same span F21 checks verbatim quotes against |

- Drafts carry `[]` here, because a draft names a synthetic fixture that does not exist in any tenant.
  Binding happens when the lead approves, in the review view, against the live corpus.
- `quotedText` (optional on `ChunkEvidence`) stays **absent** from committed case files: see §4.
- Approval can never attach a source version the reviewer may not read: drafting is already limited to
  collections the reviewing expert may see (plan §14.1 step 1), and the same read predicate gates the
  review view. A case whose expected source was revoked must go back to review, not score as a failure.

## 4. Provenance rule (AGENTS.md §4.7)

Committed case files are fixtures, and fixtures use synthetic or explicitly approved data.

- **No client text.** No quoted sentence from a client document, in `question`, in
  `expectedAnswerPoints`, in `forbiddenClaims`, or in a locator. `expectedAnswerPoints` states what an
  answer must *contain* in the reviewer's words.
- **No client identifiers.** No company name, employee name or email, phone or serial-like digit run,
  asset serial, storage object key, site identifier, URL, or credential (AGENTS.md §4.6 too). Synthetic
  fixture ids in this batch use `SYNTH-…` (`SYNTH-UAV-MAN-A17`), synthetic projects use `synth-…`.
- **A source reference must be synthetic or approved.** Every fixture id named in `expectedSource`
  matches `^SYNTH-[A-Z0-9-]+$` while the case is a draft.
- **Data class propagates.** `dataClass` is the highest class among the case's dependencies — the source
  versions it binds and any project scope — not a label chosen freely (plan §6.2 line 347, AGENTS.md
  §4.4). A draft states the class its synthetic fixtures would carry; at approval it is recomputed from
  the real bound sources, and the review row's class is the one F35's clearance sees.
- Instructions inside a document are untrusted data (AGENTS.md §4.8). A `poisoned_instruction_in_document`
  case quotes no instruction text; it names the fixture and states in `forbiddenClaims` that the injected
  text is data and never an instruction.

## 5. Lifecycle

1. **Draft.** F34 (or a builder writing adversarial cases) produces `drafts/*.json` marked
   `status: "drafted"`, `origin: "agent_drafted"`, `approvedBy: null`, `approvedAt: null`. F35 ignores
   them; a CI subset that includes one is a harness bug.
2. **Review.** A tenant-side review view (T-303 in the week-3 packet set) lists a case only to a reviewer
   who can read its expected source. The lead **approves, edits or rejects** (plan §14.1 step 3).
   `edit` returns the case to pending with the lead's text — the previous text is not approved. `rejected`
   never becomes a fixture, and the draft file is deleted or left in `drafts/` undecided; either way it is
   never scored.
3. **Approve.** The reviewer identity and time are recorded server-side from `TenantContext`, never from
   the request body (AGENTS.md §4.1). The case is then written to `evals/<expert-key>/<case_id>.json` with
   `status: "approved"`, `approvedBy`, `approvedAt`, and non-empty `expectedEvidence` per §3.
4. **Run.** F35 scores the approved set in deterministic order, bound to a corpus generation. A case whose
   source has since been revoked re-queues for review instead of scoring zero.

## 6. Blanks: decisions this layout does not make

These are quoted as evidence, not resolved. Anything here that blocks a merge goes through the packet's
own question issue (COORDINATION.md §6).

**Blank 1 — which expert key is canonical.** The folder name and `expertKey` depend on a name that two
sources disagree about:

| Source | Value |
|---|---|
| plan §5.2 and §9.2 examples — `docs/plan/TerraOI-plan-v1.3.md:282` (`key: string; // e.g. 'uav-expert' or 'gpr-expert'`), `:502` (`"expertKey": "gpr-expert"`) | `uav-expert`, `gpr-expert` |
| contract tests — [`expert-definition.test.ts:12`](../../src/contracts/expert-definition.test.ts) `key: "gpr-expert"`, [`chat.test.ts:11`](../../src/contracts/chat.test.ts) `expertKey: "gpr-expert"` | `…-expert` |
| [`supabase/seed.sql:118`](../../supabase/seed.sql), [`:122`](../../supabase/seed.sql) — `service_key` `'uav-compliance'`, `'gpr'` | service keys, no `-expert` suffix |
| week-3 packets (PR #72) — `docs/tasks/T-315-staging-corpora-eval-cases.md:15` Owns `evals/uav-expert/` and `evals/gpr-expert/`; `docs/tasks/T-311-expert-definitions.md:54-55` routes to `uav-compliance` and `gpr` | both, in the same packet set |

Both forms satisfy `ExpertKey` (`keys.ts:19-20`), so nothing mechanical picks one. **Assumed until
answered:** the folder names the packets use, `evals/uav-expert/` and `evals/gpr-expert/`, restated in
[`evals/README.md`](../../evals/README.md). Cheap to reverse: two folder renames plus `expertKey` in each
file; nothing else in the layout depends on the choice.

**Blank 2 — who is an eligible reviewer (`evals.review` does not exist).**
[`supabase/seed.sql:70-78`](../../supabase/seed.sql) seeds only `chat.ask`, `knowledge.read`,
`projects.read`, `knowledge.admin`, `members.admin` and `projects.admin`. The column accepts the shape
(`area ~ '^[a-z0-9_]+(\.[a-z0-9_]+){1,3}$'`,
[`supabase/migrations/20261105060000_tenancy_core.sql:98`](../../supabase/migrations/20261105060000_tenancy_core.sql))
and an unseeded-area precedent already exists in a merged migration ("the area #39 will seed",
[`20261106100000_knowledge_uploads.sql:162`](../../supabase/migrations/20261106100000_knowledge_uploads.sql)).
The week-3 review-view packet states the same gap ("an `evals.review` area is a scope decision for the
supervisor", `docs/tasks/T-303-eval-review-view.md:36-40`), and plan §18.3 still has no named UAV/GPR
reviewers (§20.8 makes it a human step). So step 3 of §14.1 — the only thing that turns a draft into a
fixture — has no enforced gate yet. **Nothing here grants a permission or names a reviewer.**

**Blank 3 — the unowned machinery around approval and running.**
[#74](https://github.com/TerraOI/TerraOI/issues/74): the nightly eval run needs a `schedule:` entry in
`.github/`, which no packet owns — so this batch ships **no CI wiring**: no `package.json` script, no
workflow, no validator in `scripts/`. [#73](https://github.com/TerraOI/TerraOI/issues/73): which lane
delivers F15 and who creates `knowledge_submissions` — that decides how pilot feedback becomes
`origin: "pilot"` draft cases (plan §14.1 step 5), so the `origin` enum is recorded here but only
`agent_drafted` is in use in this batch.

**Blank 4 — may an approved client case be committed at all.** The week-3 drafting packet names it as a
decision owed: "whether an approved client case's expected answer points may be committed **at all**
(§4.7 + §6.2)". Until it is answered, an approved case's wording stays under the same no-client-text rule
as a draft, and this file does not widen it.

**Blank 5 — `restricted` in a draft.** Two drafts declare `dataClass: "restricted"` while
[`supabase/seed.sql:116`](../../supabase/seed.sql) says `restricted` is not insertable in M1 at all
(plan §12.4). Such a case cannot bind to an M1 collection, so it cannot be approved as written; the
reviewer's edit is the fix, not a layout exception.

## Needs a contract

Requested through a `needs-contract` issue, not written here (AGENTS.md §6, COORDINATION.md §2). Lane 2
owns `src/platform/evals/`; `src/contracts/` needs an ADR.

- An `EvalCase` Zod schema in `src/contracts/`: the field table in §2, `CaseType` as a real enum, and the
  six adversarial-class identifiers as a real enum — both today live only in plan prose and in the
  drafting workbook, so a typo in a committed file fails no schema today.
- The draft → approved discriminator in that schema: `expectedEvidence` empty iff `status` is `drafted`.
- Whether the case file and the `eval_cases` row (plan §6.1 line 336, T-312's migration) are one record
  with two homes; today the prose assumes the file is an export of the row, and the row is the authority.

## What this file does not decide

Scoring, thresholds, failure classes and the `pnpm eval:ci` / `eval:nightly` commands (T-312); the review
UI and its permission (T-303); which documents load into staging (`evals/LOADING.md`); any change to
`src/contracts/` (none is made here) or to the rules in
[`docs/contracts/README.md`](README.md).
