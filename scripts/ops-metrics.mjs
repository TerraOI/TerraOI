/**
 * T-405 (plan §17.1): the metric set and the alert vocabulary, as data.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **A metric with no table underneath it reads `not_available` and names the packet that
 *    will create the table — never `0`.** Plan §8.2's "empty and failed are different answers",
 *    applied to operations. An ops dashboard that shows zero stuck jobs while the stuck-job
 *    table does not exist is worse than one that admits it cannot look.
 * 2. **A rule nobody can make fire is not evidence.** Every rule here carries a synthetic
 *    condition that must fire it (`runDryRuns`), and a rule whose threshold nobody has set
 *    reports `threshold_unset` instead of passing quietly — the same defect class as issue #180,
 *    where a lint step that could not fail was reported as a passing gate.
 *
 * Nothing here connects to a database. Availability is an *input* (`facts.tables`), because a
 * hard-coded "these tables exist as of today" rots the moment a migration merges. The
 * definitions, the units, the tenant scoping and the alert rules are the deliverable; the SQL
 * that fills them in is a read-only view over the owning packet's tables, which is a migration
 * and therefore waits on a pgTAP slot claimed in the daily sync (COORDINATION §6b).
 */

export const LATENCY_CLASSES = [
  "interactive",
  "ingestion_queue",
  "extraction_index",
  "manual_review",
];

/**
 * §17.1's negative test, made checkable: a metric row is an aggregate, and these field shapes
 * are the ones that would turn an operations view into a content-read channel. Provider
 * *identity* is included because §17.1 and `src/contracts/chat.ts` keep provider and model
 * naming away from employee-visible surfaces; a metric may group by `provider_id`.
 */
export const FORBIDDEN_OUTPUT_FIELDS = [
  /prompt_body/i,
  /personal_prompt/i,
  /document_text/i,
  /chunk_(text|detail|body)/i,
  /query_string/i,
  /signed_url/i,
  /object_key/i,
  /provider_(name|slug|display|label)/i,
  /eval_case_text/i,
  /email|address|phone/i,
];

const SCOPE = { mode: "organisation", note: "aggregates group by organisation_id; no cross-tenant row is ever emitted" };

const m = (spec) => ({ scoping: SCOPE, owedBy: null, latencyClass: null, columns: ["organisation_id"], ...spec });

