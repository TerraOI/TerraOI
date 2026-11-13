# Coordination protocol: builders, their agents and the supervisor

Agents working on TerraOI share no memory and cannot message each other. **GitHub is the only shared state:** pull requests, issues, labels and the files in this repository. Anything not written there does not exist for the other agents. This protocol defines how that state is used. [AGENTS.md](../AGENTS.md) points here; both are binding.

## Roles

| Role | Who | Acts through |
|---|---|---|
| **Supervisor** | Repository owner, reviewing with Claude Code (`/terraoi-review`, `/terraoi-inbox`) | PR reviews prefixed `[Supervisor]`, `[Supervisor] Answer` comments on questions, ADR approvals, closing `needs-supervisor` / `policy-violation` issues |
| **Repository steward** | Claude Code working with the supervisor (`/terraoi-housekeeping`) | Keeps the project organized and understandable: enforces [REPO-STRUCTURE.md](REPO-STRUCTURE.md), reviews the weekly `housekeeping` issue, proposes fixes as `chore/housekeeping-YYYY-Www` PRs. Proposes; the supervisor decides |
| **Lane 1 builder + agent** | Builder A | PRs and issues for `src/app/`, tenancy, identity, branding, chat, forms |
| **Lane 2 builder + agent** | Builder B | PRs and issues for knowledge, retrieval, agents, gateway, evals, workers |

Humans decide; agents propose. An agent never closes another person's issue, approves a PR, or merges.

## 1. Claiming a task (before writing code)

1. Run `gh pr list --state open` and `gh issue list --label blocked`. If an open PR already references the packet, **stop**: it is taken.
2. Check the packet's `Depends on:`. Every listed task must be **merged on `main`**, not merely open. If not, pick another packet or wait.
3. Claim it: create branch `t-xxx-short-name`, change the packet's line to `Status: in progress (<github-login>)`, commit, and **open a draft PR immediately** titled `T-xxx: <title>`. The draft PR is the claim, and the other lane can see it.
4. Work, then mark the PR "Ready for review" only when `pnpm verify` passes and the template is filled in.
5. If you abandon a task, set `Status: ready`, close the draft PR, and say why in a comment.

## 2. Asking the other lane for something

Never edit the other lane's files to unblock yourself, even "just one line".

1. Open an issue with the **Needs contract change** template (label `needs-contract`). Name the contract (`src/contracts/...`), what you need, why, and the packet it blocks.
2. Mark your own PR `blocked` and link the issue. Continue with work that does not depend on it, if any.
3. The owning lane answers with an **ADR PR** (`docs/decisions/NNNN-*.md`) plus the contract change. The supervisor approves contract changes (protected path).
4. After it merges, the requester rebases and removes `blocked`.

## 3. Shared files

| File(s) | Rule |
|---|---|
| `src/contracts/` | Changed only through an ADR PR (§2). One contract change per PR. |
| `supabase/migrations/` | **One migration per PR.** Name it `YYYYMMDDHHMMSS_short_name.sql` (UTC). Rebase on `main` immediately before merge; if `main` gained a newer migration, **rename yours to a fresh timestamp**. CI (`migrations` job) rejects out-of-order timestamps and any edit to a merged migration. |
| `package.json`, `pnpm-lock.yaml` | The later PR rebases. Resolve lockfile conflicts by taking `main`'s lockfile and re-running `pnpm install`; never hand-edit the lockfile. |
| `src/contracts/database.types.ts` | Regenerate with `pnpm db:types` after rebasing; never merge conflicting hunks by hand. |
| `docs/tasks/T-xxx.md` | Only the claimant edits a packet's status; packet content changes go through the supervisor. |

## 4. Labels (who must act)

| Label | Meaning | Who acts next |
|---|---|---|
| `blocked` | Cannot proceed; the PR or issue says on what | Whoever owns the blocker |
| `needs-contract` | A contract change is requested | The owning lane (ADR PR), then the supervisor |
| `needs-supervisor` | A decision is needed: security, tenancy, data policy, scope, or plan conflict | Supervisor |
| `cross-lane` | PR intentionally touches both lanes; the reason is in the body | Supervisor review required |
| `policy-violation` | Unreviewed change reached `main` (opened by `main-guard`) | Supervisor; staging deploys are blocked until closed |
| `question` | Clarification asked; asker continues on a stated assumption (§6) | Supervisor via `/terraoi-inbox` |
| `answered` | Supervisor answered and closed it | Asker, at the start of their next session |
| `provisional` | PR built on an assumption from an open question; CI blocks merge | Asker, once the question is answered |

