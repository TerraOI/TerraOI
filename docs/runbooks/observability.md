# Observability: what is measured, what alerts, what nobody has set yet (plan §17.1)

**Status: the metric set, the alert vocabulary and the rule evaluator exist and run (Observed, below). The SQL behind them does not.** No view, no read RPC, no dashboard and no alert destination exists yet, and none is invented here: the views are a migration, and a migration needs a pgTAP slot claimed in the daily sync ([COORDINATION §6b](../COORDINATION.md)) — slot `111` is proposed in [T-405](../tasks/T-405-dashboards-and-alerts.md), not claimed. Nothing in this file has been configured in any provider console, because that is an `OWNER` action (§20.8).

Run on this machine, 2026-11-15, in `I:\_TerraOI-wt\t-405-ops-metrics`:

```
$ node scripts/check-ops-alerts.mjs --dry-run      → exit 0, 8 lines, each rule fired on its synthetic condition
$ node scripts/check-ops-alerts.mjs --rules        → exit 0, the eight rules with the threshold key each still needs
$ node scripts/check-ops-alerts.mjs                → exit 2 (usage), nothing evaluated
```

**What a green dry run does not mean:** it proves each rule is *capable* of firing. It is not an alert that was delivered, not a threshold that was chosen, and not a metric that was read from a database. §17.3 labels keep those apart for a reason.

## The four latency classes stay four numbers

§17.1 asks the dashboards to distinguish them; §14 measures them separately. One "latency" panel is how an ingestion backlog gets read as a slow answer, which is the misreading that sends the wrong person looking at the wrong half of the system.