export const METRICS = [
  // ---- model chain, interactive -------------------------------------------------------
  m({
    id: "interactive_latency_p95",
    label: "Answer latency a user actually waits for",
    unit: "seconds",
    kind: "latency",
    latencyClass: "interactive",
    source: { table: "public.agent_runs", query: "percentile_cont(0.95) of (answered_at - requested_at) per organisation" },
    columns: ["organisation_id", "tier", "p95_seconds"],
    owningPacket: "T-104 (chat persistence) + T-313 (run/attempt audit)",
    owedBy: "T-104 (#139) — no agent_runs table on main",
  }),
  // ---- ingestion queue ---------------------------------------------------------------
  m({
    id: "ingestion_queue_depth",
    label: "Jobs waiting by stage",
    unit: "count",
    kind: "count",
    latencyClass: "ingestion_queue",
    source: { table: "public.ingestion_jobs", query: "count(*) where status in ('queued','leased','running') group by stage, executor" },
    columns: ["organisation_id", "stage", "executor", "waiting_count"],
    owningPacket: "T-211 (job API) over T-111's table",
  }),
  m({
    id: "ingestion_queue_oldest_age",
    label: "How long the oldest waiting job has been waiting",
    unit: "seconds",
    kind: "age",
    latencyClass: "ingestion_queue",
    source: { table: "public.ingestion_jobs", query: "max(extract(epoch from now() - created_at)) where status = 'queued'" },
    columns: ["organisation_id", "stage", "oldest_wait_seconds"],
    owningPacket: "T-211 (job API)",
  }),
  m({
    id: "ingestion_lease_expired_count",
    label: "Leases that ran out while the worker was still holding them",
    unit: "count",
    kind: "count",
    latencyClass: "ingestion_queue",
    source: { table: "public.ingestion_jobs", query: "count(*) where status in ('leased','running') and lease_expires_at < now()" },
    columns: ["organisation_id", "stage", "expired_lease_count"],
    owningPacket: "T-211 (job API)",
  }),
  m({
    id: "ingestion_failed_not_replayed",
    label: "Failed jobs nobody requeued — the case ADR-0005 says blocks a tenant's box",
    unit: "count",
    kind: "count",
    latencyClass: "ingestion_queue",
    source: { table: "public.ingestion_jobs", query: "count(*) where status = 'failed' and updated_at < now() - the owner-set replay window" },
    columns: ["organisation_id", "stage", "unreplayed_count", "oldest_failed_seconds"],
    owningPacket: "T-211 (job API); the replay itself is U-3, which no packet owns",
    gap: "no_dead_letter_state",
    gapNote: "ingestion_jobs.status allows queued|leased|running|succeeded|failed|cancelled and has no dead-lettered value (see U-3). This metric makes the case visible; adding the state is a decision for the job API's owner, not something this packet invents in a migration.",
  }),
  m({
    id: "ingestion_attempt_pressure",
    label: "Jobs close to the attempt ceiling",
    unit: "count",
    kind: "count",
    latencyClass: "ingestion_queue",
    source: { table: "public.ingestion_jobs", query: "count(*) where attempt >= the owner-set ceiling minus one" },
    columns: ["organisation_id", "stage", "high_attempt_count", "max_attempt"],
    owningPacket: "T-211 (job API)",
  }),
  // ---- extraction and index ----------------------------------------------------------
  m({
    id: "extract_stage_age_local_box",
    label: "OCR queue age on the tenant's local box",
    unit: "seconds",
    kind: "age",
    latencyClass: "extraction_index",
    source: { table: "public.ingestion_jobs", query: "max(extract(epoch from now() - created_at)) where stage = 'extract' and executor = 'local_box'" },
    columns: ["organisation_id", "oldest_extract_seconds", "waiting_count"],
    owningPacket: "T-211 (job API) + T-314 (the box's health record)",
  }),
  m({
    id: "extract_stage_age_cloud_worker",
    label: "Extraction queue age on the platform Worker",
    unit: "seconds",
    kind: "age",
    latencyClass: "extraction_index",
    source: { table: "public.ingestion_jobs", query: "max(extract(epoch from now() - created_at)) where stage = 'extract' and executor = 'cloud_worker'" },
    columns: ["organisation_id", "oldest_extract_seconds", "waiting_count"],
    owningPacket: "T-211 (job API)",
  }),
  m({
    id: "index_generation_publish_lag",
    label: "Time from an index generation being built to it being publishable",
    unit: "seconds",
    kind: "age",
    latencyClass: "extraction_index",
    source: { table: "public.embedding_indexes", query: "max(extract(epoch from coalesce(published_at, now()) - created_at)) per generation" },
    columns: ["organisation_id", "generation", "publish_lag_seconds"],
    owningPacket: "T-113 (chunk embed and publish)",
  }),
  m({
    id: "published_generation_pinned",
    label: "Which index generation retrieval is answering from, and how many are published",
    unit: "count",
    kind: "count",
    source: { table: "public.embedding_indexes", query: "count(*) filter (where status = 'published') and the pinned generation, per organisation" },
    columns: ["organisation_id", "pinned_generation", "published_generation_count"],
    owningPacket: "T-113; the pointer switch is its SQL half (slot 036)",
  }),
  // ---- corpus freshness and review ---------------------------------------------------
  m({
    id: "collection_freshness_age",
    label: "How stale each critical collection is",
    unit: "seconds",
    kind: "age",
    source: { table: "public.knowledge_collections", query: "max(extract(epoch from now() - sv.published_at)) per collection, over its newest published source version" },
    columns: ["organisation_id", "collection_id", "criticality", "stale_seconds"],
    owningPacket: "T-111 (merged) + T-213 (criticality and review state)",
  }),
  m({
    id: "review_backlog_age",
    label: "How long a change has been waiting on a human reviewer",
    unit: "seconds",
    kind: "age",
    latencyClass: "manual_review",
    source: { table: "public.review_queue", query: "max(extract(epoch from now() - queued_at)) over items awaiting review" },
    columns: ["organisation_id", "review_type", "oldest_pending_seconds"],
    owningPacket: "T-213 (quarantine, revoke and review state)",
    owedBy: "T-213 — not started; no review queue table on main",
  }),
  // ---- outbox and reminders ----------------------------------------------------------
  m({
    id: "outbox_unprocessed_depth",
    label: "Domain events waiting to be dispatched",
    unit: "count",
    kind: "count",
    source: { table: "public.outbox_events", query: "count(*) where processed_at is null group by aggregate_type" },
    columns: ["organisation_id", "aggregate_type", "unprocessed_count"],
    owningPacket: "T-111 (merged) + T-211 (the dispatcher)",
  }),
  m({
    id: "outbox_oldest_lag",
    label: "How long the oldest unprocessed event has waited",
    unit: "seconds",
    kind: "age",
    source: { table: "public.outbox_events", query: "max(extract(epoch from now() - created_at)) where processed_at is null" },
    columns: ["organisation_id", "oldest_event_seconds"],
    owningPacket: "T-111 (merged) + T-211 (the dispatcher)",
  }),
  m({
    id: "operational_reminder_lag",
    label: "Scheduled reminders that stopped going out",
    unit: "seconds",
    kind: "age",
    source: { table: "public.scheduled_reminders", query: "max(extract(epoch from now() - due_at)) over reminders that are due and unsent" },
    columns: ["organisation_id", "reminder_type", "oldest_overdue_seconds"],
    owningPacket: "T-211 (one active scheduler per logical job) over T-130's pilot inquiries",
    owedBy: "T-211 (#149/#158) — no reminder schedule table on main",
  }),
  // ---- §17.1's five alert classes: the facts they read -------------------------------
  m({
    id: "authz_anomaly_count",
    label: "Authorization decisions that look wrong",
    unit: "count",
    kind: "count",
    source: { table: "public.audit_events", query: "count(*) where outcome in ('denied','scope_mismatch') over the owner-set window" },
    columns: ["organisation_id", "anomaly_class", "anomaly_count"],
    owningPacket: "T-313 (run/attempt audit)",
    owedBy: "T-313 — not claimable until agent_runs exists (T-104)",
  }),
  m({
    id: "audit_write_failure_count",
    label: "Audit rows that failed to be written",
    unit: "count",
    kind: "count",
    source: { table: "public.audit_write_failures", query: "count(*) over the owner-set window; any is reportable" },
    columns: ["organisation_id", "failed_write_count"],
    owningPacket: "T-313 (the audit writer)",
    owedBy: "T-313 — not claimable while agent_runs does not exist",
  }),
  m({
    id: "budget_reservation_failure",
    label: "Runs refused for want of budget, and budget accounting that failed",
    unit: "count",
    kind: "count",
    source: { table: "public.budget_accounts", query: "count(*) from reservations where status = 'refused' plus accounting failures" },
    columns: ["organisation_id", "refused_count", "accounting_failure_count"],
    owningPacket: "T-313 (budget authority, §12.3)",
    owedBy: "T-313 — no budget account table on main",
  }),
  // ---- model-chain metrics (§17.1 v1.3, per provider × task class) -------------------
  m({
    id: "provider_availability",
    label: "Provider availability",
    unit: "ratio",
    kind: "ratio",
    source: { table: "public.provider_health", query: "1 - (failed_attempts / attempts) per provider_id x task_class over the owner-set window" },
    columns: ["organisation_id", "provider_id", "task_class", "availability_ratio", "attempt_count"],
    owningPacket: "T-116 (#143) + T-314 (the health snapshot)",
    owedBy: "T-314 — not claimable: T-215/T-311 unwritten",
  }),
  m({
    id: "provider_latency_p95",
    label: "Provider call latency",
    unit: "seconds",
    kind: "latency",
    latencyClass: "interactive",
    source: { table: "public.audit_attempts", query: "percentile_cont(0.95) of call duration per provider_id x task_class" },
    columns: ["organisation_id", "provider_id", "task_class", "p95_seconds"],
    owningPacket: "T-313 (attempt records)",
    owedBy: "T-313 — no attempt table on main",
  }),
  m({
    id: "fallback_rate",
    label: "How often the chain fell back, by the reason F40 already records",
    unit: "ratio",
    kind: "ratio",
    source: { table: "public.audit_attempts", query: "count(*) filter (where fallback_reason is not null) / count(*), grouped by fallback_reason" },
    columns: ["organisation_id", "task_class", "fallback_reason", "fallback_ratio"],
    owningPacket: "T-313; the reason vocabulary is F40's and already closed",
    owedBy: "T-313 — no attempt table on main",
  }),
  m({
    id: "verification_pass_rate",
    label: "Verifier pass rate per tier",
    unit: "ratio",
    kind: "ratio",
    source: { table: "public.audit_runs", query: "count(*) filter (where verifier_outcome = 'pass') / count(*) per tier" },
    columns: ["organisation_id", "tier", "pass_ratio", "run_count"],
    owningPacket: "T-313 (the verifier outcome is traced per run)",
    owedBy: "T-313 — no run table on main",
  }),
  m({
    id: "eval_score_by_tier",
    label: "Eval score per tier, the baseline the alarms compare against",
    unit: "score",
    kind: "score",
    source: { table: "public.eval_results", query: "avg(score) per tier per eval run" },
    columns: ["organisation_id", "tier", "eval_run_id", "mean_score", "case_count"],
    owningPacket: "T-312 (eval harness)",
    owedBy: "T-312 — not claimable; no eval_runs/eval_results on main",
  }),
  m({
    id: "cost_per_answered_question",
    label: "What an answered question cost",
    unit: "currency",
    kind: "cost",
    source: { table: "public.budget_usage", query: "sum(usage_cost) filter (where output_status = 'answered') / count of answered runs, per tier" },
    columns: ["organisation_id", "tier", "cost_per_answer", "answered_count"],
    owningPacket: "T-313 (the ledger)",
    owedBy: "T-313 — no usage table on main",
  }),
  m({
    id: "free_allowance_burn",
    label: "How much of a free allowance has been used",
    unit: "ratio",
    kind: "ratio",
    source: { table: "public.budget_usage", query: "sum(usage_cost) / the owner-set allowance, per provider per period" },
    columns: ["organisation_id", "provider_id", "period", "burn_ratio", "allowance_basis"],
    owningPacket: "T-313 + T-116 (#143, which holds the provider records)",
    owedBy: "T-313 — no usage table on main",
  }),
  m({
    id: "paid_tier_share",
    label: "Share of answers landing on paid tiers",
    unit: "ratio",
    kind: "ratio",
    source: { table: "public.audit_runs", query: "count(*) filter (where tier = 'paid') / count(*) over the owner-set window" },
    columns: ["organisation_id", "paid_share_ratio", "run_count"],
    owningPacket: "T-313 (tier per run is traced)",
    owedBy: "T-313 — no run table on main",
  }),
  m({
    id: "switch_state_age",
    label: "How stale the kill-switch state is",
    unit: "seconds",
    kind: "age",
    source: { table: "public.lifecycle_switches", query: "max(extract(epoch from now() - updated_at)) per switch scope" },
    columns: ["organisation_id", "switch_scope", "state_age_seconds"],
    owningPacket: "T-304 (switch provisioning)",
    owedBy: "T-304 — not claimable; no lifecycle_switches table on main",
  }),
];

