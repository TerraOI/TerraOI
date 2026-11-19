# First-week observation plan (plan §14, §17.1)

**Status of this runbook: prepared; the ≥2-week §14 clock has not started.** That clock begins at the M1-PILOT gate, not at this rehearsal ([T-406](../tasks/T-406-pilot-onboarding.md) Out of scope). What follows is what to **read** on days 1–7 of a synthetic staging pilot (and, later, of the real pilot), and how to keep the measures from collapsing into a single misleading number.

Metric queries and alert rules live in [T-405](https://github.com/TerraOI/TerraOI/pull/192) ([#192](https://github.com/TerraOI/TerraOI/pull/192)). Until those tables exist, every cell that needs them is **not_available** and names the missing PR — never a shadow table.

## What to read, days 1–7

| Day | Read | Why §14 / §17.1 cares | Source when available |
|---|---|---|---|
| 1 | Sign-in success on the exact host; generic no-access for `invited`/`removed` | F02: identity ≠ membership | T-102 / T-201 staging captures |
| 1 | Isolation smoke: tenant A refuses tenant B's corpus | §16 Host/Tenant rows; week-1 smoke re-run | Chat + search_corpus once #178/#160 land |
| 2 | Refusal / partial / unavailable counts **separately** | §14: refusing quickly is not a successful answer | T-405 / chat audit |
| 2–3 | Four latency classes kept apart (route, retrieve, compose, verify) | §17.1 | T-405 model-chain metrics |
| 3–4 | Which tier answered, per expert | §14.1: a cheap tier with poor quality must be visible | T-313 run audit (not claimable until `agent_runs`) |
| 4–5 | Kill-switch drill recorded (platform / tenant / provider) | §15.2 gate item; T-304 owns the drill | T-304 + [incident-notes.md](https://github.com/TerraOI/TerraOI/pull/191) (T-404) |
| 5–6 | Feedback → draft case count (locators only) | §14.1 step 5; #102 exit vs entry | [pilot-feedback-loop.md](pilot-feedback-loop.md) |
| 7 | Outstanding owner steps still open | §20.8 honesty | Tables below + [BACKLOG.md](https://github.com/TerraOI/TerraOI/pull/190) D-rows |

## Counters that must not be averaged away

| Measure | How to misread it | Correct read |
|---|---|---|
| "Success rate" | Mixing refusals into failures | Keep refused / partial / unavailable / answered distinct |
| "Latency" | One p95 across the whole chain | Four classes per §17.1 |
| "Quality" | Averaging tiers | Per expert **and** per tier (§14.1) |
| "Pilot cases" | Counting drafts toward §14.1 entry | Drafts → exit report only (#102) |
| "≥30 / expert / ≥2 weeks" | Starting the clock in week 4 | Clock starts at M1-PILOT gate |

## Owner-set thresholds (do not invent numbers)

Paid-tier drift share, box-offline window, verification-pass floor, spend ceilings, alert destinations: all `<owner-set>` (D-5 / D-7). [T-405](https://github.com/TerraOI/TerraOI/pull/192) may ship rules with placeholders; this plan only says **which** numbers to watch once the owner fills them.

## Owner-step table (week-one)

| Owner step | Blocker | When it bites |
|---|---|---|
| Fill D-5 operational numbers | D-5 | Day 2–3 alerts are meaningless without them |
| Name support / switch authority | U-9 | Day 4 drill has no flipper |
| Confirm gate before real users | D-11 | Before any non-synthetic invite |
| Sign M1-PILOT in `docs/status/` | §20.8 / D-8 | Starts the §14 two-week clock |

## Stop conditions

- Publishing a "green week" that mixed refusals into successes → **rewrite the row**; do not tick T-406 boxes on that evidence.
- Starting the ≥2-week clock before the gate row exists → **stop**; that steals exit credit.
- Filling `<owner-set>` thresholds with guessed values in-repo → **stop**; leave the placeholder and the D-5 pointer.
