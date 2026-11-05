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
- **Clarification, not reversible, or any decision:** do not pre-empt it. Work on the parts of the packet that don't depend on it, or claim another ready packet (§1).

**4. Pick up answers at the start of every session:**
`gh issue list --author @me --label answered --state closed --search "updated:>=<last session date>"`. Read each `[Supervisor] Answer`. If it says *adjust*, change the provisional work. Then update the PR: remove `provisional` and change the line to `Provisional on: none` (or keep the answered issue number; the check accepts answered ones). The edit re-runs CI.

**5. Answers become knowledge.** Reusable answers go into [FAQ.md](FAQ.md) (or an ADR for decisions) through the supervisor's `/terraoi-inbox`, so the next agent finds them instead of asking again.

## 7. Daily and weekly rhythm

- **Daily (builders, 15 min):** open PRs, claims, `blocked` and `needs-contract` items, next migration timestamps. Record anything decided in the relevant PR or issue, not only in chat.
- **Each working day (supervisor):** `/terraoi-inbox`; target is decisions within one working day and clarifications within two.
- **Weekly (supervisor):** batch review of merged non-protected PRs, gate progress, `docs/status/YYYY-Www.md` update, packets for the next week.
- **Weekly (steward, Mondays):** the `repo-hygiene` workflow posts findings to the `housekeeping` issue; the supervisor runs `/terraoi-housekeeping` and picks which fixes to make. Builders fix items assigned to their lane before claiming new work.