/**
 * §17.1's five alert classes plus §17.1 v1.3's three model-chain alarms. The `predicate` sees
 * the metric values and the thresholds; `thresholdKind` separates a definitional threshold
 * ("any audit write failure is reportable", which is §17.1's wording, not an invented number)
 * from an owner-set one. Owner-set numbers are **never** filled in here: §18.3 and D-5 make
 * them the owner's, so a rule with no number says `threshold_unset`.
 */
export const ALERT_RULES = [
  {
    id: "authorization_anomalies",
    className: "authorization",
    metricIds: ["authz_anomaly_count"],
    thresholdKind: "owner_set",
    thresholdKey: "authz_anomaly_count_max",
    destination: "<owner-set: alert destination per §20.8>",
    definition: "anomaly count over the window exceeds the owner-set ceiling",
    predicate: ({ values, thresholds }) => values.authz_anomaly_count > thresholds.authz_anomaly_count_max,
    dryRun: {
      condition: "one organisation records 5 scope-mismatch denials in the window, ceiling 3",
      values: { authz_anomaly_count: 5 },
      thresholds: { authz_anomaly_count_max: 3 },
    },
  },
  {
    id: "audit_loss",
    className: "audit",
    metricIds: ["audit_write_failure_count"],
    thresholdKind: "definitional",
    definition: "any audit row that failed to be written is reportable (§17.1: audit loss)",
    predicate: ({ values }) => values.audit_write_failure_count > 0,
    dryRun: {
      condition: "one audit write fails",
      values: { audit_write_failure_count: 1 },
      thresholds: {},
    },
  },
  {
    id: "budget_failure",
    className: "budget",
    metricIds: ["budget_reservation_failure"],
    thresholdKind: "owner_set",
    thresholdKey: "budget_refusal_count_max",
    destination: "<owner-set>",
    definition: "refusals or accounting failures over the window exceed the owner-set ceiling",
    predicate: ({ values, thresholds }) =>
      values.budget_reservation_failure > thresholds.budget_refusal_count_max,
    dryRun: {
      condition: "12 refused runs against a ceiling of 5",
      values: { budget_reservation_failure: 12 },
      thresholds: { budget_refusal_count_max: 5 },
    },
  },
  {
    id: "stale_critical_collections",
    className: "freshness",
    metricIds: ["collection_freshness_age"],
    thresholdKind: "owner_set",
    thresholdKey: "critical_collection_max_age_seconds",
    destination: "<owner-set>",
    definition: "a collection marked critical is older than the owner-set age",
    predicate: ({ values, thresholds }) =>
      values.collection_freshness_age > thresholds.critical_collection_max_age_seconds,
    dryRun: {
      condition: "a critical collection 40 days stale against a 21-day ceiling",
      values: { collection_freshness_age: 40 * 86400 },
      thresholds: { critical_collection_max_age_seconds: 21 * 86400 },
    },
  },
  {
    id: "stopped_operational_reminders",
    className: "scheduler",
    metricIds: ["operational_reminder_lag", "outbox_oldest_lag"],
    thresholdKind: "owner_set",
    thresholdKey: "reminder_overdue_max_seconds",
    destination: "<owner-set>",
    definition: "a due reminder is older than the owner-set window, or the outbox has stopped draining",
    predicate: ({ values, thresholds }) =>
      values.operational_reminder_lag > thresholds.reminder_overdue_max_seconds ||
      values.outbox_oldest_lag > thresholds.reminder_overdue_max_seconds,
    dryRun: {
      condition: "the outbox's oldest unprocessed event is 3 hours old against a 30-minute window",
      values: { operational_reminder_lag: null, outbox_oldest_lag: 10800 },
      thresholds: { reminder_overdue_max_seconds: 1800 },
    },
  },
  {
    id: "paid_tier_share_drift",
    className: "model_chain",
    metricIds: ["paid_tier_share"],
    thresholdKind: "owner_set",
    thresholdKey: "paid_tier_share_max",
    destination: "<owner-set>",
    definition: "answers drifting to paid tiers beyond the owner-set share (§17.1's first named alarm)",
    predicate: ({ values, thresholds }) => values.paid_tier_share > thresholds.paid_tier_share_max,
    dryRun: {
      condition: "45% of answers on paid tiers against a 25% ceiling",
      values: { paid_tier_share: 0.45 },
      thresholds: { paid_tier_share_max: 0.25 },
    },
  },
  {
    id: "box_offline_too_long",
    className: "model_chain",
    metricIds: ["extract_stage_age_local_box", "switch_state_age"],
    thresholdKind: "owner_set",
    thresholdKey: "box_offline_max_seconds",
    destination: "<owner-set>",
    definition: "the local box offline, or its queue unattended, longer than the owner-set window (§17.1's second named alarm)",
    predicate: ({ values, thresholds }) =>
      values.extract_stage_age_local_box > thresholds.box_offline_max_seconds,
    dryRun: {
      condition: "a tenant's extract queue 6 hours deep against a 2-hour window (ADR-0005: one stuck job blocks that box)",
      values: { extract_stage_age_local_box: 21600, switch_state_age: 60 },
      thresholds: { box_offline_max_seconds: 7200 },
    },
  },
  {
    id: "verification_pass_rate_below_baseline",
    className: "model_chain",
    metricIds: ["verification_pass_rate", "eval_score_by_tier"],
    thresholdKind: "owner_set",
    thresholdKey: "verification_pass_floor",
    destination: "<owner-set>",
    definition: "a tier's verification pass rate falls below its eval baseline floor (§17.1's third named alarm)",
    predicate: ({ values, thresholds }) => values.verification_pass_rate < thresholds.verification_pass_floor,
    dryRun: {
      condition: "a tier verifying 0.62 against a 0.80 floor",
      values: { verification_pass_rate: 0.62, eval_score_by_tier: 0.84 },
      thresholds: { verification_pass_floor: 0.8 },
    },
  },
];

