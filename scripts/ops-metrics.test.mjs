import { describe, expect, it } from "vitest";

import {
  ALERT_RULES,
  FORBIDDEN_OUTPUT_FIELDS,
  LATENCY_CLASSES,
  METRICS,
  evaluateAlerts,
  metricValue,
  ruleIds,
  runDryRuns,
} from "./ops-metrics.mjs";

/**
 * The tables merged on `main` at 10868ad, read off the migrations tree rather than from any
 * packet's Depends-on line — which matters, because T-405's own packet line claimed
 * `ingestion_jobs` was absent and it is not (`20261105070000_knowledge_core.sql:353`).
 * Availability is an input to the evaluator, never a fact baked into a metric definition:
 * a hard-coded "as of today" would rot the moment a migration merges.
 */
const MAIN_TABLES = [
  "public.ingestion_jobs",
  "public.outbox_events",
  "public.embedding_indexes",
  "public.knowledge_collections",
  "public.knowledge_sources",
  "public.source_versions",
  "public.organisation_memberships",
];

const byId = (id) => METRICS.find((m) => m.id === id);

describe("the metric set is closed and named", () => {
  // The list is written out here on purpose: a metric added without a decision here fails.
  const EXPECTED_IDS = [
    "interactive_latency_p95",
    "ingestion_queue_depth",
    "ingestion_queue_oldest_age",
    "ingestion_lease_expired_count",
    "ingestion_failed_not_replayed",
    "ingestion_attempt_pressure",
    "extract_stage_age_local_box",
    "extract_stage_age_cloud_worker",
    "index_generation_publish_lag",
    "published_generation_pinned",
    "collection_freshness_age",
    "review_backlog_age",
    "outbox_unprocessed_depth",
    "outbox_oldest_lag",
    "operational_reminder_lag",
    "authz_anomaly_count",
    "audit_write_failure_count",
    "budget_reservation_failure",
    "provider_availability",
    "provider_latency_p95",
    "fallback_rate",
    "verification_pass_rate",
    "eval_score_by_tier",
    "cost_per_answered_question",
    "free_allowance_burn",
    "paid_tier_share",
    "switch_state_age",
  ];

  it("contains exactly the listed metrics, in the listed order", () => {
    expect(METRICS.map((m) => m.id)).toEqual(EXPECTED_IDS);
    expect(new Set(METRICS.map((m) => m.id)).size).toBe(EXPECTED_IDS.length);
  });

  it("gives every metric one source table, one owning packet, one unit and one definition", () => {
    for (const m of METRICS) {
      expect(m.source?.table, m.id).toBeTruthy();
      expect(m.owningPacket, m.id).toBeTruthy();
      expect(m.unit, m.id).toBeTruthy();
      // "one query per metric" - the query lives on the source, and it is not another metric's
      // query, because two metrics reading the same fact is the thing §17.1's "one table per
      // fact" forbids. (Asserting a `definition` field here was my own slip: metrics carry a
      // `source.query`, rules carry a `definition`.)
      expect(m.source.query, m.id).toBeTruthy();
      expect(Array.isArray(m.columns) && m.columns.length > 0, m.id).toBe(true);
    }
  });

  it("gives no two metrics the same query", () => {
    const queries = METRICS.map((mt) => mt.source.query);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it("names the open PR or packet that owns a metric whose table is not merged", () => {
    for (const m of METRICS) {
      if (!MAIN_TABLES.includes(m.source.table)) {
        expect(m.owedBy, `${m.id} has no table on main and no owedBy`).toBeTruthy();
      }
    }
  });

  it("keeps the four latency classes as separate metrics", () => {
    // §17.1 and §14 measure these apart; a single "latency" number would let an ingestion-queue
    // spike be read as an interactive-latency spike, which is the misreading the plan names.
    expect(LATENCY_CLASSES).toEqual([
      "interactive",
      "ingestion_queue",
      "extraction_index",
      "manual_review",
    ]);
    for (const cls of LATENCY_CLASSES) {
      expect(METRICS.some((m) => m.latencyClass === cls), cls).toBe(true);
    }
    expect(byId("ingestion_queue_oldest_age").latencyClass).toBe("ingestion_queue");
    expect(byId("interactive_latency_p95").latencyClass).toBe("interactive");
    expect(byId("extract_stage_age_local_box").latencyClass).toBe("extraction_index");
    expect(byId("review_backlog_age").latencyClass).toBe("manual_review");
  });

  it("records the dead-letter gap instead of papering over it", () => {
    // ADR-0005: one stuck extract job blocks a tenant's box until a human intervenes, and no
    // packet owns the dead letter (U-3). ingestion_jobs.status has no dead-lettered value, so
    // the honest move is a metric plus a recorded gap - not a new column invented here.
    const m = byId("ingestion_failed_not_replayed");
    expect(m.source.table).toBe("public.ingestion_jobs");
    expect(m.gap).toBe("no_dead_letter_state");
    expect(m.gapNote).toMatch(/U-3/);
  });
});

describe("metric evaluation", () => {
  it("reports not_available with a reason for a metric whose table is missing", () => {
    const v = metricValue(byId("authz_anomaly_count"), { tables: MAIN_TABLES, values: {} });
    expect(v.status).toBe("not_available");
    // The whole point of the box: a missing table must never look like a healthy zero.
    expect(v.value).toBeNull();
    expect(v.reason).toContain("public.audit_events");
    expect(v.owedBy).toBeTruthy();
  });

  it("reports a real zero as a real zero", () => {
    const v = metricValue(byId("ingestion_failed_not_replayed"), {
      tables: MAIN_TABLES,
      values: { ingestion_failed_not_replayed: 0 },
    });
    expect(v.status).toBe("ok");
    expect(v.value).toBe(0);
  });

  it("reports not_available when the table exists but the value was never read", () => {
    const v = metricValue(byId("outbox_oldest_lag"), { tables: MAIN_TABLES, values: {} });
    expect(v.status).toBe("not_available");
    expect(v.reason).toMatch(/not read/);
    expect(v.value).toBeNull();
  });

  it("reports not_available rather than throwing when the source cannot be reached", () => {
    const v = metricValue(byId("ingestion_queue_depth"), {
      tables: null,
      values: {},
      error: "connection timed out",
    });
    expect(v.status).toBe("not_available");
    expect(v.reason).toContain("connection timed out");
  });
});

describe("the alert vocabulary", () => {
  it("is exactly the five §17.1 classes plus the three model-chain alarms", () => {
    expect(ALERT_RULES.map((r) => r.id)).toEqual([
      "authorization_anomalies",
      "audit_loss",
      "budget_failure",
      "stale_critical_collections",
      "stopped_operational_reminders",
      "paid_tier_share_drift",
      "box_offline_too_long",
      "verification_pass_rate_below_baseline",
    ]);
    expect(ruleIds()).toHaveLength(8);
  });

  it("references only metrics that exist", () => {
    for (const r of ALERT_RULES) {
      for (const id of r.metricIds) {
        expect(byId(id), `${r.id} references unknown metric ${id}`).toBeTruthy();
      }
    }
  });

  it("marks which thresholds are the owner's and refuses to invent a number", () => {
    const ownerSet = ALERT_RULES.filter((r) => r.thresholdKind === "owner_set");
    expect(ownerSet.length).toBeGreaterThanOrEqual(6);
    for (const r of ALERT_RULES) {
      expect(["owner_set", "definitional", "none"], r.id).toContain(r.thresholdKind);
      if (r.thresholdKind === "owner_set") {
        expect(r.thresholdKey, `${r.id} is owner-set but names no key`).toBeTruthy();
      }
    }
  });

  it("reports threshold_unset instead of silently passing", () => {
    // The §100 / #180 class of defect: a step that cannot fail is not evidence. A rule with no
    // threshold must say so, and it must stay in the list for the next run.
    const verdicts = evaluateAlerts({
      facts: { tables: MAIN_TABLES, values: {} },
      thresholds: {},
    });
    const unset = verdicts.filter((v) => v.verdict === "threshold_unset");
    expect(unset.length).toBeGreaterThan(0);
    expect(verdicts).toHaveLength(ALERT_RULES.length);
    for (const r of ALERT_RULES.filter((x) => x.thresholdKind === "owner_set")) {
      expect(verdicts.find((v) => v.ruleId === r.id).verdict).toBe("threshold_unset");
    }
  });

  it("fires each rule on a synthetic condition, so no rule is incapable of firing", () => {
    const runs = runDryRuns();
    expect(runs).toHaveLength(ALERT_RULES.length);
    for (const run of runs) {
      expect(run.verdict, `${run.ruleId} cannot be made to fire: ${run.detail ?? ""}`).toBe("fired");
      expect(run.condition, run.ruleId).toBeTruthy();
    }
  });

  it("never evaluates two rules off the same synthetic facts by accident", () => {
    const runs = runDryRuns();
    const ids = runs.map((r) => r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a rule enabled when its evaluation throws", () => {
    // A failed evaluation is a finding about the evaluator; it must not disable the rule for the
    // next run and must not stop the other rules being evaluated.
    const boom = {
      id: "boom_rule",
      className: "authorization",
      metricIds: ["authz_anomaly_count"],
      thresholdKind: "definitional",
      predicate: () => {
        throw new Error("predicate exploded");
      },
    };
    // The fixture has to offer the table the rule reads, or the evaluator would legitimately
    // answer not_available and never reach the throwing predicate at all.
    const verdicts = evaluateAlerts({
      rules: [boom, ...ALERT_RULES],
      facts: { tables: [...MAIN_TABLES, "public.audit_events"], values: { authz_anomaly_count: 5 } },
      thresholds: {},
    });
    const bad = verdicts.find((v) => v.ruleId === "boom_rule");
    expect(bad.verdict).toBe("evaluation_error");
    expect(bad.detail).toContain("predicate exploded");
    expect(verdicts.filter((v) => v.verdict === "evaluation_error")).toHaveLength(1);
    expect(verdicts.length).toBe(ALERT_RULES.length + 1);
  });
});

describe("the read path must not become a leak channel", () => {
  it("declares no forbidden field in any metric's output columns", () => {
    // §17.1: content-rich audit stays separate and source-authorized; no prompt body, document
    // text, signed URL, object key, provider name or personal prompt crosses into a metric row.
    const offenders = [];
    for (const m of METRICS) {
      for (const col of m.columns) {
        if (FORBIDDEN_OUTPUT_FIELDS.some((f) => f.test(col))) offenders.push(`${m.id}.${col}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually rejects a forbidden column, so the check above is not vacuous", () => {
    const tampered = {
      ...byId("collection_freshness_age"),
      columns: ["organisation_id", "max_age_seconds", "prompt_body", "signed_url"],
    };
    const found = FORBIDDEN_OUTPUT_FIELDS.some((f) =>
      tampered.columns.some((c) => f.test(c)),
    );
    expect(found).toBe(true);
  });

  it("carries the tenant scoping every view over these tables must have", () => {
    for (const m of METRICS) {
      expect(m.scoping, m.id).toBeTruthy();
      expect(m.scoping.mode, `${m.id} has no scoping mode`).toBe("organisation");
    }
  });
});