## 5. Supervisor findings

The supervisor posts **one review per round**, starting with `[Supervisor]`, with two sections:

- **Blocking**: numbered items (`B1`, `B2`…), each with file:line and the rule broken. All must be fixed before merge.
- **Non-blocking**: numbered `N1`, `N2`…; fix them or reply with a reason.

Builders' agents address Blocking items first, push, then **reply to each item by its number** ("B1: fixed in <sha>" or "B2: disagree because…"). Do not mark conversations resolved; the supervisor resolves them. After a push, request a re-review. Approvals of an earlier commit do not count (`main-guard`).

## 6. Questions: ask, continue, pick up

The supervisor answers asynchronously, usually within a working day, not within minutes. A question must therefore **never leave you idle**.

**1. Search first:** [FAQ.md](FAQ.md), closed `question` issues (`gh issue list --state closed --label question --search "<words>"`), then the plan sections your packet cites.

**2. Ask with the right form** (both auto-assign the supervisor):

| Kind | Use when | Form / label |
|---|---|---|
| **Clarification** | What a doc, packet or contract means; where something goes; which existing pattern to follow | *Question (clarification)* → `question` |
| **Decision** | Any trigger below | *Needs supervisor decision* → `needs-supervisor` |

Decision triggers (never decide these yourself):
- The task needs a change to tenancy, RLS, the gateway clearance or verification.
- Two sources of truth disagree (packet vs plan, contract vs test).
- A fix would require weakening a test, a lint rule or a non-negotiable.
- The packet's acceptance tests cannot be written as stated.
- A contract change is needed (use `needs-contract`, §2) or the packet's scope looks wrong.

Every question states **what you will assume until answered** and whether that is cheap to reverse.

**3. Keep working:**
- **Clarification, reversible assumption:** continue on it. Add the `provisional` label to your PR and the line `Provisional on: #<issue>` to its description. CI (`provisional`) keeps the PR unmergeable until the question is closed with `answered`.
  - That line is machine-parsed and the grammar is strict: `Provisional on: none`, or `Provisional on: #12, #15` — and nothing else on the line. Emphasis around the phrase is tolerated (`**Provisional on: #37**`); prose on the same line is not. `Provisional on: none. The ADR is blocked on #62, #65 …` is reported as a **malformed directive** instead of quietly registering #62 and #65 as dependencies, and a directive that cannot be read never passes silently ([#89](https://github.com/TerraOI/TerraOI/issues/89)). Put the explanation on the next line.
- **Clarification, not reversible, or any decision:** do not pre-empt it. Work on the parts of the packet that don't depend on it, or claim another ready packet (§1).

**4. Pick up answers at the start of every session:**
`gh issue list --author @me --label answered --state closed --search "updated:>=<last session date>"`. Read each `[Supervisor] Answer`. If it says *adjust*, change the provisional work. Then update the PR: remove `provisional` and change the line to `Provisional on: none` (or keep the answered issue number; the check accepts answered ones). The edit re-runs CI.

