# Support path and escalation (plan §17.1, §20.3 T-406)

**Status of this runbook: prepared; staffing is `<owner-set>`.** §17.1 gives mechanisms, not people. Until the owner names who answers and who may flip a switch (U-9 / D-5 / D-7 in [BACKLOG.md](https://github.com/TerraOI/TerraOI/pull/190)), every escalation target below is a **role placeholder**, never a person. Inventing an on-call rota in this file would be worse than admitting there is none.

This runbook is the employee → decision ladder. Kill-switch mechanics stay in [T-304](../tasks/T-304-kill-switch-provisioning.md); release/rollback stay in [T-404](https://github.com/TerraOI/TerraOI/pull/191)'s runbooks (`production-release.md`, `rollback.md`, `incident-notes.md` on [#191](https://github.com/TerraOI/TerraOI/pull/191)). Do not duplicate those procedures here — link and say which symptom maps where.

## What an employee reports, and where it goes

| Symptom class | First read (read-only) | Escalate to | Switch / rollback? |
|---|---|---|---|
| "Wrong tenant / I see another company's data" | Isolation evidence: pgTAP `010`/`020`/`025`; preflight `node scripts/check-release-preflight.mjs --env <env>` (once T-404 lands) | `OWNER` immediately — top severity | Do **not** flip a provider switch first; freeze, capture, then follow [incident-notes.md](https://github.com/TerraOI/TerraOI/pull/191) |
| "No answer / refused / unavailable" | Run id → which refusal key → whether evidence was empty vs failed (§8.2; §14: refusing quickly is not a successful answer) | On-call builder (`<owner-set>`) | Usually none; if a provider is poisoned, T-304 provider switch |
| "Answer cites something I should not see" | Citation re-auth path (F24); collection/project ACL (T-214 when present) | `OWNER` + lane that owns the ACL | Tenant or platform switch only on `OWNER` decision |
| "Invite / sign-in broken" | Host exactness (F01/F02); membership state (`invited`/`active`/`removed`) | Lane 1 (T-102/T-201) | None |
| "Upload / document missing" | Upload route 503 vs real error; today `upload-adapters.ts:19` is still the deliberate `null` (U-1) | Lane 2 | None until U-1 closes |
| "Model / provider slow or wrong" | [T-405](https://github.com/TerraOI/TerraOI/pull/192) chain metrics once they exist; health once T-314 exists | On-call builder; `OWNER` for switch flip | Provider or platform switch per T-304 |

## Read-only diagnostic an agent may write · `AGENT`

When the audit/budget read RPC from T-313/T-405 exists, the diagnostic is:

1. run id (from the chat/UI surface the employee used);
2. audit chain: which tier answered, which provider, clearance class;
3. corpus generation pinned for that answer;
4. whether a kill switch was already on.

Until those tables exist, the agent records **not run** for this half — never invents a shadow table to make a chart ([T-405](https://github.com/TerraOI/TerraOI/pull/192) honesty rule).

## Kill switches — use, do not redefine

| Switch | Stops | Does not undo | Who may flip |
|---|---|---|---|
| platform | new model calls platform-wide | data already sent; leased jobs | `OWNER` only (`<owner-set>` name) |
| tenant | that tenant's agent runs and chat | published sources; rows already written | `OWNER` only |
| provider | routing to one provider | requests that provider already received | `OWNER` only |

**§17.1 note, restated:** cancelling new model calls does not erase data already sent. Any incident involving an uncleared provider has two halves — stop the flow, then record what left — and the second half is an audit question (T-313), not a memory exercise.

## Rollback vs support

- App/DNS/index pointer rollback → [rollback.md](https://github.com/TerraOI/TerraOI/pull/191) (T-404).
- "Something is wrong for one employee" that is not a bad deploy → stay on this ladder; do not roll back the fleet to fix one membership.

## Owner-step table

| Owner step | Blocker | Notes |
|---|---|---|
| Name on-call builder + hours | U-9 | Until named, escalation stops at "builder lane" |
| Name who may flip switches | U-9 / D-7 | Never the agent |
| Alert destination | D-5 / D-7 | T-405 rules stay `<owner-set>` |
| Confirm no real-user support before M1-PILOT | D-11 | Synthetic rehearsal only |

## Stop conditions

- A request to "just add me as admin on the tenant" → **refuse**; F05; point at T-304's negative.
- A request to paste client document text into an issue or this repo → **refuse**; AGENTS §4.7; use locators only.
- Flipping a switch without writing the reason into the audit/register → **stop** and write it first.