export const ruleIds = () => ALERT_RULES.map((r) => r.id);

const metricById = (id) => METRICS.find((x) => x.id === id);

/**
 * One metric's answer, with the three different kinds of "no answer" kept apart: the source
 * could not be reached, the table does not exist yet, or the query ran and nothing was read.
 * None of them is a zero.
 */
export function metricValue(metric, facts = {}) {
  const { tables, values = {}, error } = facts;
  if (error) {
    return { metricId: metric.id, status: "not_available", value: null, reason: `source unreachable: ${error}` };
  }
  if (!Array.isArray(tables)) {
    return { metricId: metric.id, status: "not_available", value: null, reason: "no source listing was supplied" };
  }
  if (!tables.includes(metric.source.table)) {
    return {
      metricId: metric.id,
      status: "not_available",
      value: null,
      reason: `no table ${metric.source.table} merged yet`,
      owedBy: metric.owedBy ?? metric.owningPacket,
    };
  }
  const value = values[metric.id];
  if (value === null || value === undefined) {
    return {
      metricId: metric.id,
      status: "not_available",
      value: null,
      reason: `the query for ${metric.id} was not read this run`,
    };
  }
  return { metricId: metric.id, status: "ok", value };
}

function evaluateRule(rule, { facts, thresholds }) {
  if (rule.thresholdKind === "owner_set" && (thresholds[rule.thresholdKey] === null || thresholds[rule.thresholdKey] === undefined)) {
    return {
      ruleId: rule.id,
      verdict: "threshold_unset",
      detail: `${rule.thresholdKey} has no owner-set value yet (§18.3, D-5); the rule was not evaluated and stays enabled for the next run`,
    };
  }
  const values = {};
  const missing = [];
  for (const id of rule.metricIds) {
    const metric = metricById(id);
    if (!metric) {
      return { ruleId: rule.id, verdict: "evaluation_error", detail: `unknown metric ${id}` };
    }
    const v = metricValue(metric, facts);
    if (v.status !== "ok") {
      // The reason must name who owes the table, so a not_available verdict is actionable and
      // not just a shrug.
      missing.push(`${id}: ${v.reason}${v.owedBy ? ` (owed by ${v.owedBy})` : ""}`);
      continue;
    }
    values[id] = v.value;
  }
  if (missing.length === rule.metricIds.length) {
    return { ruleId: rule.id, verdict: "not_available", detail: missing.join("; ") };
  }
  try {
    const fired = rule.predicate({ values, thresholds });
    return {
      ruleId: rule.id,
      verdict: fired ? "fired" : "ok",
      detail: fired ? rule.definition : `below rule: ${rule.definition}`,
    };
  } catch (err) {
    // A failed evaluation is a finding about the evaluator. The rule is not disabled, and the
    // other rules are still evaluated by the caller's loop.
    return { ruleId: rule.id, verdict: "evaluation_error", detail: err.message };
  }
}