**Re-runs read the PR as it is now.** Since [#130](https://github.com/TerraOI/TerraOI/pull/130), the `provisional` job fetches the current body and labels from the API, so a re-run no longer replays the event payload ([#89](https://github.com/TerraOI/TerraOI/issues/89), option 2). Editing the body or toggling a label still re-fires the gate, and remains the normal way to refresh it.

**Zero-step failures are not evidence.** A check that failed with **zero steps** and GitHub's billing or spending-limit annotation never ran: it is "no evidence", not "failed". Nobody approves or merges on it. After such an outage, any head whose last green run predates the cutoff is unverified until it runs again ([#100](https://github.com/TerraOI/TerraOI/issues/100)).

**5. Answers become knowledge.** Reusable answers go into [FAQ.md](FAQ.md) (or an ADR for decisions) through the supervisor's `/terraoi-inbox`, so the next agent finds them instead of asking again.

### 6a. Done evidence that needs staging ([#92](https://github.com/TerraOI/TerraOI/issues/92), [#94](https://github.com/TerraOI/TerraOI/issues/94))

Staging evidence is **deferred, never waived**:
- A PR may merge on unit, pgTAP and loopback evidence.
- A packet whose staging step cannot run yet keeps `Status: in progress`, and its status line says **"code complete; staging evidence owed"** and names the issue or §20.8 human step that unblocks it. No acceptance box that names staging is ticked on unit evidence.
- The packet is `done` only when its staging Done evidence is recorded in `docs/status/`. Each owed run is listed under [T-004](tasks/T-004-infrastructure.md).
- **Security claims need a loopback harness now** (§4.3, §4.4): a plain Node `http` listener on `127.0.0.1`, `listen(0)`, closed in `afterAll`, in Vitest under `pnpm verify` — no Docker, no fixed port, no external network. The code under test uses its real `fetch` or route handler, and the test asserts what crossed the socket.

### 6b. pgTAP slots

One file per packet under `supabase/tests/database/`. Claim a new number in the daily sync and add it here; never reuse one.

| Slot | File | Owner |
|---|---|---|
| 000 | `000_guardrails` | T-003 (merged) |
| 001 | function privileges | [#60](https://github.com/TerraOI/TerraOI/issues/60) |
| 010, 011 | `010_tenancy`, `011_identity` | merged |
| 012 | `012_auth_methods` | T-201 |
| 013 | `013_tenant_admin` | T-202 (also `policy_revision`, [#98](https://github.com/TerraOI/TerraOI/issues/98)) |
| 014 | `014_identity_session` | T-102 (merged) |
| 015 | locale and timezone | [#67](https://github.com/TerraOI/TerraOI/issues/67) |
| 016 | session worker role | [#171](https://github.com/TerraOI/TerraOI/pull/171) |
| 017 | scoped identity reads (`current_membership_v1`, `current_policy_revision_v1`) | [#171](https://github.com/TerraOI/TerraOI/pull/171) |
| 020 | `020_knowledge` | T-111 (merged) |
| 025 | `025_collection_admin` | T-111b |
| 030 | `030_pilot_inquiries` | T-130 (merged) |
| 035 | `035_chat_persistence` | T-104 |
| 036 | `036_chunk_publish` | T-113 ([#136](https://github.com/TerraOI/TerraOI/issues/136)) |
| 037 | `037_search_corpus` | T-114 ([#136](https://github.com/TerraOI/TerraOI/issues/136)) |
| 040 | `040_knowledge_uploads` | T-112 (merged) |
| 041 | `041_knowledge_uploads_guard` | T-112c ([#96](https://github.com/TerraOI/TerraOI/issues/96)) |
| 045 | `045_ingestion_jobs` | T-211 |
| 050 | `050_review_publish` | T-213 |
| 060 | `060_project_acl` | T-214 |
| 070 | `070_exact_lookup` | T-216 |
| 075 | `075_experts_and_prompts` | T-311 |
| 080 | `080_forms` | T-301 |
| 085 | `085_chat_feedback` | T-302 |
| 087 | `087_knowledge_submissions` | T-302b |
| 090 | `090_eval_cases_and_runs` | T-312 |
| 095 | `095_budgets_and_run_audit` | T-313 |
| 100 | `100_lifecycle_switches` | T-304 |
| 105 | `105_provider_health` | T-314 |

T-116 claims its slot in the daily sync.

## 7. Daily and weekly rhythm

- **Daily (builders, 15 min):** open PRs, claims, `blocked` and `needs-contract` items, next migration timestamps. Record anything decided in the relevant PR or issue, not only in chat.
- **Each working day (supervisor):** `/terraoi-inbox`; target is decisions within one working day and clarifications within two.
- **Weekly (supervisor):** batch review of merged non-protected PRs, gate progress, `docs/status/YYYY-Www.md` update, packets for the next week.
- **Weekly (steward, Mondays):** the `repo-hygiene` workflow posts findings to the `housekeeping` issue; the supervisor runs `/terraoi-housekeeping` and picks which fixes to make. Builders fix items assigned to their lane before claiming new work.
