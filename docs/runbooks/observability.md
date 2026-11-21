# Observability: what is measured, what alerts, what nobody has set yet (plan §17.1)

**Status: the metric set, the alert vocabulary and the rule evaluator exist and run (Observed, below). The SQL behind them does not.** No view, no read RPC, no dashboard and no alert destination exists yet, and none is invented here: the views are a migration, and a migration needs a pgTAP slot claimed in the daily sync ([COORDINATION §6b](../COORDINATION.md)) — slot `111` is proposed in [T-405](../tasks/T-405-dashboards-and-alerts.md), not claimed. Nothing in this file has been configured in any provider console, because that is an `OWNER` action (§20.8).

Observed on commits `f6b08f0` / `4c29471` / `d28df18` (branch `t-405-ops-metrics`), and re-checked after Round-1 fixes:

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
| ingestion queue | `ingestion_queue_depth`, `ingestion_queue_oldest_age`, `ingestion_lease_expired_count`, `ingestion_failed_not_replayed`, `ingestion_failed_other`, `ingestion_attempt_pressure` | over `public.ingestion_jobs` by `stage` and `executor`; dead letter = `status='failed' AND last_error='retries_exhausted'` ([#99](https://github.com/TerraOI/TerraOI/issues/99) / ADR-0005 §10b) | **Yes** for the table columns (`status`, `last_error`); writers that set `retries_exhausted` land with T-211 |
| extraction / index | `extract_stage_age_local_box`, `extract_stage_age_cloud_worker`, `index_generation_publish_lag`, `published_generation_pinned` | oldest **in-flight** `extract` (`status in ('queued','leased','running')`, wait on `updated_at`); building→active lag; `status='active'` pin | **Yes** for job and index tables (`embedding_indexes.status` is `building\|active\|retired` — no `published_at`); box *uptime* is separate (`local_box_uptime`, owedBy T-314) |
| manual review | `review_backlog_age` | oldest item awaiting a human | **No** — review state is T-213, not started |

Corpus freshness for **critical** collections (`collection_freshness_age`) is **not** measurable as ok on main: `knowledge_collections` has no `criticality` (owedBy T-213). Quarantined sources (`quarantined_sources_count` over `source_versions.state`) are measurable. Everything else the packet lists that still lacks a table — including `local_box_uptime`, `stale_saved_answers`, `per_tenant_fairness`, `expert_usefulness`, authz/budget/eval/provider metrics, `switch_state_age` (T-304 [#193](https://github.com/TerraOI/TerraOI/pull/193)) — reports `not_available` naming its owning packet. **Never `0`.** A multi-metric rule with any missing input is `not_available` listing those inputs, never `ok`.

## The eight rules

Five §17.1 classes plus the three named model-chain alarms. `thresholdKind: definitional` means §17.1 itself sets the number ("any audit write failure"); `owner_set` means nobody may fill it in from a builder's side (§18.3, D-5):

| Rule | Class | Threshold | Proof it can fire (the dry run) |
|---|---|---|---|
| `authorization_anomalies` | authorization | `authz_anomaly_count_max` ⟨owner-set⟩ | 5 scope-mismatch denials vs ceiling 3 |
| `audit_loss` | audit | definitional: any failed audit write | one failed write |
| `budget_failure` | budget | `budget_refusal_count_max` ⟨owner-set⟩ | 12 refusals vs ceiling 5 |
| `stale_critical_collections` | freshness | `critical_collection_max_age_seconds` ⟨owner-set⟩ | a critical collection 40 days stale vs 21 days (dry run only; live eval is `not_available` until T-213 adds criticality) |
| `stopped_operational_reminders` | scheduler | `reminder_overdue_max_seconds` ⟨owner-set⟩ | both reminder lag and outbox lag supplied; a partial reading is `not_available` |
| `paid_tier_share_drift` | model chain | `paid_tier_share_max` ⟨owner-set⟩ | 45% paid vs 25% |
| `box_offline_too_long` | model chain | `box_offline_max_seconds` ⟨owner-set⟩ | `local_box_uptime` and in-flight extract queue age both over the window (ADR-0005: one stuck job blocks that box) |
| `verification_pass_rate_below_baseline` | model chain | `verification_pass_floor` ⟨owner-set⟩ | pass rate and eval baseline both present; a partial reading is `not_available` |

A rule with no threshold reports `threshold_unset` and **stays enabled for the next run** — it does not count as passing. A rule whose evaluation throws reports `evaluation_error`, the other rules are still evaluated, and the CLI exits 1 so nobody reads it as a clean run.

## Panel list, and the `OWNER` lines

| # | Panel | Source | Who |
|---|---|---|---|
| 1 | Queue age by stage and executor | `ingestion_queue_oldest_age`, `ingestion_queue_depth` | `AGENT` defines; `OWNER` picks the product |
| 2 | Stuck, dead-letter and other failures | `ingestion_failed_not_replayed` (dead letter per #99 / ADR-0005 §10b), `ingestion_failed_other`, `ingestion_lease_expired_count`, `ingestion_attempt_pressure` | `AGENT` defines; **replay** under a new parser generation is T-405 deferred past M1 |
| 3 | Tenant box health | `local_box_uptime` (T-314) + `extract_stage_age_local_box` (in-flight only) | `AGENT` defines; `OWNER` runs the probe |
| 4 | Corpus freshness and pinned generation | `collection_freshness_age` (owedBy T-213 criticality), `quarantined_sources_count`, `published_generation_pinned` (`status='active'`), `index_generation_publish_lag` (`status='building'`) | `AGENT` defines |
| 5 | Model chain per provider × task class | availability, latency, fallback rate (F40's closed reasons), verification pass rate, eval score by tier, cost per answered question, free-allowance burn, fairness, expert usefulness, stale saved answers | `AGENT` defines; **all `not_available` until their owning packets land** |
| 6 | Review backlog | `review_backlog_age` | waits on T-213 |

`OWNER` in the provider console, whichever product is chosen (Workers Observability + alert rules, an external APM, or a Lane 1 page over the ops RPC — an owner choice with a cost, and the metric definitions are written to survive any of the three):

1. Create the dashboard and attach panels 1–6. `OWNER`
2. Enter the seven ⟨owner-set⟩ thresholds above, and **write the same numbers into the week's register** so a rule's behaviour is knowable without console access. `OWNER`
3. Choose and test the alert destination (page, e-mail, or a channel) and record who is on call. `OWNER` — the destination does not exist in this repository, and a scheduled job that reads a production database needs the credential story T-004's last checkbox says may not exist on this plan level (D-7).
4. Add the box-uptime probe and the OCR-queue-age probe per tenant box. `OWNER` (T-314's drill proves detection within one check interval; that drill has not been run).
5. Set retention for metric and log data. `OWNER` (§17.2 keeps the rollback artifact pair; retention decides how far back either can be read).
6. No `.github/workflows/` alert job is written here, and none should be written by a builder: a workflow whose job is to page a human about production is a protected-path, owner-side change ([#180](https://github.com/TerraOI/TerraOI/issues/180) records the same scope limit).

## Log and metric hygiene, as a check

The machine half is `FORBIDDEN_OUTPUT_FIELDS` in `scripts/ops-metrics.mjs`: a metric's declared output columns are refused if they carry a prompt body, a personal prompt, document text, chunk text, a query string, a signed URL, an object key, a provider **name** (grouping is by `provider_id`), eval case text, or a contact field. The test asserts the list is non-vacuous, and every metric row here is an aggregate with `scoping.mode = organisation`. Each metric also declares `sourceColumns`; the unit test checks them against merged migration DDL (or requires `owedBy` when a column is absent).

The human half, restated from AGENTS §4.6/§4.7 and §17.1: no raw document in a log line, no credential in a message or a panel title, no alert body that quotes a user's prompt, and the content-rich audit views stay separate from ordinary operational counts — an operations metric must never become a way to read someone's corpus.

## What has to happen before this is more than definitions

| Step | Blocked on | Who |
|---|---|---|
| Claim pgTAP slot `111` and write the migration with the read-only views + one scoped read RPC (server-only unless the supervisor rules otherwise, FAQ-0010) | the daily sync; and on the merged tables it can start with today | lane + supervisor |
| Alert dry-runs **on staging**, one verdict per rule in the register | [#177](https://github.com/TerraOI/TerraOI/issues/177) (open `policy-violation` → `deploy-staging.yml` refuses) | owner clears, then `AGENT` runs |
| The seven thresholds | D-5 (§18.3) | `OWNER` |
| The destination and the on-call line | D-7, T-004's plan-level checkbox | `OWNER` |
| Dead-letter **replay** under a new parser generation | T-405 deferred past M1 ([#99](https://github.com/TerraOI/TerraOI/issues/99) / ADR-0005 §10b); observe via `ingestion_failed_not_replayed` now | lane (later T-405 PR) |
| `criticality` so stale-critical alerts can evaluate | T-213 | lane 2 |