| Class | Metric (`scripts/ops-metrics.mjs`) | The one query | Measurable on `main` at `10868ad`? |
|---|---|---|---|
| interactive | `interactive_latency_p95`, `provider_latency_p95` | percentile of request→answer, and of provider call | **No** — `agent_runs` and the attempt records are T-104/T-313 |
| ingestion queue | `ingestion_queue_depth`, `ingestion_queue_oldest_age`, `ingestion_lease_expired_count`, `ingestion_failed_not_replayed`, `ingestion_attempt_pressure` | over `public.ingestion_jobs` by `stage` and `executor` | **Yes** — the table is merged (`20261105070000_knowledge_core.sql:353`); the job API (#149/#158) is what writes it today, so until then the honest reading is "empty because nothing runs yet" |
| extraction / index | `extract_stage_age_local_box`, `extract_stage_age_cloud_worker`, `index_generation_publish_lag`, `published_generation_pinned` | oldest waiting `extract` per executor; generation build→publish | **Yes** for the job and index tables; the box *uptime* half needs T-314 |
| manual review | `review_backlog_age` | oldest item awaiting a human | **No** — review state is T-213, not started |

Everything else the packet lists — `authz_anomaly_count`, `audit_write_failure_count`, `budget_reservation_failure`, `provider_availability`, `fallback_rate`, `verification_pass_rate`, `eval_score_by_tier`, `cost_per_answered_question`, `free_allowance_burn`, `paid_tier_share`, `switch_state_age`, `operational_reminder_lag` — reports `not_available` naming its owning packet. **Never `0`.** A zero on a dashboard whose table does not exist is the failure this packet exists to prevent (§8.2: empty and failed are different answers).

## The eight rules

Five §17.1 classes plus the three named model-chain alarms. `thresholdKind: definitional` means §17.1 itself sets the number ("any audit write failure"); `owner_set` means nobody may fill it in from a builder's side (§18.3, D-5):

| Rule | Class | Threshold | Proof it can fire (the dry run) |
|---|---|---|---|
| `authorization_anomalies` | authorization | `authz_anomaly_count_max` ⟨owner-set⟩ | 5 scope-mismatch denials vs ceiling 3 |
| `audit_loss` | audit | definitional: any failed audit write | one failed write |
| `budget_failure` | budget | `budget_refusal_count_max` ⟨owner-set⟩ | 12 refusals vs ceiling 5 |
| `stale_critical_collections` | freshness | `critical_collection_max_age_seconds` ⟨owner-set⟩ | a critical collection 40 days stale vs 21 days |
| `stopped_operational_reminders` | scheduler | `reminder_overdue_max_seconds` ⟨owner-set⟩ | outbox's oldest event 3 h vs 30 min |
| `paid_tier_share_drift` | model chain | `paid_tier_share_max` ⟨owner-set⟩ | 45% paid vs 25% |
| `box_offline_too_long` | model chain | `box_offline_max_seconds` ⟨owner-set⟩ | a tenant's extract queue 6 h deep vs 2 h (ADR-0005: one stuck job blocks that box until a human intervenes) |
| `verification_pass_rate_below_baseline` | model chain | `verification_pass_floor` ⟨owner-set⟩ | pass rate 0.62 vs floor 0.80 |

A rule with no threshold reports `threshold_unset` and **stays enabled for the next run** — it does not count as passing. A rule whose evaluation throws reports `evaluation_error`, the other rules are still evaluated, and the CLI exits 1 so nobody reads it as a clean run.

## Panel list, and the `OWNER` lines

| # | Panel | Source | Who |
|---|---|---|---|
| 1 | Queue age by stage and executor | `ingestion_queue_oldest_age`, `ingestion_queue_depth` | `AGENT` defines; `OWNER` picks the product |
| 2 | Stuck and unreplayed jobs | `ingestion_failed_not_replayed`, `ingestion_lease_expired_count` | `AGENT` defines; the dead-letter state is **nobody's yet** (U-3) |
| 3 | Tenant box health | `extract_stage_age_local_box` + T-314's uptime probe | `AGENT` defines; `OWNER` runs the probe |
| 4 | Corpus freshness and pinned generation | `collection_freshness_age`, `published_generation_pinned`, `index_generation_publish_lag` | `AGENT` defines |
| 5 | Model chain per provider × task class | availability, latency, fallback rate (F40's closed reasons), verification pass rate, eval score by tier, cost per answered question, free-allowance burn | `AGENT` defines; **all `not_available` until T-313/T-116/T-312 land** |
| 6 | Review backlog | `review_backlog_age` | waits on T-213 |

`OWNER` in the provider console, whichever product is chosen (Workers Observability + alert rules, an external APM, or a Lane 1 page over the ops RPC — an owner choice with a cost, and the metric definitions are written to survive any of the three):

1. Create the dashboard and attach panels 1–6. `OWNER`
2. Enter the seven ⟨owner-set⟩ thresholds above, and **write the same numbers into the week's register** so a rule's behaviour is knowable without console access. `OWNER`
3. Choose and test the alert destination (page, e-mail, or a channel) and record who is on call. `OWNER` — the destination does not exist in this repository, and a scheduled job that reads a production database needs the credential story T-004's last checkbox says may not exist on this plan level (D-7).
4. Add the box-uptime probe and the OCR-queue-age probe per tenant box. `OWNER` (T-314's drill proves detection within one check interval; that drill has not been run).
5. Set retention for metric and log data. `OWNER` (§17.2 keeps the rollback artifact pair; retention decides how far back either can be read).
6. No `.github/workflows/` alert job is written here, and none should be written by a builder: a workflow whose job is to page a human about production is a protected-path, owner-side change ([#180](https://github.com/TerraOI/TerraOI/issues/180) records the same scope limit).

## Log and metric hygiene, as a check

The machine half is `FORBIDDEN_OUTPUT_FIELDS` in `scripts/ops-metrics.mjs`: a metric's declared output columns are refused if they carry a prompt body, a personal prompt, document text, chunk text, a query string, a signed URL, an object key, a provider **name** (grouping is by `provider_id`), eval case text, or a contact field. The test asserts the list is non-vacuous, and every metric row here is an aggregate with `scoping.mode = organisation`.

The human half, restated from AGENTS §4.6/§4.7 and §17.1: no raw document in a log line, no credential in a message or a panel title, no alert body that quotes a user's prompt, and the content-rich audit views stay separate from ordinary operational counts — an operations metric must never become a way to read someone's corpus.

## What has to happen before this is more than definitions

| Step | Blocked on | Who |
|---|---|---|
| Claim pgTAP slot `111` and write the migration with the read-only views + one scoped read RPC (server-only unless the supervisor rules otherwise, FAQ-0010) | the daily sync; and on the four merged tables it can start with today | lane + supervisor |
| Alert dry-runs **on staging**, one verdict per rule in the register | [#177](https://github.com/TerraOI/TerraOI/issues/177) (open `policy-violation` → `deploy-staging.yml` refuses) | owner clears, then `AGENT` runs |
| The seven thresholds | D-5 (§18.3) | `OWNER` |
| The destination and the on-call line | D-7, T-004's plan-level checkbox | `OWNER` |
| The dead-letter state, so "failed, nobody replayed it" has an end state rather than a metric | U-3 — no packet owns it | supervisor decides who |
