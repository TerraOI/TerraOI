import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Parse `create table public.foo (` … `);` column names from merged migrations. */
function columnsFromMergedMigrations() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
  const files = readdirSync(root).filter((f) => f.endsWith(".sql")).sort();
  const byTable = {};
  for (const file of files) {
    const sql = readFileSync(join(root, file), "utf8");
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(public\.\w+)\s*\(([\s\S]*?)\n\);/gi;
    let match;
    while ((match = re.exec(sql)) !== null) {
      const table = match[1].toLowerCase();
      const body = match[2];
      const cols = [];
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("--")) continue;
        if (/^(constraint|unique|primary|check|foreign)\b/i.test(trimmed)) continue;
        const col = trimmed.match(/^([a-z_][a-z0-9_]*)\s+/i);
        if (col) cols.push(col[1].toLowerCase());
      }
      byTable[table] = cols;
    }
  }
  return byTable;
}

describe("the metric set is closed and named", () => {
  // The list is written out here on purpose: a metric added without a decision here fails.
  const EXPECTED_IDS = [
    "interactive_latency_p95",
    "ingestion_queue_depth",
    "ingestion_queue_oldest_age",
    "ingestion_lease_expired_count",
    "ingestion_failed_not_replayed",
    "ingestion_failed_other",
    "ingestion_attempt_pressure",
    "extract_stage_age_local_box",
    "extract_stage_age_cloud_worker",
    "index_generation_publish_lag",
    "published_generation_pinned",
    "collection_freshness_age",
    "quarantined_sources_count",
    "review_backlog_age",
    "outbox_unprocessed_depth",
    "outbox_oldest_lag",
    "operational_reminder_lag",
    "authz_anomaly_count",
    "audit_write_failure_count",
    "budget_reservation_failure",
    "provider_availability",
    "local_box_uptime",
    "provider_latency_p95",
    "fallback_rate",
    "verification_pass_rate",
    "eval_score_by_tier",
    "cost_per_answered_question",
    "free_allowance_burn",
    "paid_tier_share",
    "stale_saved_answers",
    "per_tenant_fairness",
    "expert_usefulness",
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
      expect(m.source.query, m.id).toBeTruthy();
      expect(Array.isArray(m.columns) && m.columns.length > 0, m.id).toBe(true);
      expect(Array.isArray(m.sourceColumns) && m.sourceColumns.length > 0, m.id).toBe(true);
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

  it("keeps sourceColumns honest against merged migration DDL", () => {
    const ddl = columnsFromMergedMigrations();
    for (const metric of METRICS) {
      const tableCols = ddl[metric.source.table];
      if (!tableCols) {
        expect(metric.owedBy, `${metric.id} reads ${metric.source.table} with no DDL and no owedBy`).toBeTruthy();
        continue;
      }
      const missing = metric.sourceColumns.filter((c) => !tableCols.includes(c));
      if (missing.length > 0) {
        expect(
          metric.owedBy,
          `${metric.id} declares sourceColumns missing from DDL (${missing.join(", ")}) but has no owedBy`,
        ).toBeTruthy();
      } else if (!metric.owedBy) {
        for (const col of metric.sourceColumns) {
          expect(tableCols, `${metric.id}.${col}`).toContain(col);
        }
      }
    }
  });

  it("keeps the four latency classes as separate metrics", () => {
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

  it("defines dead-letter as failed + retries_exhausted, with other failures counted apart", () => {
    const dead = byId("ingestion_failed_not_replayed");
    expect(dead.source.table).toBe("public.ingestion_jobs");
    expect(dead.source.query).toMatch(/status = 'failed'/);
    expect(dead.source.query).toMatch(/last_error = 'retries_exhausted'/);
    expect(dead.gap).toBeUndefined();
    expect(dead.gapNote).toBeUndefined();
    expect(dead.owningPacket).toMatch(/ADR-0005 §10b|#99|T-405/);
    const other = byId("ingestion_failed_other");
    expect(other.source.query).toMatch(/last_error is distinct from 'retries_exhausted'/);
  });

  it("filters extract-stage age to in-flight statuses and uses updated_at", () => {
    for (const id of ["extract_stage_age_local_box", "extract_stage_age_cloud_worker"]) {
      const q = byId(id).source.query;
      expect(q).toMatch(/status in \('queued','leased','running'\)/);
      expect(q).toMatch(/updated_at/);
    }
  });

  it("pins published generations to status=active with no published_at", () => {
    expect(byId("published_generation_pinned").source.query).toMatch(/status = 'active'/);
    expect(byId("published_generation_pinned").source.query).not.toMatch(/published_at/);
    expect(byId("index_generation_publish_lag").source.query).toMatch(/status = 'building'/);
    expect(byId("index_generation_publish_lag").source.query).not.toMatch(/published_at/);
    expect(byId("collection_freshness_age").owedBy).toMatch(/T-213/);
    expect(byId("collection_freshness_age").sourceColumns).toContain("criticality");
  });
});

describe("metric evaluation", () => {
  it("reports not_available with a reason for a metric whose table is missing", () => {
    const v = metricValue(byId("authz_anomaly_count"), { tables: MAIN_TABLES, values: {} });
    expect(v.status).toBe("not_available");
    expect(v.value).toBeNull();
    expect(v.reason).toContain("public.audit_events");
    expect(v.owedBy).toBeTruthy();
  });

  it("reports a real zero as a real zero", () => {
    const v = metricValue(byId("ingestion_failed_not_replayed"), {
      tables: MAIN_TABLES,
      values: { ingestion_failed_not_replayed: 0 },
      columnsByTable: {
        "public.ingestion_jobs": ["organisation_id", "stage", "status", "last_error", "updated_at"],
      },
    });
    expect(v.status).toBe("ok");
    expect(v.value).toBe(0);
  });

  it("reports not_available when the table exists but the value was never read", () => {
    const v = metricValue(byId("outbox_oldest_lag"), {
      tables: MAIN_TABLES,
      values: {},
      columnsByTable: {
        "public.outbox_events": ["organisation_id", "processed_at", "created_at"],
      },
    });
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

  it("does not treat criticality-backed freshness as ok while criticality is owed", () => {
    const v = metricValue(byId("collection_freshness_age"), {
      tables: MAIN_TABLES,
      values: { collection_freshness_age: 10 },
    });
    expect(v.status).toBe("not_available");
    expect(v.owedBy).toMatch(/T-213/);
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

  it("reads both local_box_uptime and extract queue age for box_offline_too_long", () => {
    const rule = ALERT_RULES.find((r) => r.id === "box_offline_too_long");
    expect(rule.metricIds).toEqual(["local_box_uptime", "extract_stage_age_local_box"]);
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

  it("returns one dry-run row per rule id with no duplicates", () => {
    const runs = runDryRuns();
    const ids = runs.map((r) => r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps evaluating sibling rules when one predicate throws", () => {
    const boom = {
      id: "boom_rule",
      className: "authorization",
      metricIds: ["authz_anomaly_count"],
      thresholdKind: "definitional",
      predicate: () => {
        throw new Error("predicate exploded");
      },
    };
    const verdicts = evaluateAlerts({
      rules: [boom, ...ALERT_RULES],
      facts: {
        tables: [...MAIN_TABLES, "public.audit_events"],
        values: { authz_anomaly_count: 5 },
        columnsByTable: { "public.audit_events": ["organisation_id", "outcome"] },
      },
      thresholds: {},
    });
    const bad = verdicts.find((v) => v.ruleId === "boom_rule");
    expect(bad.verdict).toBe("evaluation_error");
    expect(bad.detail).toContain("predicate exploded");
    expect(verdicts.filter((v) => v.verdict === "evaluation_error")).toHaveLength(1);
    expect(verdicts.length).toBe(ALERT_RULES.length + 1);
  });

  it("reports not_available for stopped_operational_reminders when a metric input is missing", () => {
    const [verdict] = evaluateAlerts({
      rules: ALERT_RULES.filter((r) => r.id === "stopped_operational_reminders"),
      facts: {
        tables: ["public.outbox_events"],
        values: { outbox_oldest_lag: 90000 },
        columnsByTable: {
          "public.outbox_events": ["organisation_id", "processed_at", "created_at"],
        },
      },
      thresholds: { reminder_overdue_max_seconds: 1800 },
    });
    expect(verdict.verdict).toBe("not_available");
    expect(verdict.detail).toMatch(/operational_reminder_lag/);
    expect(verdict.detail).toMatch(/scheduled_reminders|owed by/i);
  });

  it("reports not_available for verification_pass_rate_below_baseline when a metric input is missing", () => {
    const [verdict] = evaluateAlerts({
      rules: ALERT_RULES.filter((r) => r.id === "verification_pass_rate_below_baseline"),
      facts: {
        tables: ["public.audit_runs"],
        values: { verification_pass_rate: 0.5 },
        columnsByTable: {
          "public.audit_runs": ["organisation_id", "tier", "verifier_outcome"],
        },
      },
      thresholds: { verification_pass_floor: 0.8 },
    });
    expect(verdict.verdict).toBe("not_available");
    expect(verdict.detail).toMatch(/eval_score_by_tier/);
  });
});

describe("the read path must not become a leak channel", () => {
  it("declares no forbidden field in any metric's output columns", () => {
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