export function evaluateAlerts({ rules = ALERT_RULES, facts = {}, thresholds = {} } = {}) {
  return rules.map((rule) => evaluateRule(rule, { facts, thresholds }));
}

/**
 * The dry-run every rule must survive: a synthetic condition per rule that must fire it. This
 * is what a reviewer can ask for when the staging alert job does not exist yet — the rules can
 * be shown to be capable of firing without pretending an alert was delivered anywhere.
 */
export function runDryRuns({ rules = ALERT_RULES } = {}) {
  return rules.map((rule) => {
    const tables = new Set(tablesForRule(rule));
    const facts = { tables: [...tables], values: rule.dryRun.values };
    const [verdict] = evaluateAlerts({
      rules: [rule],
      facts,
      thresholds: { ...rule.dryRun.thresholds },
    });
    return {
      ruleId: rule.id,
      condition: rule.dryRun.condition,
      verdict: verdict.verdict,
      detail: verdict.detail,
    };
  });
}

/**
 * The tables a dry run has to pretend are present: the ones its own metrics read. A dry run
 * supplies its synthetic values, so availability is asserted from the rule rather than from
 * what is merged on `main` — the point is to exercise the predicate, not the migration state.
 */
function tablesForRule(rule) {
  return rule.metricIds.map((id) => metricById(id)).filter(Boolean).map((mt) => mt.source.table);
}
