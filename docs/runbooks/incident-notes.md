# Incident notes (plan §17.1)

Short, because an incident is not the time to discover what a runbook means. Every line is either `AGENT` (a command that exists in this repository) or `OWNER` (an action plan §20.8 reserves to a human).

## The note §17.1 requires, stated first

**Cancelling new model calls does not erase data already sent.** A kill switch stops the next request; it does not recall the last one. So an incident that involves a provider you no longer trust has two halves: stop the flow, and record what had already left. §12.4's clearance matrix and §18.2 ("Client data reaches an uncleared provider") decide how seriously the second half is treated, and the answer to "what did we send, when, to whom" comes from the audit trail — [T-313](../tasks/T-313-budgets-run-audit.md) — not from memory.

## First five minutes · `OWNER` decides, `AGENT` measures

1. Name the symptom in one line, with the time and the environment (`staging` or `production`). Write it in the register before anything else.
2. Is a tenant reading another tenant's data? If yes, that is the top-severity case: the isolation guard is pgTAP `010`/`020`/`025`, and the answer to "did a restore or a route change cause it" comes from [restore-rehearsal.md](restore-rehearsal.md)'s assertion list and the preflight output — `node scripts/check-release-preflight.mjs --env <env>` is a two-second check that has a real chance of explaining a wrong-host deploy.
3. Is a provider call going somewhere it should not? Stop the flow (kill switch, below), then read the audit trail for what already went out.
4. Is the local box involved (offline, slow, or returning garbage)? §13's contract is that it degrades rather than blocks; the drill that proves detection within one check interval is [T-314](../tasks/T-314-external-adapters-health.md)'s owed staging evidence (U-7 in [BACKLOG.md, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190) records that it slipped).
5. Decide rollback or forward-fix, using [rollback.md](rollback.md) step 3 — the schema-compatibility check, not the reflex.

## Kill switches are T-304's, not this runbook's

The switches themselves are [T-304](../tasks/T-304-kill-switch-provisioning.md) (platform, tenant and provider switches, with the provider key depending on #143's registry). This file only says how they are used, and what they do **not** do:

| Switch | Stops | Does not undo |
|---|---|---|
| platform | new model calls platform-wide | data already sent; queued jobs already leased |
| tenant | that tenant's agent runs and chat | published sources; rows already written |
| provider | routing to one provider | the requests that provider already received |

A switch flipped during an incident is recorded with its reason in the audit trail, and the §15.2 gate item "kill switches verified" is a *drill*, owned by T-304 — rehearsing around it is this packet's job, performing it is not.

## What to record, in one table in the week's register

| Field | Why |
|---|---|
| Symptom, environment, first-observed time | the sequence is the evidence |
| What the preflight said, verbatim line | it distinguishes a config leak from a code bug, in seconds |
| Artifact pair before and after (tag + `wrangler` version id + index generation) | §17.2: a rollback without the pair is a story |
| Migrations applied during the window (`scripts/check-migrations.mjs` output) | decides whether a rollback is even legal |
| Which switch was flipped, when, by whom, with what reason | and that it did not recall earlier calls |
| Data that left the platform, if any: provider, time range, clearance class | §12.4 and §18.2 make this the part with consequences |
| Every step that could not be performed, and the human step that would have allowed it | §6a: owed, never waived |

## Escalation, staffing and thresholds — all `<owner-set>`

Who is paged, in which hours, who may flip a switch, and what number of stale jobs or failed verifications counts as an incident: none of those is a builder's decision, and §17.1 leaves them owner-set (D-5 and D-7 in [BACKLOG.md, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190), U-9 for the staffing question). Until they are named, this section stays a placeholder on purpose — a runbook that invents an escalation path is worse than one that admits there is none.

## Post-incident, while it is still true

- File a `question` or `needs-supervisor` issue for anything the runbook could not answer, then add the row in [BACKLOG.md, carried by draft #190](https://github.com/TerraOI/TerraOI/pull/190) that points at it — the register is what makes it survive to the next session.
- If the incident was caused by a check that exists but does not gate anything, that is the §100 / [#180](https://github.com/TerraOI/TerraOI/issues/180) class of defect: a step that cannot fail is not evidence. Report it as such.
- Add the missing assertion to the runbook **in the same PR** as the fix, so the next person inherits the lesson rather than the scar.
